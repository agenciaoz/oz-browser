// OZ Browser — Dropbox Client smoke test (Bloque D-1.2).
//
// Cómo correr:
//   cd oz-browser
//   node tests/dropbox-client.smoketest.js
//
// Cubre:
//   - _normalizePath: leading slash, dedup, backslash, trailing slash
//   - _statusFromError: extract from err.status / err.response.status
//   - _errSummary: extract from err.error.error_summary / err.error_summary
//   - _wrap: idempotent, preserves status
//   - startAuth: builds authUrl with PKCE + state + offline param
//   - completeAuth: exchange via mocked oauth-helper + save tokens
//   - completeAuth: state mismatch throws STATE_MISMATCH
//   - isAuthenticated: true after completeAuth, false after clearAuth
//   - getAccountInfo: normalizes SDK response
//   - ensureFolder: idempotent on path/conflict/folder
//   - upload: validates Buffer + invokes filesUpload + returns metadata
//   - upload too large: throws TOO_LARGE
//   - download: returns Buffer + metadata
//   - listFolder: empty array on path_not_found
//   - delete: invokes filesDeleteV2
//   - 401 → refresh → retry: succeeds with new token
//   - 401 + no refresh token: clears auth + throws NEEDS_REAUTH
//   - 401 + refresh fails: clears auth + throws NEEDS_REAUTH

const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-dropbox-client-'))

const {
  createDropboxClient,
  DropboxError,
  DROPBOX_PROVIDER,
  DROPBOX_AUTH_ENDPOINT,
  DROPBOX_TOKEN_ENDPOINT,
  DROPBOX_SCOPES,
  DROPBOX_REDIRECT_URI,
  SIMPLE_UPLOAD_MAX_BYTES,
  injectDropboxSdk,
  _normalizePath,
  _statusFromError,
  _errSummary,
  _wrap,
} = require('../browser/dropbox-client')

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.error(`  ✗ ${label}`)
    if (detail !== undefined) console.error(`      → ${JSON.stringify(detail)}`)
  }
}

function group(name, fn) {
  console.log(`\n[${name}]`)
  fn()
}

async function asyncGroup(name, fn) {
  console.log(`\n[${name}]`)
  await fn()
}

// ---------- in-memory fake oauth-helper ----------
function makeFakeOauth(initial = {}) {
  const store = new Map()
  if (initial.tokens) store.set(DROPBOX_PROVIDER, initial.tokens)
  const calls = {
    startOAuthFlow: 0,
    exchangeCodeForToken: 0,
    refreshAccessToken: 0,
    saveTokens: 0,
    clearTokens: 0,
  }
  return {
    calls,
    startOAuthFlow(args) {
      calls.startOAuthFlow++
      return {
        authUrl: `https://www.dropbox.com/oauth2/authorize?client_id=${args.clientId}&redirect_uri=${encodeURIComponent(args.redirectUri)}&code_challenge=FAKECHAL&state=FAKESTATE&scope=${encodeURIComponent((args.scopes || []).join(' '))}&token_access_type=${args.extraParams && args.extraParams.token_access_type}`,
        codeVerifier: 'FAKEVERIFIER',
        state: 'FAKESTATE',
        redirectUri: args.redirectUri,
      }
    },
    async exchangeCodeForToken(args) {
      calls.exchangeCodeForToken++
      if (initial.exchangeShouldFail) throw new Error('exchange forced fail')
      return {
        accessToken: 'AT-FROM-CODE',
        refreshToken: 'RT-1',
        expiresAt: Date.now() + 3600 * 1000,
        tokenType: 'Bearer',
        scopes: args.scopes || [],
      }
    },
    async refreshAccessToken(args) {
      calls.refreshAccessToken++
      if (initial.refreshShouldFail) throw new Error('refresh forced fail')
      return {
        accessToken: 'AT-REFRESHED',
        refreshToken: args.refreshToken,
        expiresAt: Date.now() + 3600 * 1000,
      }
    },
    saveTokens(provider, tokens) {
      calls.saveTokens++
      store.set(provider, tokens)
    },
    loadTokens(provider) {
      return store.get(provider) || null
    },
    clearTokens(provider) {
      calls.clearTokens++
      store.delete(provider)
    },
  }
}

// ---------- in-memory fake Dropbox SDK ----------
function makeFakeSdk(scriptedResponses = {}) {
  const log = []
  class FakeDropbox {
    constructor(opts) {
      this.opts = opts
      log.push({ kind: 'ctor', accessToken: opts.accessToken })
    }
    async usersGetCurrentAccount() {
      log.push({ kind: 'usersGetCurrentAccount' })
      const next = (scriptedResponses.usersGetCurrentAccount || []).shift()
      if (next instanceof Error) throw next
      return next || _defaultAccount()
    }
    async filesCreateFolderV2(arg) {
      log.push({ kind: 'filesCreateFolderV2', arg })
      const next = (scriptedResponses.filesCreateFolderV2 || []).shift()
      if (next instanceof Error) throw next
      return next || { result: { metadata: { path_lower: arg.path } } }
    }
    async filesUpload(arg) {
      log.push({ kind: 'filesUpload', path: arg.path, size: arg.contents.length })
      const next = (scriptedResponses.filesUpload || []).shift()
      if (next instanceof Error) throw next
      return (
        next || {
          result: {
            path_display: arg.path,
            path_lower: arg.path.toLowerCase(),
            size: arg.contents.length,
            rev: 'REV-1',
            content_hash: 'CHASH',
          },
        }
      )
    }
    async filesUploadSessionStart(arg) {
      log.push({
        kind: 'filesUploadSessionStart',
        size: arg.contents.length,
        close: arg.close,
      })
      const next = (scriptedResponses.filesUploadSessionStart || []).shift()
      if (next instanceof Error) throw next
      return next || { result: { session_id: 'SESS-1' } }
    }
    async filesUploadSessionAppendV2(arg) {
      log.push({
        kind: 'filesUploadSessionAppendV2',
        size: arg.contents.length,
        offset: arg.cursor.offset,
        sessionId: arg.cursor.session_id,
      })
      const next = (scriptedResponses.filesUploadSessionAppendV2 || []).shift()
      if (next instanceof Error) throw next
      return next || {}
    }
    async filesUploadSessionFinish(arg) {
      log.push({
        kind: 'filesUploadSessionFinish',
        size: arg.contents.length,
        offset: arg.cursor.offset,
        sessionId: arg.cursor.session_id,
        commitPath: arg.commit.path,
      })
      const next = (scriptedResponses.filesUploadSessionFinish || []).shift()
      if (next instanceof Error) throw next
      const totalSize = arg.cursor.offset + arg.contents.length
      return (
        next || {
          result: {
            path_display: arg.commit.path,
            path_lower: arg.commit.path.toLowerCase(),
            size: totalSize,
            rev: 'REV-FIN',
            content_hash: 'CFIN',
          },
        }
      )
    }
    async filesDownload(arg) {
      log.push({ kind: 'filesDownload', path: arg.path })
      const next = (scriptedResponses.filesDownload || []).shift()
      if (next instanceof Error) throw next
      return (
        next || {
          result: {
            fileBinary: Buffer.from('hello'),
            path_display: arg.path,
            size: 5,
            rev: 'REV-D',
            content_hash: 'DHASH',
          },
        }
      )
    }
    async filesListFolder(arg) {
      log.push({ kind: 'filesListFolder', path: arg.path })
      const next = (scriptedResponses.filesListFolder || []).shift()
      if (next instanceof Error) throw next
      return next || { result: { entries: [] } }
    }
    async filesDeleteV2(arg) {
      log.push({ kind: 'filesDeleteV2', path: arg.path })
      const next = (scriptedResponses.filesDeleteV2 || []).shift()
      if (next instanceof Error) throw next
      return next || { result: { metadata: {} } }
    }
  }
  return { Dropbox: FakeDropbox, _log: log }
}
function _defaultAccount() {
  return {
    result: {
      account_id: 'dbid:ACCT',
      email: 'jose@example.com',
      name: { display_name: 'Jose' },
      country: 'PA',
    },
  }
}
function makeStatusError(status, summary) {
  const e = new Error(`status ${status}`)
  e.status = status
  if (summary) e.error = { error_summary: summary }
  return e
}

// ---------- helpers tests ----------
group('_normalizePath', () => {
  ok('empty → empty', _normalizePath('') === '' && _normalizePath('/') === '')
  ok('adds leading slash', _normalizePath('foo/bar.txt') === '/foo/bar.txt')
  ok('dedup slashes', _normalizePath('//foo//bar///') === '/foo/bar')
  ok('backslash → slash', _normalizePath('\\foo\\bar') === '/foo/bar')
  ok('trailing slash stripped', _normalizePath('/foo/') === '/foo')
  ok('no trailing strip if just slash', _normalizePath('/') === '')
})

group('_statusFromError', () => {
  ok('from err.status', _statusFromError({ status: 401 }) === 401)
  ok('from err.response.status', _statusFromError({ response: { status: 500 } }) === 500)
  ok('null when none', _statusFromError({}) === null)
  ok('null when err null', _statusFromError(null) === null)
})

group('_errSummary', () => {
  ok(
    'from error.error_summary',
    _errSummary({ error: { error_summary: 'path/conflict/folder' } }) ===
      'path/conflict/folder',
  )
  ok(
    'from error_summary',
    _errSummary({ error_summary: 'path/not_found' }) === 'path/not_found',
  )
  ok('falls back to message', _errSummary({ message: 'plain' }) === 'plain')
  ok('empty when no source', _errSummary({}) === '')
})

group('_wrap', () => {
  const e = _wrap({ status: 429, error: { error_summary: 'too_many_requests/' } })
  ok('preserves status', e.status === 429)
  ok('uses summary as message', e.message === 'too_many_requests/')
  ok('wraps as DropboxError', e instanceof DropboxError)
  const e2 = new DropboxError('already', 'CODE', 400)
  ok('idempotent on DropboxError', _wrap(e2) === e2)
})

// ---------- async tests ----------
;(async () => {
  await asyncGroup('startAuth', () => {
    const oauth = makeFakeOauth()
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const r = c.startAuth()
    ok(
      'returns authUrl',
      typeof r.authUrl === 'string' && r.authUrl.includes('client_id=APPKEY'),
    )
    ok('returns codeVerifier', r.codeVerifier === 'FAKEVERIFIER')
    ok('returns state', r.state === 'FAKESTATE')
    ok('redirectUri is oz://...', r.redirectUri === DROPBOX_REDIRECT_URI)
    ok('startOAuthFlow called once', oauth.calls.startOAuthFlow === 1)
  })

  await asyncGroup('completeAuth happy path', async () => {
    const oauth = makeFakeOauth()
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const r = await c.completeAuth({
      code: 'CODE-1',
      state: 'FAKESTATE',
      expectedCodeVerifier: 'FAKEVERIFIER',
      expectedState: 'FAKESTATE',
    })
    ok('returns ok', r.ok === true)
    ok('exchange called once', oauth.calls.exchangeCodeForToken === 1)
    ok('tokens saved', oauth.calls.saveTokens === 1)
    ok('isAuthenticated true', c.isAuthenticated() === true)
  })

  await asyncGroup('completeAuth state mismatch', async () => {
    const oauth = makeFakeOauth()
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    let threw = null
    try {
      await c.completeAuth({
        code: 'CODE-1',
        state: 'WRONG',
        expectedCodeVerifier: 'FAKEVERIFIER',
        expectedState: 'RIGHT',
      })
    } catch (e) {
      threw = e
    }
    ok('threw DropboxError', threw instanceof DropboxError)
    ok('code = STATE_MISMATCH', threw && threw.code === 'STATE_MISMATCH')
    ok('exchange NOT called', oauth.calls.exchangeCodeForToken === 0)
  })

  await asyncGroup('clearAuth', async () => {
    const oauth = makeFakeOauth({
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600e3 },
    })
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    ok('isAuthenticated initially', c.isAuthenticated() === true)
    c.clearAuth()
    ok('clearTokens called', oauth.calls.clearTokens === 1)
    ok('isAuthenticated false after clear', c.isAuthenticated() === false)
  })

  await asyncGroup('getAccountInfo', async () => {
    const oauth = makeFakeOauth({
      tokens: { accessToken: 'AT', refreshToken: 'RT' },
    })
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const info = await c.getAccountInfo()
    ok('email returned', info.email === 'jose@example.com')
    ok('name returned', info.name === 'Jose')
    ok('country returned', info.country === 'PA')
  })

  await asyncGroup('ensureFolder happy + idempotent', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT', refreshToken: 'RT' } })
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const r1 = await c.ensureFolder('/joses-macbook-pro-a1b2c3d4/snapshots')
    ok('first create ok', r1.ok === true && r1.existed === false)
    // simulate path/conflict/folder on second call
    const sdk2 = makeFakeSdk({
      filesCreateFolderV2: [makeStatusError(409, 'path/conflict/folder/.')],
    })
    injectDropboxSdk(sdk2)
    const c2 = createDropboxClient({
      clientId: 'APPKEY',
      oauth: makeFakeOauth({ tokens: { accessToken: 'AT' } }),
    })
    const r2 = await c2.ensureFolder('/existing-folder')
    ok('idempotent on conflict', r2.ok === true && r2.existed === true)
  })

  await asyncGroup('upload happy', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT', refreshToken: 'RT' } })
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const buf = Buffer.from('snapshot body bytes')
    const r = await c.upload({ path: '/foo/bar.ozbackup', contents: buf })
    ok('returns size', r.size === buf.length)
    ok('returns rev', r.rev === 'REV-1')
    ok('returns path', r.path === '/foo/bar.ozbackup')
    const uploadCall = sdk._log.find((x) => x.kind === 'filesUpload')
    ok('called filesUpload', !!uploadCall)
    ok('path normalized', uploadCall && uploadCall.path === '/foo/bar.ozbackup')
  })

  await asyncGroup('upload validation', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    let threw = null
    try {
      await c.upload({ path: '/x', contents: 'not a buffer' })
    } catch (e) {
      threw = e
    }
    ok('rejects non-Buffer', threw && threw.code === 'BAD_ARG')
    // D-2.2 chunked upload + D-2.3 cursor-based listings cobertura: split
    // a tests/dropbox-client-d2.smoketest.js (ADR 0005 LOC budget).
  })

  await asyncGroup('download', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const r = await c.download('/foo.ozbackup')
    ok('contents is Buffer', Buffer.isBuffer(r.contents))
    ok('contents = hello', r.contents.toString() === 'hello')
    ok('size returned', r.size === 5)
  })

  // listFolder shape tests moved to dropbox-client-d2.smoketest.js
  // (D-2.3 cursor-based listings).

  await asyncGroup('delete', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const r = await c.delete('/foo.ozbackup')
    ok('ok true', r.ok === true)
    const callIdx = sdk._log.findIndex((x) => x.kind === 'filesDeleteV2')
    ok('filesDeleteV2 called', callIdx >= 0)
  })

  await asyncGroup('401 → refresh → retry succeeds', async () => {
    const oauth = makeFakeOauth({
      tokens: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() + 3600e3 },
    })
    // First filesUpload 401s; on retry it succeeds.
    const sdk = makeFakeSdk({
      filesUpload: [
        makeStatusError(401, 'expired_access_token/'),
        {
          result: { path_display: '/r.ozbackup', size: 4, rev: 'R', content_hash: 'H' },
        },
      ],
    })
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const r = await c.upload({ path: '/r.ozbackup', contents: Buffer.from('test') })
    ok('refresh called once', oauth.calls.refreshAccessToken === 1)
    ok('saveTokens called once (after refresh)', oauth.calls.saveTokens === 1, {
      actual: oauth.calls.saveTokens,
    })
    ok('upload succeeded after retry', r.size === 4)
    const ctors = sdk._log.filter((x) => x.kind === 'ctor')
    ok('SDK built twice (old then refreshed)', ctors.length === 2)
    ok('second SDK got AT-REFRESHED', ctors[1].accessToken === 'AT-REFRESHED')
  })

  await asyncGroup('401 + no refresh token = NEEDS_REAUTH', async () => {
    const oauth = makeFakeOauth({
      tokens: { accessToken: 'OLD', refreshToken: null, expiresAt: Date.now() + 3600e3 },
    })
    const sdk = makeFakeSdk({
      filesUpload: [makeStatusError(401, 'expired_access_token/')],
    })
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    let threw = null
    try {
      await c.upload({ path: '/x', contents: Buffer.from('y') })
    } catch (e) {
      threw = e
    }
    ok('threw DropboxError', threw instanceof DropboxError)
    ok('code = NEEDS_REAUTH', threw && threw.code === 'NEEDS_REAUTH')
    ok('refresh NOT called (no refresh token)', oauth.calls.refreshAccessToken === 0)
    ok('clearTokens called', oauth.calls.clearTokens === 1)
  })

  await asyncGroup('401 + refresh fails = NEEDS_REAUTH', async () => {
    const oauth = makeFakeOauth({
      tokens: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() + 3600e3 },
      refreshShouldFail: true,
    })
    const sdk = makeFakeSdk({
      filesUpload: [makeStatusError(401, 'expired_access_token/')],
    })
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    let threw = null
    try {
      await c.upload({ path: '/x', contents: Buffer.from('y') })
    } catch (e) {
      threw = e
    }
    ok('threw DropboxError', threw instanceof DropboxError)
    ok('code = NEEDS_REAUTH', threw && threw.code === 'NEEDS_REAUTH')
    ok('refresh attempted once', oauth.calls.refreshAccessToken === 1)
    ok('clearTokens called after fail', oauth.calls.clearTokens === 1)
  })

  await asyncGroup('not authenticated', async () => {
    const oauth = makeFakeOauth() // no initial tokens
    injectDropboxSdk(makeFakeSdk())
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    let threw = null
    try {
      await c.upload({ path: '/x', contents: Buffer.from('y') })
    } catch (e) {
      threw = e
    }
    ok('threw NEEDS_REAUTH', threw && threw.code === 'NEEDS_REAUTH')
    ok('isAuthenticated false', c.isAuthenticated() === false)
  })

  // ---------- summary ----------
  console.log(`\n${'='.repeat(50)}`)
  console.log(`dropbox-client smoke: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f.label}`)
  }
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  } catch (_) {
    /* ignore */
  }
  process.exit(failed === 0 ? 0 : 1)
})()
