// OZ Browser — Dropbox API client (Bloque D-1.2).
//
// Wrapper sobre el SDK oficial `dropbox@10.34.0` integrado con nuestro
// `oauth-helper.js` (PKCE + Keychain). Centraliza upload/download/list/delete
// + auto-refresh on 401.
//
// Doc: docs/modules/dropbox-client.md
// ADR: docs/architecture/0025-cloud-backup.md (pendiente — D-1.8)
//
// Por qué no usar el OAuth nativo del SDK:
//   - El SDK trae `DropboxAuth` que reimplementa PKCE + token mgmt, pero
//     no se integra con nuestro `oauth-helper.js` ni con Keychain. Forzar
//     dos implementaciones de PKCE duplica superficie de bugs.
//   - Pasamos `accessToken` puro al constructor de Dropbox y manejamos el
//     refresh nosotros (con el refresh_token que oauth-helper guardó en
//     Keychain). Misma seguridad, una sola fuente de verdad.
//
// Endpoints + scopes:
//   - Auth: https://www.dropbox.com/oauth2/authorize
//   - Token: https://api.dropboxapi.com/oauth2/token
//   - Scopes: files.content.write files.content.read account_info.read
//   - token_access_type=offline (necesario para refresh_token)
//
// App folder root: /Apps/OZ Browser/<device-folder>/
//   - Dropbox app es Scoped App tipo "App Folder" → todo path relativo a
//     `/Apps/OZ Browser/` desde la perspectiva de Dropbox API. Cada device
//     vive en su sub-carpeta para evitar colisiones (ADR 0025).
//
// 401 retry: si una operación falla con 401 (token expired/revoked), llamamos
// `refreshAccessToken` (vía oauth-helper) y reintentamos UNA vez. Si el
// refresh también falla → propagamos como "needs reauth".

const log = require('./logger')
const oauthHelper = require('./oauth-helper')

const DROPBOX_PROVIDER = 'dropbox'
const DROPBOX_AUTH_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize'
const DROPBOX_TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token'
const DROPBOX_SCOPES = ['files.content.write', 'files.content.read', 'account_info.read']
const DROPBOX_REDIRECT_URI = 'oz://auth/dropbox/callback'
// In Dropbox API terms, App Folder apps see everything relative to their
// app folder, so the SDK paths are like '/joses-macbook-pro-abc123/snapshots/'
// (NOT '/Apps/OZ Browser/...' — that's the user-visible Dropbox path).
const APP_ROOT_PATH = ''

// Upload cutoff for simple vs chunked-session upload. Dropbox API limit is
// 150 MB for files.upload; above that we'd need uploadSessionStart. Our
// .ozbackup files are typically <50 MB → simple upload is fine for D-1.
// Chunked support is queued for D-2 polish.
const SIMPLE_UPLOAD_MAX_BYTES = 140 * 1024 * 1024

class DropboxError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'DropboxError'
    this.code = code || 'DROPBOX_ERROR'
    this.status = status || null
  }
}

/**
 * Resolve the Dropbox SDK lazily so tests can inject a fake. We don't require
 * 'dropbox' at module load because some test environments don't have it (and
 * because keeping the require lazy speeds up the cold-start log path).
 */
let _dropboxSdkOverride = null
function injectDropboxSdk(fake) {
  _dropboxSdkOverride = fake
}
function _resolveDropboxSdk() {
  if (_dropboxSdkOverride) return _dropboxSdkOverride
  return require('dropbox')
}

/**
 * Build the SDK Dropbox client with the access token + fetch impl.
 * Returns a fresh instance each time — the SDK is stateless beyond the
 * token, so we cheap-rebuild on refresh.
 */
function _buildSdkClient(accessToken, fetchImpl) {
  const { Dropbox } = _resolveDropboxSdk()
  return new Dropbox({
    accessToken,
    fetch: fetchImpl || globalThis.fetch,
  })
}

/**
 * Factory. Holds in-memory token cache so most operations skip the Keychain
 * round-trip. On 401 we refresh + retry.
 *
 * @param {object} opts
 * @param {string} opts.clientId  Dropbox App Key (process.env.OZ_DROPBOX_APP_KEY)
 * @param {Function} [opts.fetchImpl]  Override fetch (tests / non-Node envs)
 * @param {object}   [opts.oauth]      Override oauth-helper module (tests)
 */
function createDropboxClient(opts = {}) {
  const clientId = opts.clientId
  if (!clientId) throw new DropboxError('clientId required', 'BAD_ARG')
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const oauth = opts.oauth || oauthHelper

  // In-memory cache. Avoid Keychain round-trip on every call.
  let cachedTokens = null

  function _loadTokens() {
    if (cachedTokens) return cachedTokens
    cachedTokens = oauth.loadTokens(DROPBOX_PROVIDER)
    return cachedTokens
  }

  function _setTokens(tokens) {
    cachedTokens = tokens
    oauth.saveTokens(DROPBOX_PROVIDER, tokens)
  }

  function _clearCache() {
    cachedTokens = null
  }

  // -------- OAuth flow --------

  /**
   * Start an OAuth flow. Returns { authUrl, codeVerifier, state }. Caller
   * persists (codeVerifier, state) in-process + calls shell.openExternal(authUrl).
   * The protocol handler dispatcher routes the redirect back to completeAuth.
   */
  function startAuth() {
    return oauth.startOAuthFlow({
      provider: DROPBOX_PROVIDER,
      authEndpoint: DROPBOX_AUTH_ENDPOINT,
      clientId,
      redirectUri: DROPBOX_REDIRECT_URI,
      scopes: DROPBOX_SCOPES,
      // Dropbox-specific: offline → refresh_token in response
      extraParams: { token_access_type: 'offline' },
    })
  }

  /**
   * Exchange the redirect's `code` for tokens + persist to Keychain.
   * Throws if state doesn't match (CSRF defense).
   */
  async function completeAuth({ code, state, expectedCodeVerifier, expectedState }) {
    if (!code) throw new DropboxError('code required', 'BAD_ARG')
    if (!expectedCodeVerifier)
      throw new DropboxError('expectedCodeVerifier required', 'BAD_ARG')
    if (expectedState && state !== expectedState) {
      throw new DropboxError('state mismatch — CSRF defense', 'STATE_MISMATCH')
    }
    const tokens = await oauth.exchangeCodeForToken({
      tokenEndpoint: DROPBOX_TOKEN_ENDPOINT,
      code,
      codeVerifier: expectedCodeVerifier,
      clientId,
      redirectUri: DROPBOX_REDIRECT_URI,
      fetchImpl,
    })
    _setTokens(tokens)
    log.info('dropbox-client', 'authenticated', {
      hasRefresh: !!tokens.refreshToken,
      scopes: tokens.scopes,
    })
    return { ok: true }
  }

  function clearAuth() {
    oauth.clearTokens(DROPBOX_PROVIDER)
    _clearCache()
    log.info('dropbox-client', 'auth cleared')
  }

  function isAuthenticated() {
    const t = _loadTokens()
    return !!(t && t.accessToken)
  }

  // -------- Token refresh wrapper --------

  /**
   * Run an operation that needs an access token. If the call fails with
   * 401, refresh + retry ONCE. If refresh also fails → propagate as
   * 'NEEDS_REAUTH'.
   *
   * The op receives a fresh Dropbox SDK client. Avoid holding the client
   * outside `op` — its token may be stale after a refresh.
   */
  async function _withAuth(op) {
    const tokens = _loadTokens()
    if (!tokens || !tokens.accessToken) {
      throw new DropboxError('not authenticated', 'NEEDS_REAUTH', 401)
    }
    try {
      const sdk = _buildSdkClient(tokens.accessToken, fetchImpl)
      return await op(sdk)
    } catch (err) {
      const status = _statusFromError(err)
      if (status !== 401) throw _wrap(err)
      // Token expired/revoked — try refresh.
      if (!tokens.refreshToken) {
        clearAuth()
        throw new DropboxError(
          'access token rejected, no refresh available',
          'NEEDS_REAUTH',
          401,
        )
      }
      log.info('dropbox-client', '401 — attempting token refresh')
      let refreshed
      try {
        refreshed = await oauth.refreshAccessToken({
          tokenEndpoint: DROPBOX_TOKEN_ENDPOINT,
          refreshToken: tokens.refreshToken,
          clientId,
          fetchImpl,
        })
      } catch (refreshErr) {
        clearAuth()
        throw new DropboxError(
          `token refresh failed: ${refreshErr.message}`,
          'NEEDS_REAUTH',
          401,
        )
      }
      _setTokens(refreshed)
      const sdk2 = _buildSdkClient(refreshed.accessToken, fetchImpl)
      return await op(sdk2).catch((err2) => {
        throw _wrap(err2)
      })
    }
  }

  // -------- Operations --------

  async function getAccountInfo() {
    return _withAuth(async (sdk) => {
      const resp = await sdk.usersGetCurrentAccount()
      const r = resp.result || resp
      return {
        accountId: r.account_id,
        email: r.email,
        name: r.name ? r.name.display_name : null,
        country: r.country || null,
      }
    })
  }

  /**
   * Create a folder if it doesn't already exist. Idempotent — silently
   * succeeds if folder exists.
   */
  async function ensureFolder(folderPath) {
    if (!folderPath || folderPath === '/') return { ok: true }
    return _withAuth(async (sdk) => {
      try {
        await sdk.filesCreateFolderV2({
          path: _normalizePath(folderPath),
          autorename: false,
        })
      } catch (err) {
        // Path already exists is fine — Dropbox returns
        // path/conflict/folder in the error_summary.
        const summary = _errSummary(err)
        if (summary && summary.includes('path/conflict/folder')) {
          return { ok: true, existed: true }
        }
        throw _wrap(err)
      }
      return { ok: true, existed: false }
    })
  }

  async function upload({ path: dbxPath, contents, mode = 'overwrite' }) {
    if (!dbxPath) throw new DropboxError('path required', 'BAD_ARG')
    if (!Buffer.isBuffer(contents))
      throw new DropboxError('contents must be Buffer', 'BAD_ARG')
    if (contents.length > SIMPLE_UPLOAD_MAX_BYTES) {
      // D-2 polish will add filesUploadSession* path. .ozbackup files are
      // far below this threshold in v1.
      throw new DropboxError(
        `upload too large (${contents.length} bytes) — chunked upload not impl yet`,
        'TOO_LARGE',
      )
    }
    return _withAuth(async (sdk) => {
      const resp = await sdk.filesUpload({
        path: _normalizePath(dbxPath),
        contents,
        mode,
        autorename: false,
        mute: true,
      })
      const r = resp.result || resp
      return {
        path: r.path_display || r.path_lower,
        size: r.size,
        rev: r.rev,
        contentHash: r.content_hash,
      }
    })
  }

  async function download(dbxPath) {
    return _withAuth(async (sdk) => {
      const resp = await sdk.filesDownload({ path: _normalizePath(dbxPath) })
      const r = resp.result || resp
      // SDK returns `fileBinary` (Node) or `fileBlob` (browser). We target Node.
      let buf = r.fileBinary
      if (!buf && r.fileBlob && typeof r.fileBlob.arrayBuffer === 'function') {
        buf = Buffer.from(await r.fileBlob.arrayBuffer())
      }
      if (!Buffer.isBuffer(buf)) {
        throw new DropboxError('download did not return Buffer', 'BAD_RESPONSE')
      }
      return {
        contents: buf,
        path: r.path_display || r.path_lower,
        size: r.size,
        rev: r.rev,
        contentHash: r.content_hash,
      }
    })
  }

  /**
   * List folder contents (non-recursive by default). Returns array of
   * { name, pathLower, size, serverModified, isFolder }.
   * If folder doesn't exist, returns [] (not an error).
   */
  async function listFolder(folderPath, { recursive = false } = {}) {
    return _withAuth(async (sdk) => {
      try {
        const resp = await sdk.filesListFolder({
          path: _normalizePath(folderPath),
          recursive,
        })
        const r = resp.result || resp
        return (r.entries || []).map((e) => ({
          name: e.name,
          pathLower: e.path_lower,
          pathDisplay: e.path_display,
          size: e.size || 0,
          serverModified: e.server_modified || null,
          isFolder: e['.tag'] === 'folder',
        }))
      } catch (err) {
        const summary = _errSummary(err)
        if (summary && summary.includes('path/not_found')) return []
        throw _wrap(err)
      }
    })
  }

  async function deletePath(dbxPath) {
    return _withAuth(async (sdk) => {
      await sdk.filesDeleteV2({ path: _normalizePath(dbxPath) })
      return { ok: true }
    })
  }

  return {
    // OAuth
    startAuth,
    completeAuth,
    clearAuth,
    isAuthenticated,
    // Operations
    getAccountInfo,
    ensureFolder,
    upload,
    download,
    listFolder,
    delete: deletePath,
    // Introspection (tests)
    _loadTokens,
    _setTokens,
  }
}

// -------- helpers --------

/**
 * Dropbox API expects paths starting with `/` (or empty for root). Normalize
 * away duplicate slashes + ensure leading slash.
 */
function _normalizePath(p) {
  if (!p || p === '/' || p === '') return ''
  let s = String(p)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  // Trailing slash strip (Dropbox doesn't like /foo/ for files).
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function _statusFromError(err) {
  if (!err) return null
  if (typeof err.status === 'number') return err.status
  if (err.response && typeof err.response.status === 'number') return err.response.status
  return null
}

function _errSummary(err) {
  if (!err) return ''
  if (err.error && err.error.error_summary) return err.error.error_summary
  if (err.error_summary) return err.error_summary
  return err.message || ''
}

function _wrap(err) {
  if (err instanceof DropboxError) return err
  const status = _statusFromError(err)
  const summary = _errSummary(err)
  const msg = summary || err.message || 'Dropbox API error'
  return new DropboxError(msg, 'API_ERROR', status)
}

module.exports = {
  createDropboxClient,
  DropboxError,
  DROPBOX_PROVIDER,
  DROPBOX_AUTH_ENDPOINT,
  DROPBOX_TOKEN_ENDPOINT,
  DROPBOX_SCOPES,
  DROPBOX_REDIRECT_URI,
  APP_ROOT_PATH,
  SIMPLE_UPLOAD_MAX_BYTES,
  injectDropboxSdk,
  // Internal exports for tests
  _normalizePath,
  _statusFromError,
  _errSummary,
  _wrap,
}
