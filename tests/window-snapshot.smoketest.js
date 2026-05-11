// OZ Browser — window-snapshot smoke test (E2-C-2 fase 2).
//
// Cómo correr:
//   cd oz-browser
//   node tests/window-snapshot.smoketest.js
//
// Cubre:
//   - capture() builds payload from browser.windows
//   - capture() skips zombies (window.window.isDestroyed())
//   - read() returns null when missing/corrupt/wrong-version
//   - flush() writes only when changed (dedupe by serialized JSON minus capturedAt)
//   - flush() writes for every change after dedupe
//   - clear() removes the file (idempotent)
//   - startDaemon / stopDaemon idempotent
//   - constructor validation
//   - read() returns parsed payload after a write

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-wsnap-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
  getVersion: () => '0.1.0-test',
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

console.log('OZ Browser — window-snapshot smoke test')

delete require.cache[require.resolve('../browser/window-snapshot.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const {
  WindowSnapshot,
  SNAPSHOT_FILE,
  SCHEMA_VERSION,
} = require('../browser/window-snapshot.js')

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-wsnap-case-'))
}

// Helper: build a fake TabbedBrowserWindow with controllable state.
function fakeWin({
  workspaceId = 'general',
  bounds = { x: 100, y: 200, width: 1280, height: 720 },
  isMaximized = false,
  isFullScreen = false,
  destroyed = false,
} = {}) {
  return {
    workspaceId,
    window: {
      isDestroyed: () => destroyed,
      getBounds: () => bounds,
      isMaximized: () => isMaximized,
      isFullScreen: () => isFullScreen,
    },
  }
}

// ---- 1. exports + constants ------------------------------------------------
section('exports')
ok('WindowSnapshot is class', typeof WindowSnapshot === 'function')
ok('SNAPSHOT_FILE === "windows.json"', SNAPSHOT_FILE === 'windows.json')
ok('SCHEMA_VERSION === 1', SCHEMA_VERSION === 1)

// ---- 2. constructor validation --------------------------------------------
section('constructor validation')
{
  let threw1 = false
  try {
    new WindowSnapshot({ browser: { windows: [] } })
  } catch (_e) {
    threw1 = true
  }
  ok('throws without userDataDir', threw1 === true)

  let threw2 = false
  try {
    new WindowSnapshot({ userDataDir: '/tmp' })
  } catch (_e) {
    threw2 = true
  }
  ok('throws without browser', threw2 === true)
}

// ---- 3. capture from browser.windows ---------------------------------------
section('capture from windows')
{
  const dir = freshDir()
  const browser = {
    windows: [
      fakeWin({ workspaceId: 'general' }),
      fakeWin({
        workspaceId: 'marketing',
        bounds: { x: 50, y: 50, width: 800, height: 600 },
        isMaximized: true,
      }),
    ],
  }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  const snap = ws.capture()
  ok('snap.version === 1', snap.version === 1)
  ok('snap.windows.length === 2', snap.windows.length === 2)
  ok(
    'snap.capturedAt ISO',
    typeof snap.capturedAt === 'string' && /^\d{4}-/.test(snap.capturedAt),
  )
  ok('first entry workspaceId general', snap.windows[0].workspaceId === 'general')
  ok('first entry bounds.width 1280', snap.windows[0].bounds.width === 1280)
  ok('first entry isMaximized false', snap.windows[0].isMaximized === false)
  ok('second entry isMaximized true', snap.windows[1].isMaximized === true)
}

// ---- 4. capture skips zombies (destroyed BrowserWindows) ------------------
section('capture skips zombies')
{
  const dir = freshDir()
  const browser = {
    windows: [
      fakeWin({ workspaceId: 'a', destroyed: true }),
      fakeWin({ workspaceId: 'b' }),
      fakeWin({ workspaceId: 'c', destroyed: true }),
    ],
  }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  const snap = ws.capture()
  ok('only the live window included', snap.windows.length === 1)
  ok('included is workspace b', snap.windows[0].workspaceId === 'b')
}

// ---- 5. capture skips entries where window is undefined --------------------
section('capture defensive against null/undefined entries')
{
  const dir = freshDir()
  const browser = {
    windows: [null, undefined, fakeWin({ workspaceId: 'real' })],
  }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  const snap = ws.capture()
  ok('null/undefined entries skipped', snap.windows.length === 1)
  ok('only real one included', snap.windows[0].workspaceId === 'real')
}

// ---- 6. flush writes payload ----------------------------------------------
section('flush writes payload')
{
  const dir = freshDir()
  const browser = { windows: [fakeWin({ workspaceId: 'general' })] }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  const written = ws.flush()
  ok('flush returned snapshot', !!written)
  ok('file exists on disk', fs.existsSync(path.join(dir, 'windows.json')))
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'windows.json'), 'utf8'))
  ok('on-disk version === 1', onDisk.version === 1)
  ok('on-disk windows count === 1', onDisk.windows.length === 1)
}

// ---- 7. flush dedupes when nothing changed ---------------------------------
section('flush dedupes when state unchanged')
{
  const dir = freshDir()
  const browser = { windows: [fakeWin({ workspaceId: 'general' })] }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  const r1 = ws.flush()
  const r2 = ws.flush()
  const r3 = ws.flush()
  ok('first flush wrote', r1 !== null)
  ok('second flush dedupe (null)', r2 === null)
  ok('third flush dedupe (null)', r3 === null)
}

// ---- 8. flush writes again after state change ------------------------------
section('flush writes after state change')
{
  const dir = freshDir()
  const browser = { windows: [fakeWin({ workspaceId: 'general' })] }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  ws.flush()
  // Change state — close one + add another.
  browser.windows = [
    fakeWin({ workspaceId: 'general' }),
    fakeWin({ workspaceId: 'new-one' }),
  ]
  const r2 = ws.flush()
  ok('flush wrote after state change', r2 !== null)
  ok('windows count now 2', r2.windows.length === 2)

  // Same state again → dedupe
  const r3 = ws.flush()
  ok('subsequent flush dedupes again', r3 === null)
}

// ---- 9. read returns null when missing -------------------------------------
section('read missing file')
{
  const dir = freshDir()
  const ws = new WindowSnapshot({
    userDataDir: dir,
    browser: { windows: [] },
  })
  ok('read returns null', ws.read() === null)
}

// ---- 10. read returns null when JSON corrupt -------------------------------
section('read corrupt JSON')
{
  const dir = freshDir()
  fs.writeFileSync(path.join(dir, 'windows.json'), '{this is not json')
  const ws = new WindowSnapshot({
    userDataDir: dir,
    browser: { windows: [] },
  })
  ok('read returns null on parse error', ws.read() === null)
}

// ---- 11. read returns null when version mismatches -------------------------
section('read schema version mismatch')
{
  const dir = freshDir()
  fs.writeFileSync(
    path.join(dir, 'windows.json'),
    JSON.stringify({ version: 999, capturedAt: 'x', windows: [] }),
  )
  const ws = new WindowSnapshot({
    userDataDir: dir,
    browser: { windows: [] },
  })
  ok('read returns null on version mismatch', ws.read() === null)
}

// ---- 12. read returns null when windows is not array -----------------------
section('read malformed windows field')
{
  const dir = freshDir()
  fs.writeFileSync(
    path.join(dir, 'windows.json'),
    JSON.stringify({ version: 1, capturedAt: 'x', windows: 'not an array' }),
  )
  const ws = new WindowSnapshot({
    userDataDir: dir,
    browser: { windows: [] },
  })
  ok('read returns null on bad shape', ws.read() === null)
}

// ---- 13. read returns parsed payload after write ---------------------------
section('read returns parsed payload')
{
  const dir = freshDir()
  const browser = {
    windows: [
      fakeWin({ workspaceId: 'one' }),
      fakeWin({ workspaceId: 'two', isMaximized: true }),
    ],
  }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  ws.flush()
  const parsed = ws.read()
  ok('read returns object', !!parsed && typeof parsed === 'object')
  ok('parsed.version === 1', parsed.version === 1)
  ok('parsed.windows.length === 2', parsed.windows.length === 2)
  ok('parsed.windows[1].workspaceId === two', parsed.windows[1].workspaceId === 'two')
  ok('parsed.windows[1].isMaximized true', parsed.windows[1].isMaximized === true)
}

// ---- 14. clear removes the file (idempotent) -------------------------------
section('clear')
{
  const dir = freshDir()
  const browser = { windows: [fakeWin()] }
  const ws = new WindowSnapshot({ userDataDir: dir, browser })
  ws.flush()
  ok('file exists pre-clear', fs.existsSync(path.join(dir, 'windows.json')))
  ok('clear returned true', ws.clear() === true)
  ok('file removed', !fs.existsSync(path.join(dir, 'windows.json')))
  ok('second clear idempotent', ws.clear() === true)
}

// ---- 15. startDaemon + stopDaemon idempotent ------------------------------
async function runAsyncTests() {
  section('daemon lifecycle')
  {
    const dir = freshDir()
    const browser = { windows: [] }
    const ws = new WindowSnapshot({
      userDataDir: dir,
      browser,
      intervalMs: 50,
    })
    ws.startDaemon()
    ws.startDaemon() // idempotent — should not stack timers
    await new Promise((resolve) => setTimeout(resolve, 80))
    ws.stopDaemon()
    ws.stopDaemon() // idempotent
    ok('daemon ran without error', true)
    ok('stopDaemon ok', ws._timer === null)
  }

  // ---- 16. clear after daemon stop ----------------------------------------
  section('clear after daemon')
  {
    const dir = freshDir()
    const browser = { windows: [fakeWin()] }
    const ws = new WindowSnapshot({ userDataDir: dir, browser, intervalMs: 50 })
    ws.flush()
    ws.startDaemon()
    ws.stopDaemon()
    ok('clear works after daemon stop', ws.clear() === true)
  }
}

;(async () => {
  await runAsyncTests()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  Module._load = originalLoad
  process.exit(0)
})()
