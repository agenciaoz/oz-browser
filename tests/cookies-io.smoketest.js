// OZ Browser — cookies-io + cookies-handlers smoke test (1.7c).
//
// Cómo correr:
//   cd oz-browser
//   node tests/cookies-io.smoketest.js
//
// Cubre:
//   - encode/decode round-trip por cada uno de los 4 formatos
//   - Lossless en oz format (todos los campos preservados)
//   - Netscape: tab-delimited correctness, # HttpOnly_ prefix tolerance
//   - AdsPower / Multilogin: shape correcto + sameSite normalization
//   - Tolerancia a malformed inputs (sin tirar el proceso)
//   - cookies-handlers exportContent / exportToFile / importContent /
//     importFromFile con FakeSession / FakeIM
//   - Identity unknown / format unknown → ok:false con reason

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-cookies-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
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

console.log('OZ Browser — cookies-io + handlers smoke test')

// ---------- Sample canonical jar ------------------------------------------

const SAMPLE_JAR = [
  {
    name: 'sid',
    value: 'abc123',
    domain: '.x.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    expirationDate: 1893456000, // 2030-01-01
    sameSite: 'no_restriction',
  },
  {
    name: 'csrf',
    value: 'xyz789',
    domain: 'x.com',
    path: '/api',
    secure: true,
    httpOnly: false,
    hostOnly: true,
    session: true,
    sameSite: 'lax',
  },
]

// ---------- Tests ---------------------------------------------------------

section('format: oz — round-trip lossless')
{
  const { encode, decode } = require('../browser/cookies-io.js')
  const text = encode('oz', SAMPLE_JAR)
  ok('returns non-empty string', typeof text === 'string' && text.length > 0)
  const parsed = JSON.parse(text)
  ok('wrapper has format=oz', parsed.format === 'oz')
  ok('wrapper has version=1', parsed.version === 1)
  ok('wrapper has cookies array', Array.isArray(parsed.cookies))

  const decoded = decode('oz', text)
  ok('decoded length === 2', decoded.length === 2)
  ok('sid preserved', decoded[0].name === 'sid' && decoded[0].value === 'abc123')
  ok('expirationDate preserved', decoded[0].expirationDate === 1893456000)
  ok('csrf domain preserved', decoded[1].domain === 'x.com')
  ok('csrf path preserved', decoded[1].path === '/api')
  ok('csrf sameSite preserved', decoded[1].sameSite === 'lax')

  // Decode bare array also accepted
  const bare = decode('oz', JSON.stringify(SAMPLE_JAR))
  ok('decode bare array', bare.length === 2)
}

section('format: netscape — round-trip')
{
  const { encode, decode } = require('../browser/cookies-io.js')
  const text = encode('netscape', SAMPLE_JAR)
  ok('starts with # Netscape header', text.startsWith('# Netscape HTTP Cookie File'))
  ok('contains sid line', text.includes('\tsid\tabc123'))
  ok(
    'tab-delimited 7 fields per line',
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .every((l) => l.split('\t').length === 7),
  )
  // session cookie expiration → 0
  ok('session cookie exp=0', text.includes('\t0\tcsrf'))
  ok('non-session cookie exp present', text.includes('\t1893456000\tsid'))
  // .x.com → flag TRUE; x.com → flag FALSE
  const lines = text
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
  ok('.x.com line has flag TRUE', lines.find((l) => l[5] === 'sid')[1] === 'TRUE')
  ok('x.com line has flag FALSE', lines.find((l) => l[5] === 'csrf')[1] === 'FALSE')

  // Round-trip
  const decoded = decode('netscape', text)
  ok('decoded length === 2', decoded.length === 2)
  const sid = decoded.find((c) => c.name === 'sid')
  const csrf = decoded.find((c) => c.name === 'csrf')
  ok('sid value preserved', sid.value === 'abc123')
  ok('sid expirationDate preserved', sid.expirationDate === 1893456000)
  ok('sid secure preserved', sid.secure === true)
  ok('csrf session true', csrf.session === true)
  ok('csrf no expirationDate', !csrf.expirationDate)
  ok('csrf path /api preserved', csrf.path === '/api')

  // #HttpOnly_ prefix tolerance
  const withHttpOnly =
    '# Netscape HTTP Cookie File\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\thttp_only_cookie\tval\n'
  const dec2 = decode('netscape', withHttpOnly)
  ok('strips #HttpOnly_ prefix', dec2.length === 1)
  ok('marks httpOnly true', dec2[0].httpOnly === true)
  ok('parses domain correctly', dec2[0].domain === '.example.com')
}

section('format: adspower — round-trip + storeId field')
{
  const { encode, decode } = require('../browser/cookies-io.js')
  const text = encode('adspower', SAMPLE_JAR)
  const parsed = JSON.parse(text)
  ok('returns array (no wrapper)', Array.isArray(parsed))
  ok('length === 2', parsed.length === 2)
  ok('has storeId="0"', parsed[0].storeId === '0')
  ok(
    'hostOnly preserved (csrf=true)',
    parsed.find((c) => c.name === 'csrf').hostOnly === true,
  )
  ok('sameSite normalized', parsed.find((c) => c.name === 'csrf').sameSite === 'lax')

  const decoded = decode('adspower', text)
  ok('decoded length === 2', decoded.length === 2)
  ok('sid value preserved', decoded[0].value === 'abc123')
  ok('expirationDate preserved', decoded[0].expirationDate === 1893456000)
}

section('format: multilogin — round-trip + no storeId')
{
  const { encode, decode } = require('../browser/cookies-io.js')
  const text = encode('multilogin', SAMPLE_JAR)
  const parsed = JSON.parse(text)
  ok('returns array', Array.isArray(parsed))
  ok('length === 2', parsed.length === 2)
  ok('no storeId field', parsed[0].storeId === undefined)
  ok('sameSite normalized', parsed.find((c) => c.name === 'csrf').sameSite === 'lax')

  const decoded = decode('multilogin', text)
  ok('decoded length === 2', decoded.length === 2)
  ok('csrf path preserved', decoded.find((c) => c.name === 'csrf').path === '/api')
}

section('format: header — encode (lossy)')
{
  const { encode } = require('../browser/cookies-io.js')
  const text = encode('header', SAMPLE_JAR)
  ok('returns plain string', typeof text === 'string')
  ok('joins with `; ` separator', text === 'sid=abc123; csrf=xyz789')
  // No domain/path/secure leakage
  ok('no domain in header output', !text.includes('x.com'))
  ok('no path in header output', !text.includes('/api'))
  // Empty input → empty string (not crash)
  ok('empty array → empty string', encode('header', []) === '')
  ok('null array → empty string', encode('header', null) === '')
  // Cookie with no name skipped
  const skipped = encode('header', [{ value: 'orphan' }, { name: 'k', value: 'v' }])
  ok('cookie with no name is skipped', skipped === 'k=v')
  // null value → empty string after `=`
  const nullVal = encode('header', [{ name: 'sid', value: null }])
  ok('null value → empty', nullVal === 'sid=')
}

section('format: header — decode requires defaultDomain')
{
  const { decode, CookiesFormatError } = require('../browser/cookies-io.js')
  let threw = false
  try {
    decode('header', 'sid=abc')
  } catch (e) {
    threw = e instanceof CookiesFormatError && /defaultDomain/.test(e.message)
  }
  ok('decode header without defaultDomain throws', threw)

  threw = false
  try {
    decode('header', 'sid=abc', {})
  } catch (e) {
    threw = e instanceof CookiesFormatError && /defaultDomain/.test(e.message)
  }
  ok('decode header with empty options throws', threw)
}

section('format: header — decode basic')
{
  const { decode } = require('../browser/cookies-io.js')
  const out = decode('header', 'sid=abc123; csrf=xyz789', {
    defaultDomain: '.tiktok.com',
  })
  ok('parses 2 pairs', out.length === 2)
  ok('first name correct', out[0].name === 'sid')
  ok('first value correct', out[0].value === 'abc123')
  ok('second name correct', out[1].name === 'csrf')
  ok('domain bound from defaultDomain', out[0].domain === '.tiktok.com')
  ok('leading-dot → hostOnly=false', out[0].hostOnly === false)
  ok('path defaults to /', out[0].path === '/')
  ok('secure default true', out[0].secure === true)
  ok('session default true', out[0].session === true)
  ok('sameSite default no_restriction', out[0].sameSite === 'no_restriction')
  // hostOnly inferred from absence of leading dot
  const noDot = decode('header', 'a=b', { defaultDomain: 'instagram.com' })
  ok('no leading dot → hostOnly=true', noDot[0].hostOnly === true)
}

section('format: header — decode edge cases')
{
  const { decode } = require('../browser/cookies-io.js')
  // Empty + whitespace
  ok('empty string → []', decode('header', '', { defaultDomain: '.x.com' }).length === 0)
  ok(
    'whitespace string → []',
    decode('header', '   \n   ', { defaultDomain: '.x.com' }).length === 0,
  )
  // Leading "Cookie: " prefix (DevTools raw header copy)
  const prefixed = decode('header', 'Cookie: sid=abc; csrf=xyz', {
    defaultDomain: '.x.com',
  })
  ok(
    'strips leading "Cookie: " prefix',
    prefixed.length === 2 && prefixed[0].name === 'sid',
  )
  // Case-insensitive prefix strip
  const prefixedUpper = decode('header', 'COOKIE: sid=abc', { defaultDomain: '.x.com' })
  ok('strips uppercase prefix', prefixedUpper.length === 1)
  // Values with `=` (base64, JWT, signed tokens — common in real TikTok/IG sessions)
  const b64 = decode('header', 'tok=eyJhbGc=.eyJzdWI=.sig==', {
    defaultDomain: '.x.com',
  })
  ok('splits on FIRST `=` only', b64[0].value === 'eyJhbGc=.eyJzdWI=.sig==')
  // Quoted values (RFC 6265 §4.1.1 allows double-quoted)
  const quoted = decode('header', 'sid="abc 123"', { defaultDomain: '.x.com' })
  ok('strips surrounding double quotes', quoted[0].value === 'abc 123')
  // Inner quotes preserved
  const inner = decode('header', 'sid=a"b"c', { defaultDomain: '.x.com' })
  ok('inner quotes preserved', inner[0].value === 'a"b"c')
  // Defensive: bare names (no =) skipped, =-only also skipped
  const bareNames = decode('header', 'orphan; =value; valid=ok', {
    defaultDomain: '.x.com',
  })
  ok('skips bare names and =value entries', bareNames.length === 1)
  ok('keeps the valid one', bareNames[0].name === 'valid')
  // Trailing semicolon tolerated
  const trailing = decode('header', 'a=1; b=2;', { defaultDomain: '.x.com' })
  ok('trailing `;` tolerated', trailing.length === 2)
  // Lots of whitespace around tokens
  const messy = decode('header', '  a = 1 ;   b=2', { defaultDomain: '.x.com' })
  ok('whitespace around tokens trimmed (count)', messy.length === 2)
  ok('whitespace around tokens trimmed (name)', messy[0].name === 'a')
  ok('whitespace around tokens trimmed (value)', messy[0].value === '1')
  // Single cookie, no semicolon
  const single = decode('header', 'sid=abc', { defaultDomain: '.x.com' })
  ok('single cookie no `;` works', single.length === 1)
  // Empty value (logout sentinel)
  const empty = decode('header', 'sid=', { defaultDomain: '.x.com' })
  ok('empty value parsed as empty string', empty.length === 1 && empty[0].value === '')
}

section('format: header — round-trip (with domain re-bind)')
{
  const { encode, decode } = require('../browser/cookies-io.js')
  const encoded = encode('header', SAMPLE_JAR)
  const decoded = decode('header', encoded, { defaultDomain: '.x.com' })
  ok('round-trip length match', decoded.length === SAMPLE_JAR.length)
  // Note: this is LOSSY — only name+value survive
  ok('name preserved', decoded[0].name === SAMPLE_JAR[0].name)
  ok('value preserved', decoded[0].value === SAMPLE_JAR[0].value)
  ok('domain re-bound from option', decoded[0].domain === '.x.com')
  // The original SAMPLE_JAR[1] had domain 'x.com' (no dot, hostOnly) but
  // round-trip rebinds everything to defaultDomain — that's the format's
  // contract, not a bug.
  ok('domain rebind applies to ALL cookies', decoded[1].domain === '.x.com')
}

section('error handling: unsupported / malformed')
{
  const { encode, decode, CookiesFormatError } = require('../browser/cookies-io.js')
  let threw = false
  try {
    encode('bogus', [])
  } catch (e) {
    threw = e instanceof CookiesFormatError
  }
  ok('encode unsupported throws', threw)

  threw = false
  try {
    decode('oz', 'not json {{')
  } catch (e) {
    threw = e instanceof CookiesFormatError && e.message.includes('invalid JSON')
  }
  ok('decode oz invalid JSON throws CookiesFormatError', threw)

  threw = false
  try {
    decode('adspower', '{"not":"array"}')
  } catch (e) {
    threw = e instanceof CookiesFormatError
  }
  ok('decode adspower non-array throws', threw)

  // Netscape malformed — should silently skip, return what it could parse
  const dec = decode('netscape', 'this is not\ta\tcookie\nfine\nheaderline')
  ok('netscape malformed returns empty', dec.length === 0)
}

section('handlers.exportContent — fake session')
{
  delete require.cache[require.resolve('../browser/cookies-handlers.js')]
  delete require.cache[require.resolve('../browser/cookies-io.js')]
  const { buildCookieHandlers } = require('../browser/cookies-handlers.js')

  const fakeSes = { cookies: { get: async (_filter) => SAMPLE_JAR } }
  const fakeIM = {
    get: (id) => (id === 'id-1' ? { id: 'id-1', name: 'A' } : null),
    getSession: () => fakeSes,
  }
  const browser = { identityManager: fakeIM }
  const h = buildCookieHandlers(browser)
  ;(async () => {
    const r = await h.exportContent('id-1', 'oz')
    ok('export ok', r.ok === true)
    ok('cookieCount === 2', r.cookieCount === 2)
    ok('content includes sid', r.content.includes('"sid"'))

    const r2 = await h.exportContent('id-1', 'netscape')
    ok('netscape export ok', r2.ok === true)
    ok('netscape content has tab-delimited line', r2.content.includes('\tsid\t'))

    const bad = await h.exportContent('id-1', 'bogus-format')
    ok('bogus format → ok:false', bad.ok === false)
    ok('reason unsupported-format', bad.reason === 'unsupported-format')

    const ghost = await h.exportContent('does-not-exist', 'oz')
    ok('unknown identity → ok:false', ghost.ok === false)
    ok('reason identity-not-found', ghost.reason === 'identity-not-found')
    runRoundTripTest()
  })()
}

let _setRoundTripDone = null
function runRoundTripTest() {
  section('handlers.importContent — round-trip via fake session')
  delete require.cache[require.resolve('../browser/cookies-handlers.js')]
  delete require.cache[require.resolve('../browser/cookies-io.js')]
  const { buildCookieHandlers } = require('../browser/cookies-handlers.js')

  const setCalls = []
  const fakeSes = {
    cookies: {
      get: async () => SAMPLE_JAR,
      set: async (cookie) => {
        setCalls.push(cookie)
      },
    },
  }
  const fakeIM = {
    get: (id) => (id === 'id-1' ? { id: 'id-1', name: 'A' } : null),
    getSession: () => fakeSes,
  }
  const browser = { identityManager: fakeIM }
  const h = buildCookieHandlers(browser)
  ;(async () => {
    // Export then re-import via OZ format → setCalls should match
    const exp = await h.exportContent('id-1', 'oz')
    setCalls.length = 0
    const imp = await h.importContent('id-1', 'oz', exp.content)
    ok('import ok', imp.ok === true)
    ok('parsedCount === 2', imp.parsedCount === 2)
    ok('written === 2', imp.written === 2)
    ok('setCalls captured 2', setCalls.length === 2)
    ok('first call has url + name', setCalls[0].url && setCalls[0].name === 'sid')
    ok('https url for secure cookie', setCalls[0].url.startsWith('https://'))
    ok('domain stripped of leading dot in url', setCalls[0].url.includes('://x.com'))
    ok('expirationDate forwarded', setCalls[0].expirationDate === 1893456000)
    ok('sameSite forwarded', setCalls[0].sameSite === 'no_restriction')

    // Import netscape format
    setCalls.length = 0
    const expNS = await h.exportContent('id-1', 'netscape')
    const impNS = await h.importContent('id-1', 'netscape', expNS.content)
    ok('netscape round-trip ok', impNS.ok === true)
    ok('written === 2', impNS.written === 2)

    // Bad format
    const bad = await h.importContent('id-1', 'oz', 'not valid json {{')
    ok('parse-failed', bad.ok === false)
    ok('reason parse-failed', bad.reason === 'parse-failed')

    // exportToFile + importFromFile
    const tmpFile = path.join(TEST_USERDATA, 'cookies.json')
    setCalls.length = 0
    const expF = await h.exportToFile('id-1', 'oz', tmpFile)
    ok('exportToFile ok', expF.ok === true)
    ok('file exists', fs.existsSync(tmpFile))
    const impF = await h.importFromFile('id-1', 'oz', tmpFile)
    ok('importFromFile ok', impF.ok === true)
    ok('written === 2', impF.written === 2)

    // ---- 1.7.0 header format — handler pass-through of options ----------
    setCalls.length = 0
    // 4th arg passes through to decode()
    const impH = await h.importContent('id-1', 'header', 'sid=abc123; csrf=xyz789', {
      defaultDomain: '.tiktok.com',
    })
    ok('header import ok', impH.ok === true)
    ok('header parsedCount === 2', impH.parsedCount === 2)
    ok('header written === 2', impH.written === 2)
    ok('setCalls captured 2', setCalls.length === 2)
    ok(
      'domain bound from option',
      setCalls[0].domain === '.tiktok.com' && setCalls[1].domain === '.tiktok.com',
    )
    ok('https url used (secure default)', setCalls[0].url.startsWith('https://'))

    // Missing defaultDomain → ok:false with explicit reason
    const impHbad = await h.importContent('id-1', 'header', 'sid=abc')
    ok('header w/o domain → ok:false', impHbad.ok === false)
    ok('reason missing-default-domain', impHbad.reason === 'missing-default-domain')

    // exportContent header
    setCalls.length = 0
    const expH = await h.exportContent('id-1', 'header')
    ok('header export ok', expH.ok === true)
    ok('header export content non-empty', expH.content.length > 0)
    ok('header export includes name=value', expH.content.includes('sid=abc123'))

    Module._load = originalLoad
    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures)
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      process.exit(1)
    }
    process.exit(0)
  })()
}
void _setRoundTripDone
