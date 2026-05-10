// OZ Browser — oauth-helper smoke test (B-3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/oauth-helper.smoketest.js
//
// Cubre:
//   - PKCE primitives: base64url, pkceChallenge S256, randomState
//   - buildAuthUrl con todos los params estándar + scopes array/string
//   - exchangeCodeForToken happy path + HTTP error path
//   - refreshAccessToken preserves refresh_token if provider omits it
//   - Keychain save/load/clear roundtrip (vía fake Entry inyectada)
//   - isAccessTokenValid con skew
//   - startOAuthFlow integrado

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-oauth-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
    getName: () => 'OZ Browser Test',
    on: () => {},
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

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
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}
function section(name) {
  console.log(`\n— ${name} —`)
}

console.log('OZ Browser — oauth-helper smoke test')

delete require.cache[require.resolve('../browser/oauth-helper.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const oh = require('../browser/oauth-helper.js')

// Fake Keychain: in-memory map keyed by `${service}::${account}`.
class FakeEntry {
  constructor(service, account) {
    this.key = `${service}::${account}`
  }
  setPassword(value) {
    FakeEntry._store.set(this.key, value)
  }
  getPassword() {
    return FakeEntry._store.has(this.key) ? FakeEntry._store.get(this.key) : null
  }
  deletePassword() {
    FakeEntry._store.delete(this.key)
  }
}
FakeEntry._store = new Map()
oh.injectKeyring({ Entry: FakeEntry })

// ---- 1. PKCE primitives -----------------------------------------------------
section('PKCE primitives')
{
  const b = oh.base64url(Buffer.from('hello world'))
  ok('base64url is URL-safe', !/[+/=]/.test(b))
  ok('base64url round-trip via Buffer', b === 'aGVsbG8gd29ybGQ')

  const { codeVerifier, codeChallenge } = oh.pkceChallenge()
  ok('codeVerifier length 43+', codeVerifier.length >= 43 && codeVerifier.length <= 128)
  ok('codeVerifier URL-safe', /^[A-Za-z0-9_-]+$/.test(codeVerifier))
  ok('codeChallenge URL-safe', /^[A-Za-z0-9_-]+$/.test(codeChallenge))
  ok('codeChallenge length 43', codeChallenge.length === 43)
  // Different invocations produce different values
  const second = oh.pkceChallenge()
  ok('two invocations differ', codeVerifier !== second.codeVerifier)

  const s = oh.randomState()
  ok('state length 32 hex chars', s.length === 32 && /^[a-f0-9]+$/.test(s))
}

// ---- 2. buildAuthUrl --------------------------------------------------------
section('buildAuthUrl: required params + scopes array/string')
{
  const url = oh.buildAuthUrl({
    authEndpoint: 'https://example.com/authorize',
    clientId: 'abc123',
    redirectUri: 'oz://auth/example/callback',
    scopes: ['read', 'write'],
    codeChallenge: 'CHAL',
    state: 'STATE123',
    extraParams: { token_access_type: 'offline' },
  })
  const u = new URL(url)
  ok('host correct', u.host === 'example.com')
  ok('client_id', u.searchParams.get('client_id') === 'abc123')
  ok('response_type=code', u.searchParams.get('response_type') === 'code')
  ok(
    'redirect_uri preserved',
    u.searchParams.get('redirect_uri') === 'oz://auth/example/callback',
  )
  ok('code_challenge', u.searchParams.get('code_challenge') === 'CHAL')
  ok('code_challenge_method=S256', u.searchParams.get('code_challenge_method') === 'S256')
  ok('state', u.searchParams.get('state') === 'STATE123')
  ok('scope joined with space', u.searchParams.get('scope') === 'read write')
  ok('extraParams merged', u.searchParams.get('token_access_type') === 'offline')

  // scopes as string also works
  const url2 = oh.buildAuthUrl({
    authEndpoint: 'https://example.com/authorize',
    clientId: 'a',
    redirectUri: 'oz://x',
    codeChallenge: 'C',
    scopes: 'profile email',
  })
  ok(
    'scope as string passes through',
    new URL(url2).searchParams.get('scope') === 'profile email',
  )

  // throws on missing required
  let threw = null
  try {
    oh.buildAuthUrl({ clientId: 'a', redirectUri: 'oz://x', codeChallenge: 'C' })
  } catch (e) {
    threw = e
  }
  ok('throws when authEndpoint missing', !!threw)
}

// ---- 3. exchangeCodeForToken ------------------------------------------------
section('exchangeCodeForToken: happy path + HTTP error + missing fields')
{
  ;(async () => {
    let captured = null
    const fakeFetch = async (url, opts) => {
      captured = { url, opts }
      return {
        ok: true,
        async json() {
          return {
            access_token: 'ACCESS_TOKEN_xyz',
            refresh_token: 'REFRESH_TOKEN_abc',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'read write',
          }
        },
      }
    }
    const before = Date.now()
    const tokens = await oh.exchangeCodeForToken({
      tokenEndpoint: 'https://example.com/oauth2/token',
      code: 'CODE',
      codeVerifier: 'VERIFIER',
      clientId: 'CLIENT',
      redirectUri: 'oz://x',
      fetchImpl: fakeFetch,
    })
    ok('access_token returned', tokens.accessToken === 'ACCESS_TOKEN_xyz')
    ok('refresh_token returned', tokens.refreshToken === 'REFRESH_TOKEN_abc')
    ok('token_type defaulted Bearer', tokens.tokenType === 'Bearer')
    ok('scopes parsed to array', tokens.scopes.join(',') === 'read,write')
    ok('expiresAt is future', tokens.expiresAt > before + 3500 * 1000)
    ok(
      'fetch went to token endpoint',
      captured.url === 'https://example.com/oauth2/token',
    )
    ok(
      'Content-Type form-urlencoded',
      captured.opts.headers['Content-Type'] === 'application/x-www-form-urlencoded',
    )
    const params = new URLSearchParams(captured.opts.body)
    ok('grant_type=authorization_code', params.get('grant_type') === 'authorization_code')
    ok('code sent', params.get('code') === 'CODE')
    ok('code_verifier sent', params.get('code_verifier') === 'VERIFIER')

    // HTTP 400 error path
    const errFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    })
    let threw = null
    try {
      await oh.exchangeCodeForToken({
        tokenEndpoint: 'https://x',
        code: 'C',
        codeVerifier: 'V',
        clientId: 'CL',
        redirectUri: 'oz://x',
        fetchImpl: errFetch,
      })
    } catch (e) {
      threw = e
    }
    ok('HTTP 400 throws', !!threw)
    ok('status preserved on error', threw && threw.status === 400)

    // Missing required arg
    let threw2 = null
    try {
      await oh.exchangeCodeForToken({
        code: 'C',
        codeVerifier: 'V',
        clientId: 'CL',
        redirectUri: 'oz://x',
        fetchImpl: errFetch,
      })
    } catch (e) {
      threw2 = e
    }
    ok('throws on missing tokenEndpoint', threw2 && /tokenEndpoint/.test(threw2.message))

    run4()
  })().catch((e) => {
    console.error('exchangeCodeForToken section threw:', e)
    failed++
    run4()
  })
}

function run4() {
  // ---- 4. refreshAccessToken ------------------------------------------------
  section('refreshAccessToken: preserves refresh_token if provider omits it')
  ;(async () => {
    const fakeFetch = async () => ({
      ok: true,
      async json() {
        return {
          access_token: 'NEW_ACCESS',
          // NO refresh_token in response
          expires_in: 1800,
          token_type: 'Bearer',
        }
      },
    })
    const t = await oh.refreshAccessToken({
      tokenEndpoint: 'https://example.com/token',
      refreshToken: 'OLD_REFRESH',
      clientId: 'CL',
      fetchImpl: fakeFetch,
    })
    ok('new access token returned', t.accessToken === 'NEW_ACCESS')
    ok('old refresh token preserved', t.refreshToken === 'OLD_REFRESH')
    ok('expiresAt updated', t.expiresAt > Date.now() + 1700 * 1000)
    run5()
  })().catch((e) => {
    console.error('refresh section threw:', e)
    failed++
    run5()
  })
}

function run5() {
  // ---- 5. Keychain storage --------------------------------------------------
  section('Keychain: save / load / clear roundtrip')
  {
    const sample = {
      accessToken: 'AAA',
      refreshToken: 'BBB',
      expiresAt: Date.now() + 3600 * 1000,
      tokenType: 'Bearer',
      scopes: ['read'],
    }
    oh.saveTokens('test-provider', sample)
    const loaded = oh.loadTokens('test-provider')
    ok('loaded back', loaded && loaded.accessToken === 'AAA')
    ok('refreshToken preserved', loaded.refreshToken === 'BBB')
    ok('scopes preserved', Array.isArray(loaded.scopes) && loaded.scopes[0] === 'read')

    oh.clearTokens('test-provider')
    const cleared = oh.loadTokens('test-provider')
    ok('null after clear', cleared === null)

    // load on never-saved returns null
    ok('load on missing returns null', oh.loadTokens('never-saved') === null)
  }

  // ---- 6. isAccessTokenValid ------------------------------------------------
  section('isAccessTokenValid: skew window')
  {
    oh.saveTokens('skew-test', {
      accessToken: 'X',
      expiresAt: Date.now() + 120000, // 2 min from now
    })
    ok('valid 2min before expiry, default skew 60s', oh.isAccessTokenValid('skew-test'))
    ok('with 3min skew, considered expired', !oh.isAccessTokenValid('skew-test', 180000))
    oh.clearTokens('skew-test')

    // No expiry → valid
    oh.saveTokens('no-exp', { accessToken: 'X', expiresAt: null })
    ok('null expiresAt is treated as valid', oh.isAccessTokenValid('no-exp'))
    oh.clearTokens('no-exp')

    // Already expired
    oh.saveTokens('expired', { accessToken: 'X', expiresAt: Date.now() - 1000 })
    ok('past expiresAt is invalid', !oh.isAccessTokenValid('expired'))
    oh.clearTokens('expired')

    // Never saved
    ok('never-saved returns false', !oh.isAccessTokenValid('never-saved'))
  }

  // ---- 7. startOAuthFlow integrated -----------------------------------------
  section('startOAuthFlow: integrated PKCE + auth URL builder')
  {
    const out = oh.startOAuthFlow({
      provider: 'dropbox',
      authEndpoint: 'https://www.dropbox.com/oauth2/authorize',
      clientId: 'oz_dropbox_clientid',
      redirectUri: 'oz://auth/dropbox/callback',
      scopes: ['files.metadata.write', 'files.content.write'],
      extraParams: { token_access_type: 'offline' },
    })
    ok('returns authUrl', typeof out.authUrl === 'string' && out.authUrl.length > 0)
    ok('returns codeVerifier', typeof out.codeVerifier === 'string')
    ok('returns state', typeof out.state === 'string')
    const u = new URL(out.authUrl)
    ok('authUrl has client_id', u.searchParams.get('client_id') === 'oz_dropbox_clientid')
    ok('authUrl has S256', u.searchParams.get('code_challenge_method') === 'S256')
    ok('authUrl carries our state', u.searchParams.get('state') === out.state)
    ok('extraParams in URL', u.searchParams.get('token_access_type') === 'offline')
    ok('scope joined', u.searchParams.get('scope').includes('files.metadata.write'))
  }

  finish()
}

function finish() {
  Module._load = originalLoad
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures)
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    process.exit(1)
  }
  process.exit(0)
}
