// OZ Browser — crash-detector smoke test (E2-C-2 fase 1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/crash-detector.smoketest.js
//
// Cubre:
//   - clean boot (no lockfile previo) → wasCrashed=false
//   - lockfile previo + PID muerto → wasCrashed=true
//   - lockfile previo + PID vivo + distinto al actual → multiInstance=true (NO crash, NO sobrescribe)
//   - lockfile previo con JSON corrupto → wasCrashed=true
//   - lockfile previo con PID inválido (NaN/0/negative) → wasCrashed=true
//   - markCleanShutdown() borra lockfile
//   - markCleanShutdown() idempotente (puede llamarse 2 veces sin error)
//   - init() idempotente (segundo llamado retorna mismo resultado)
//   - lockfile escrito tiene la shape esperada (pid, startedAt, ozVersion)

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-crash-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
  getVersion: () => '0.1.0-test',
  isPackaged: false,
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

console.log('OZ Browser — crash-detector smoke test')

delete require.cache[require.resolve('../browser/crash-detector.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const { CrashDetector, LOCKFILE_NAME } = require('../browser/crash-detector.js')

// Helper: create a fresh tmpdir per test for isolation.
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-crash-case-'))
}

// ---- 1. exports + constants -------------------------------------------------
section('exports')
ok('CrashDetector is class', typeof CrashDetector === 'function')
ok('LOCKFILE_NAME === "running.lock"', LOCKFILE_NAME === 'running.lock')

// ---- 2. clean boot (no prior lockfile) -------------------------------------
section('clean boot')
{
  const dir = freshDir()
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: () => false,
  })
  const result = cd.init()
  ok('wasCrashed === false', result.wasCrashed === false)
  ok('multiInstance === false', result.multiInstance === false)
  ok('prior === null', result.prior === null)
  ok('lockfile created', fs.existsSync(path.join(dir, 'running.lock')))
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'running.lock'), 'utf8'))
  ok('lockfile has pid', written.pid === process.pid)
  ok('lockfile has startedAt ISO', /^\d{4}-\d{2}-\d{2}T/.test(written.startedAt))
  ok('lockfile has ozVersion', written.ozVersion === '0.1.0')
}

// ---- 3. crash detection — lockfile + PID dead ------------------------------
section('crash detection: PID dead')
{
  const dir = freshDir()
  // Pre-write a lockfile with a fake "previous" PID (we'll mock it as dead).
  fs.writeFileSync(
    path.join(dir, 'running.lock'),
    JSON.stringify({ pid: 99999, startedAt: '2025-01-01T00:00:00Z', ozVersion: '0.0.9' }),
  )
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: (pid) => pid === process.pid, // only OUR pid is alive; 99999 = dead
  })
  const result = cd.init()
  ok('wasCrashed === true', result.wasCrashed === true)
  ok('multiInstance === false', result.multiInstance === false)
  ok('prior captured', result.prior && result.prior.pid === 99999)
  ok('prior.ozVersion === 0.0.9', result.prior.ozVersion === '0.0.9')
  // New lockfile written with our PID
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'running.lock'), 'utf8'))
  ok('lockfile rewritten with current pid', written.pid === process.pid)
}

// ---- 4. multi-instance — lockfile + PID alive (different from ours) -------
section('multi-instance: PID alive')
{
  const dir = freshDir()
  fs.writeFileSync(
    path.join(dir, 'running.lock'),
    JSON.stringify({ pid: 12345, startedAt: '2025-01-01T00:00:00Z', ozVersion: '0.0.9' }),
  )
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: (pid) => pid === 12345, // pretend 12345 is the live sibling
  })
  const result = cd.init()
  ok('wasCrashed === false', result.wasCrashed === false)
  ok('multiInstance === true', result.multiInstance === true)
  // CRITICAL: lockfile must NOT be overwritten — the live sibling owns it.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'running.lock'), 'utf8'))
  ok('lockfile preserved (not overwritten)', onDisk.pid === 12345)
}

// ---- 5. corrupt JSON in lockfile -------------------------------------------
section('corrupt lockfile JSON')
{
  const dir = freshDir()
  fs.writeFileSync(path.join(dir, 'running.lock'), '{not valid json')
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: () => false,
  })
  const result = cd.init()
  ok('wasCrashed === true', result.wasCrashed === true)
  // Lockfile rewritten cleanly with current PID
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'running.lock'), 'utf8'))
  ok('lockfile rewritten with valid JSON', written.pid === process.pid)
}

// ---- 6. invalid PID values (negative, zero, NaN) ---------------------------
section('invalid prior PID values')
{
  const cases = [
    { pid: -1, label: 'negative' },
    { pid: 0, label: 'zero' },
    { pid: 'abc', label: 'string' },
    { pid: null, label: 'null' },
  ]
  for (const c of cases) {
    const dir = freshDir()
    fs.writeFileSync(
      path.join(dir, 'running.lock'),
      JSON.stringify({ pid: c.pid, startedAt: 'x', ozVersion: 'y' }),
    )
    const cd = new CrashDetector({
      userDataDir: dir,
      ozVersion: '0.1.0',
      procIsAlive: () => false,
    })
    const result = cd.init()
    ok(`pid=${c.label} → wasCrashed=true`, result.wasCrashed === true)
  }
}

// ---- 7. markCleanShutdown removes lockfile ---------------------------------
section('markCleanShutdown')
{
  const dir = freshDir()
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: () => false,
  })
  cd.init()
  ok('lockfile exists pre-shutdown', fs.existsSync(path.join(dir, 'running.lock')))
  const ok1 = cd.markCleanShutdown()
  ok('markCleanShutdown returns true', ok1 === true)
  ok('lockfile removed', !fs.existsSync(path.join(dir, 'running.lock')))
  // Idempotent — calling twice should still return true.
  const ok2 = cd.markCleanShutdown()
  ok('second markCleanShutdown idempotent (true)', ok2 === true)
}

// ---- 8. wasCrashed() / isMultiInstance() getters ---------------------------
section('getters')
{
  const dir = freshDir()
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: () => false,
  })
  ok('wasCrashed() before init === false', cd.wasCrashed() === false)
  ok('isMultiInstance() before init === false', cd.isMultiInstance() === false)
  cd.init()
  ok('wasCrashed() after clean init === false', cd.wasCrashed() === false)
}

// ---- 9. init() idempotent (second call returns same result) ---------------
section('init idempotent')
{
  const dir = freshDir()
  fs.writeFileSync(
    path.join(dir, 'running.lock'),
    JSON.stringify({ pid: 99999, startedAt: 'x', ozVersion: 'y' }),
  )
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: () => false,
  })
  const r1 = cd.init()
  const r2 = cd.init()
  ok('second init wasCrashed identical', r1.wasCrashed === r2.wasCrashed)
  ok('second init multiInstance identical', r1.multiInstance === r2.multiInstance)
}

// ---- 10. constructor validation -------------------------------------------
section('constructor validation')
{
  let threw = false
  try {
    new CrashDetector({})
  } catch (_e) {
    threw = true
  }
  ok('throws without userDataDir', threw === true)
}

// ---- 11. lockfile in non-existent dir → directory created ------------------
section('userDataDir auto-created')
{
  const parent = freshDir()
  const child = path.join(parent, 'sub', 'nested')
  // child doesn't exist yet
  ok('child dir does NOT exist before init', !fs.existsSync(child))
  const cd = new CrashDetector({
    userDataDir: child,
    ozVersion: '0.1.0',
    procIsAlive: () => false,
  })
  cd.init()
  ok('child dir created', fs.existsSync(child))
  ok('lockfile in child', fs.existsSync(path.join(child, 'running.lock')))
}

// ---- 12. PID equal to current process → treated as stale (not crash) -------
section('prior PID equals current PID')
{
  const dir = freshDir()
  fs.writeFileSync(
    path.join(dir, 'running.lock'),
    JSON.stringify({ pid: process.pid, startedAt: 'x', ozVersion: 'y' }),
  )
  const cd = new CrashDetector({
    userDataDir: dir,
    ozVersion: '0.1.0',
    procIsAlive: (pid) => pid === process.pid,
  })
  const result = cd.init()
  // Same-PID is treated as stale (NOT crashed, NOT multi-instance) because
  // it cannot represent a real concurrent run from this exact process.
  ok('same PID → wasCrashed=false', result.wasCrashed === false)
  ok('same PID → multiInstance=false', result.multiInstance === false)
}

// ---- summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
Module._load = originalLoad
process.exit(0)
