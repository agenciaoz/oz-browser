// OZ Browser — protocol-handler smoke test (B-1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/protocol-handler.smoketest.js
//
// Cubre:
//   - URL parsing pattern oz://auth/<provider>/callback?code=...
//   - Dispatcher registration + resolution (prefix match)
//   - handleProtocolUrl dispatches to matching callback
//   - Most-specific prefix wins
//   - Unknown protocol / unknown namespace return structured errors
//   - Callback throwing doesn't crash the dispatcher
//
// Approach: mismo patrón que otros smoketests — fake Electron via Module._load
// hook. NO requiere Electron real porque protocol-handler.js depende solo de
// `electron.app` para los listeners + ese mock está aislado.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-proto-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  _onUrl: null,
  _onSecondInstance: null,
  isPackaged: false,
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  setAsDefaultProtocolClient: () => true,
  requestSingleInstanceLock: () => true,
  on: function (event, handler) {
    if (event === 'open-url') this._onUrl = handler
    if (event === 'second-instance') this._onSecondInstance = handler
  },
  quit: () => {},
}

const fakeElectron = { app: fakeApp }

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

console.log('OZ Browser — protocol-handler smoke test')

delete require.cache[require.resolve('../browser/protocol-handler.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const ph = require('../browser/protocol-handler.js')

// ---- 1. PROTOCOL constant + exports -----------------------------------------
section('exports')
ok('PROTOCOL === "oz"', ph.PROTOCOL === 'oz')
ok('installProtocolHandler is function', typeof ph.installProtocolHandler === 'function')
ok(
  'registerProtocolDispatch is function',
  typeof ph.registerProtocolDispatch === 'function',
)
ok('handleProtocolUrl is function', typeof ph.handleProtocolUrl === 'function')

// ---- 2. Dispatcher registration ---------------------------------------------
section('dispatcher registration')
const calls = []
const unregister = ph.registerProtocolDispatch({}, 'auth/dropbox', (browser, info) => {
  calls.push({ kind: 'auth/dropbox', info })
})
ok('register returns unregister fn', typeof unregister === 'function')
ok('dispatcher in registry', ph._internals.dispatchers.has('auth/dropbox'))

// ---- 3. handleProtocolUrl basic dispatch -----------------------------------
section('handleProtocolUrl: dispatches by exact path')
{
  calls.length = 0
  const r = ph.handleProtocolUrl(
    { fake: 'browser' },
    'oz://auth/dropbox/callback?code=ABC&state=XYZ',
  )
  ok('ok=true', r.ok === true)
  ok('matched dispatcher key', r.dispatcher === 'auth/dropbox')
  ok('callback invoked once', calls.length === 1)
  ok('callback received query.code', calls[0].info.query.code === 'ABC')
  ok('callback received query.state', calls[0].info.query.state === 'XYZ')
  ok('callback received host=auth', calls[0].info.host === 'auth')
  ok(
    'callback received pathSegments=[dropbox, callback]',
    calls[0].info.pathSegments.join(',') === 'dropbox,callback',
  )
  ok('callback received raw URL', calls[0].info.raw.startsWith('oz://auth/dropbox/'))
}

// ---- 4. Prefix matching (most-specific wins) -------------------------------
section('prefix matching: most-specific dispatcher wins')
{
  const specificCalls = []
  ph.registerProtocolDispatch({}, 'auth', (b, info) => {
    specificCalls.push({ scope: 'auth', info })
  })
  ph.registerProtocolDispatch({}, 'auth/dropbox/callback', (b, info) => {
    specificCalls.push({ scope: 'auth/dropbox/callback', info })
  })
  const r = ph.handleProtocolUrl({}, 'oz://auth/dropbox/callback?x=1')
  ok('dispatcher === most-specific', r.dispatcher === 'auth/dropbox/callback')
  ok(
    'only most-specific fired',
    specificCalls.length === 1 && specificCalls[0].scope === 'auth/dropbox/callback',
  )

  // Different path falls back to broader prefix
  const r2 = ph.handleProtocolUrl({}, 'oz://auth/google/callback')
  ok('falls back to auth prefix', r2.dispatcher === 'auth')
  // Cleanup
  ph._internals.dispatchers.delete('auth/dropbox/callback')
  ph._internals.dispatchers.delete('auth')
}

// ---- 5. Unknown namespace ---------------------------------------------------
section('unknown namespace returns no-dispatcher')
{
  const r = ph.handleProtocolUrl({}, 'oz://nope/totally/missing')
  ok('ok=false', r.ok === false)
  ok('reason=no-dispatcher', r.reason === 'no-dispatcher')
  ok('reports pathKey', r.pathKey === 'nope/totally/missing')
}

// ---- 6. Wrong protocol ------------------------------------------------------
section('wrong protocol returns wrong-protocol')
{
  const r = ph.handleProtocolUrl({}, 'https://example.com/auth/dropbox/callback')
  ok('ok=false', r.ok === false)
  ok('reason=wrong-protocol', r.reason === 'wrong-protocol')
  ok('reports actual protocol', r.protocol === 'https:')
}

// ---- 7. Malformed URL -------------------------------------------------------
section('malformed URL returns parse-failed')
{
  const r = ph.handleProtocolUrl({}, 'not-even-a-url')
  ok('ok=false', r.ok === false)
  ok('reason=parse-failed', r.reason === 'parse-failed')
}

// ---- 8. Invalid args --------------------------------------------------------
section('invalid args return invalid-url')
{
  const r1 = ph.handleProtocolUrl({}, null)
  ok('null url → invalid-url', r1.ok === false && r1.reason === 'invalid-url')
  const r2 = ph.handleProtocolUrl({}, '')
  ok('empty url → invalid-url', r2.ok === false && r2.reason === 'invalid-url')
  const r3 = ph.handleProtocolUrl({}, 12345)
  ok('non-string url → invalid-url', r3.ok === false && r3.reason === 'invalid-url')
}

// ---- 9. Callback throwing doesn't propagate --------------------------------
section('callback throwing is caught')
{
  ph.registerProtocolDispatch({}, 'crash/me', () => {
    throw new Error('boom')
  })
  const r = ph.handleProtocolUrl({}, 'oz://crash/me')
  ok('ok=false', r.ok === false)
  ok('reason=dispatcher-error', r.reason === 'dispatcher-error')
  ok('message preserved', r.message === 'boom')
  ph._internals.dispatchers.delete('crash/me')
}

// ---- 10. unregister works ---------------------------------------------------
section('unregister removes dispatcher')
{
  const before = ph._internals.dispatchers.has('auth/dropbox')
  unregister()
  const after = ph._internals.dispatchers.has('auth/dropbox')
  ok('was registered before', before === true)
  ok('removed after unregister', after === false)
}

// ---- 11. installProtocolHandler wires app.on('open-url') -------------------
section('installProtocolHandler wires listeners + dispatches to fake app')
{
  fakeApp._onUrl = null
  fakeApp._onSecondInstance = null
  ph.installProtocolHandler({ fake: 'browser' })
  ok('open-url listener installed', typeof fakeApp._onUrl === 'function')
  ok(
    'second-instance NOT installed in dev (isPackaged=false)',
    fakeApp._onSecondInstance === null,
  )

  // Now register a dispatcher + fire the open-url listener manually.
  const fired = []
  ph.registerProtocolDispatch({}, 'team/invite', (b, info) => {
    fired.push(info)
  })
  let prevented = false
  const fakeEvent = {
    preventDefault: () => {
      prevented = true
    },
  }
  fakeApp._onUrl(fakeEvent, 'oz://team/invite?token=abc')
  ok('preventDefault called', prevented === true)
  ok('dispatcher fired via open-url path', fired.length === 1)
  ok('payload token === abc', fired[0].query.token === 'abc')
  ph._internals.dispatchers.delete('team/invite')
}

// ---- 12. installProtocolHandler in packaged mode wires single-instance -----
section('installProtocolHandler packaged: second-instance listener wired')
{
  fakeApp.isPackaged = true
  fakeApp._onUrl = null
  fakeApp._onSecondInstance = null
  ph.installProtocolHandler({ fake: 'browser', windows: [] })
  ok(
    'second-instance listener installed',
    typeof fakeApp._onSecondInstance === 'function',
  )

  // Simulate Windows OS launching another instance with oz:// arg
  const sndFired = []
  ph.registerProtocolDispatch({}, 'auth/supabase', (b, info) => {
    sndFired.push(info)
  })
  fakeApp._onSecondInstance({}, [
    '/Applications/OZ.app/Contents/MacOS/oz',
    'oz://auth/supabase/callback?code=zzz',
  ])
  ok('dispatcher fired via second-instance path', sndFired.length === 1)
  ok('payload code === zzz', sndFired[0].query.code === 'zzz')
  fakeApp.isPackaged = false
  ph._internals.dispatchers.delete('auth/supabase')
}

// ---- Cleanup ---------------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
