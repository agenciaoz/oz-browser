// OZ Browser — OAuth 2.0 PKCE helper (Bloque B-3).
//
// Qué hace: factoriza el flow OAuth Authorization Code + PKCE para cualquier
// provider externo (Dropbox, Supabase, futuros). Token storage en macOS
// Keychain via `@napi-rs/keyring`.
//
// Doc: docs/modules/oauth-helper.md
// ADR: docs/architecture/0023b-protocol-handler.md (pending)
//
// Flow:
//   1. startOAuthFlow({ provider, authEndpoint, clientId, redirectUri, scopes })
//      - Genera code_verifier (random 32 bytes → base64url, ~43 chars)
//      - Deriva code_challenge = base64url(SHA256(code_verifier))
//      - Genera state (random 16 bytes → hex)
//      - Construye authUrl con params
//      - Returns: { authUrl, codeVerifier, state }
//   2. Caller llama shell.openExternal(authUrl) → user authentica en browser
//      → provider redirige a redirectUri (oz://auth/<provider>/callback?code=...&state=...)
//   3. Protocol handler captura el redirect + invoca dispatcher
//   4. exchangeCodeForToken({ provider, tokenEndpoint, code, codeVerifier, ... })
//      - POST al token endpoint con el code + verifier
//      - Returns { accessToken, refreshToken, expiresAt }
//   5. saveTokens(provider, tokens) — guarda en Keychain
//   6. refreshAccessToken(...) cuando el access token expira
//
// Token storage: macOS Keychain via @napi-rs/keyring. Service name pattern:
//   service: 'oz-browser-oauth'
//   account: '<provider>'  (e.g. 'dropbox', 'supabase')
// Stored value es JSON { accessToken, refreshToken, expiresAt, scopes }.
//
// Security:
//   - PKCE elimina la necesidad del client_secret en el .app
//   - state param previene CSRF
//   - Tokens en Keychain — encrypted at rest por macOS, accesibles solo a OZ
//   - Refresh token nunca toca disco fuera del Keychain

const crypto = require('crypto')
const log = require('./logger')

const KEYCHAIN_SERVICE = 'oz-browser-oauth'

// ============================================================================
// PKCE primitives
// ============================================================================

/**
 * base64url encoding per RFC 7636 §4.1 (no padding, URL-safe alphabet).
 */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a PKCE challenge pair (S256 method). Returns:
 *   { codeVerifier: string (43+ chars), codeChallenge: string }
 * The verifier is kept locally; the challenge is sent to the auth endpoint.
 */
function pkceChallenge() {
  // RFC 7636 §4.1: code_verifier MUST be 43-128 chars URL-safe. We use 32
  // random bytes → ~43 chars base64url, comfortably above min.
  const codeVerifier = base64url(crypto.randomBytes(32))
  // S256 = base64url(SHA256(verifier))
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  )
  return { codeVerifier, codeChallenge }
}

/**
 * Generate a random `state` param for CSRF protection (16 bytes → 32 hex chars).
 */
function randomState() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Build the authorization URL for the OAuth provider. The caller passes the
 * provider-specific endpoint + clientId + scopes; we attach the standard
 * params (response_type=code, redirect_uri, code_challenge, state, etc).
 *
 * Returns the full URL string.
 */
function buildAuthUrl({
  authEndpoint,
  clientId,
  redirectUri,
  scopes,
  codeChallenge,
  state,
  extraParams = {},
}) {
  if (!authEndpoint) throw new Error('buildAuthUrl: authEndpoint required')
  if (!clientId) throw new Error('buildAuthUrl: clientId required')
  if (!redirectUri) throw new Error('buildAuthUrl: redirectUri required')
  if (!codeChallenge) throw new Error('buildAuthUrl: codeChallenge required')

  const url = new URL(authEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (state) url.searchParams.set('state', state)
  if (Array.isArray(scopes) && scopes.length > 0) {
    url.searchParams.set('scope', scopes.join(' '))
  } else if (typeof scopes === 'string' && scopes) {
    url.searchParams.set('scope', scopes)
  }
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, String(v))
  }
  return url.toString()
}

// ============================================================================
// Token endpoint communication
// ============================================================================

/**
 * Exchange the authorization code for tokens via POST to the token endpoint.
 *
 * Returns { accessToken, refreshToken, expiresAt, tokenType, scopes, raw }
 * where `raw` is the full provider response (for diagnostic logging).
 * Throws on HTTP errors or malformed responses.
 */
async function exchangeCodeForToken({
  tokenEndpoint,
  code,
  codeVerifier,
  clientId,
  redirectUri,
  fetchImpl,
}) {
  if (!tokenEndpoint) throw new Error('exchangeCodeForToken: tokenEndpoint required')
  if (!code) throw new Error('exchangeCodeForToken: code required')
  if (!codeVerifier) throw new Error('exchangeCodeForToken: codeVerifier required')
  if (!clientId) throw new Error('exchangeCodeForToken: clientId required')
  if (!redirectUri) throw new Error('exchangeCodeForToken: redirectUri required')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  })
  const fx = fetchImpl || globalThis.fetch
  if (!fx) throw new Error('exchangeCodeForToken: no fetch impl available')

  const resp = await fx(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const err = new Error(
      `exchangeCodeForToken: HTTP ${resp.status} from token endpoint: ${text.slice(0, 200)}`,
    )
    err.status = resp.status
    err.body = text
    throw err
  }
  const json = await resp.json()
  return _normalizeTokenResponse(json)
}

/**
 * Refresh an expired access token using a stored refresh_token.
 */
async function refreshAccessToken({ tokenEndpoint, refreshToken, clientId, fetchImpl }) {
  if (!tokenEndpoint) throw new Error('refreshAccessToken: tokenEndpoint required')
  if (!refreshToken) throw new Error('refreshAccessToken: refreshToken required')
  if (!clientId) throw new Error('refreshAccessToken: clientId required')

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  const fx = fetchImpl || globalThis.fetch
  if (!fx) throw new Error('refreshAccessToken: no fetch impl available')

  const resp = await fx(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const err = new Error(
      `refreshAccessToken: HTTP ${resp.status}: ${text.slice(0, 200)}`,
    )
    err.status = resp.status
    err.body = text
    throw err
  }
  const json = await resp.json()
  const normalized = _normalizeTokenResponse(json)
  // Some providers don't return a new refresh token on refresh — keep the old.
  if (!normalized.refreshToken) normalized.refreshToken = refreshToken
  return normalized
}

function _normalizeTokenResponse(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('OAuth token response is not a JSON object')
  }
  const accessToken = json.access_token
  if (!accessToken) {
    throw new Error('OAuth token response missing access_token')
  }
  const expiresInSec = Number(json.expires_in)
  const expiresAt =
    Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Date.now() + expiresInSec * 1000
      : null
  return {
    accessToken,
    refreshToken: json.refresh_token || null,
    expiresAt,
    tokenType: json.token_type || 'Bearer',
    scopes: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : [],
    raw: json,
  }
}

// ============================================================================
// Keychain token storage
// ============================================================================

let _keyringMod = null
function _keyring() {
  if (_keyringMod) return _keyringMod
  // Lazy-require: lets tests inject a fake via injectKeyring().
  _keyringMod = require('@napi-rs/keyring')
  return _keyringMod
}

/**
 * Test-only override. Pass a fake `{ Entry }` to swap the @napi-rs/keyring
 * binding in unit tests. Pass null to restore real behavior.
 */
function injectKeyring(fakeMod) {
  _keyringMod = fakeMod || null
}

function _entry(provider) {
  if (!provider) throw new Error('Keychain entry requires a provider')
  const { Entry } = _keyring()
  return new Entry(KEYCHAIN_SERVICE, provider)
}

/**
 * Persist token bundle to Keychain. Overwrites any previous tokens for the
 * provider. The bundle is stored as JSON.
 */
function saveTokens(provider, tokens) {
  if (!tokens || !tokens.accessToken) {
    throw new Error('saveTokens: tokens must include accessToken')
  }
  const payload = JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    expiresAt: tokens.expiresAt || null,
    tokenType: tokens.tokenType || 'Bearer',
    scopes: Array.isArray(tokens.scopes) ? tokens.scopes : [],
    savedAt: Date.now(),
  })
  _entry(provider).setPassword(payload)
  log.info('oauth-helper', 'tokens saved to keychain', {
    provider,
    hasRefresh: !!tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })
}

/**
 * Read token bundle from Keychain. Returns the parsed bundle or null if
 * nothing is stored / parse failed.
 */
function loadTokens(provider) {
  try {
    const raw = _entry(provider).getPassword()
    if (!raw) return null
    return JSON.parse(raw)
  } catch (err) {
    log.warn('oauth-helper', 'loadTokens failed', {
      provider,
      message: err.message,
    })
    return null
  }
}

/**
 * Delete token bundle for a provider. Idempotent.
 */
function clearTokens(provider) {
  try {
    _entry(provider).deletePassword()
    log.info('oauth-helper', 'tokens cleared from keychain', { provider })
  } catch (err) {
    log.warn('oauth-helper', 'clearTokens failed (may not exist)', {
      provider,
      message: err.message,
    })
  }
}

/**
 * Convenience: returns true if the stored access token for provider is not
 * yet expired. Pass `skewMs` (default 60s) to consider tokens about-to-
 * expire as already expired (so the caller refreshes proactively).
 */
function isAccessTokenValid(provider, skewMs = 60000) {
  const t = loadTokens(provider)
  if (!t || !t.accessToken) return false
  if (!t.expiresAt) return true // no expiry → assume valid
  return Date.now() < t.expiresAt - skewMs
}

// ============================================================================
// High-level flow starter
// ============================================================================

/**
 * Convenience entry point. Returns:
 *   { authUrl, codeVerifier, state, redirectUri }
 *
 * The caller is responsible for:
 *   1. Persisting { codeVerifier, state } somewhere (in-memory map keyed by
 *      provider name is fine for desktop) until the redirect comes back.
 *   2. Calling shell.openExternal(authUrl) to open the user's default browser.
 *   3. Wiring the protocol-handler dispatcher for `auth/<provider>/callback`
 *      to receive the redirect and validate state + exchange the code.
 */
function startOAuthFlow({
  provider,
  authEndpoint,
  clientId,
  redirectUri,
  scopes,
  extraParams = {},
}) {
  if (!provider) throw new Error('startOAuthFlow: provider required')
  const { codeVerifier, codeChallenge } = pkceChallenge()
  const state = randomState()
  const authUrl = buildAuthUrl({
    authEndpoint,
    clientId,
    redirectUri,
    scopes,
    codeChallenge,
    state,
    extraParams,
  })
  log.info('oauth-helper', 'flow started', { provider, redirectUri })
  return { authUrl, codeVerifier, state, redirectUri }
}

module.exports = {
  KEYCHAIN_SERVICE,
  // PKCE primitives
  base64url,
  pkceChallenge,
  randomState,
  buildAuthUrl,
  // Token endpoint
  exchangeCodeForToken,
  refreshAccessToken,
  // Keychain storage
  saveTokens,
  loadTokens,
  clearTokens,
  isAccessTokenValid,
  // High-level
  startOAuthFlow,
  // Test injection
  injectKeyring,
}
