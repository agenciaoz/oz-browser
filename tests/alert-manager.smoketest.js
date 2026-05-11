// OZ Browser — alert-manager smoke test (E2-C-5).
//
// Cómo correr:
//   cd oz-browser
//   node tests/alert-manager.smoketest.js
//
// Cubre:
//   - exports + constants
//   - constructor validation
//   - add() basic returns alert with id/ts populated
//   - add() defaults severity to 'info' if invalid
//   - add() skips when type missing
//   - add() emits broadcast 'oz:alerts:changed'
//   - list() defaults newest first
//   - list() filters: limit, type (string), type (array), unreadOnly, since
//   - markRead() returns boolean + emits broadcast on change
//   - markRead() idempotent (already read → returns true, no broadcast)
//   - markAllRead() returns count
//   - clear() returns count
//   - remove() returns boolean
//   - unreadCount() correct
//   - persistence round-trip after flush
//   - cap eviction at 500: non-urgent evicted first
//   - cap eviction: all-urgent fallback FIFO
//   - schema mismatch → starts fresh
//   - corrupt JSON → starts fresh

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-alert-'))
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

console.log('OZ Browser — alert-manager smoke test')

delete require.cache[require.resolve('../browser/alert-manager.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const {
  AlertManager,
  ALERT_FILE,
  SCHEMA_VERSION,
  MAX_ALERTS,
} = require('../browser/alert-manager.js')

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-alert-case-'))
}

// ---- 1. exports ------------------------------------------------------------
section('exports')
ok('AlertManager class', typeof AlertManager === 'function')
ok('ALERT_FILE === "alerts.json"', ALERT_FILE === 'alerts.json')
ok('SCHEMA_VERSION === 1', SCHEMA_VERSION === 1)
ok('MAX_ALERTS === 500', MAX_ALERTS === 500)

// ---- 2. constructor validation --------------------------------------------
section('constructor validation')
{
  let threw = false
  try {
    new AlertManager({})
  } catch (_e) {
    threw = true
  }
  ok('throws without userDataDir', threw === true)
}

// ---- 3. add() basic --------------------------------------------------------
section('add() basic')
{
  const dir = freshDir()
  const events = []
  const am = new AlertManager({
    userDataDir: dir,
    broadcast: (ch) => events.push(ch),
    saveDelayMs: 10,
  })
  const alert = am.add({
    type: 'anti-logout',
    severity: 'urgent',
    title: 'Account needs relogin',
    message: 'foo',
    identityId: 'id-x',
    action: { kind: 'open-modal', payload: { modal: 'accountManager' } },
  })
  ok('returned alert with id', !!alert && typeof alert.id === 'string')
  ok('id starts with "a-"', alert.id.startsWith('a-'))
  ok('ts is number', typeof alert.ts === 'number')
  ok('type preserved', alert.type === 'anti-logout')
  ok('severity preserved', alert.severity === 'urgent')
  ok('identityId preserved', alert.identityId === 'id-x')
  ok('action preserved', !!alert.action && alert.action.kind === 'open-modal')
  ok('read defaults to false', alert.read === false)
  ok('broadcast emitted oz:alerts:changed', events.includes('oz:alerts:changed'))
}

// ---- 4. add() defaults severity to info if invalid -----------------------
section('add() severity defaults')
{
  const dir = freshDir()
  const am = new AlertManager({ userDataDir: dir, saveDelayMs: 10 })
  const a1 = am.add({ type: 't', title: 'x' }) // no severity
  const a2 = am.add({ type: 't', title: 'x', severity: 'bogus' })
  ok('no severity → info', a1.severity === 'info')
  ok('invalid severity → info', a2.severity === 'info')
}

// ---- 5. add() skips when type missing ------------------------------------
section('add() defensive')
{
  const dir = freshDir()
  const am = new AlertManager({ userDataDir: dir, saveDelayMs: 10 })
  ok('add() with no type returns null', am.add({}) === null)
  ok('add() with empty type returns null', am.add({ type: '', title: 'x' }) === null)
  ok('add() with non-string type returns null', am.add({ type: 123 }) === null)
  ok('list() empty after defensive skips', am.list().length === 0)
}

// ---- 6. list() filters ---------------------------------------------------
section('list() filters')
{
  const dir = freshDir()
  let now = 1000
  const am = new AlertManager({
    userDataDir: dir,
    saveDelayMs: 10,
    clock: () => now,
  })
  am.add({ type: 'snapshot', severity: 'success', title: 'A' })
  now = 2000
  am.add({ type: 'anti-logout', severity: 'urgent', title: 'B' })
  now = 3000
  am.add({ type: 'snapshot', severity: 'success', title: 'C' })
  now = 4000
  am.add({ type: 'proxy-disabled', severity: 'urgent', title: 'D' })

  const all = am.list()
  ok('list() returns all 4', all.length === 4)
  ok('newest first (D)', all[0].title === 'D')
  ok('oldest last (A)', all[3].title === 'A')

  const limited = am.list({ limit: 2 })
  ok('limit=2 returns 2 newest', limited.length === 2 && limited[0].title === 'D')

  const snaps = am.list({ type: 'snapshot' })
  ok('type filter (string) works', snaps.length === 2)

  const urgent = am.list({ type: ['anti-logout', 'proxy-disabled'] })
  ok('type filter (array) works', urgent.length === 2)

  am.markRead(all[0].id) // mark D as read
  const unread = am.list({ unreadOnly: true })
  ok('unreadOnly excludes D', unread.length === 3 && unread[0].title === 'C')

  const recent = am.list({ since: 3000 })
  ok('since filter', recent.length === 2)
}

// ---- 7. markRead / markAllRead / clear / remove --------------------------
section('lifecycle ops')
{
  const dir = freshDir()
  const events = []
  const am = new AlertManager({
    userDataDir: dir,
    saveDelayMs: 10,
    broadcast: (ch) => events.push(ch),
  })
  const a1 = am.add({ type: 't', title: 'A' })
  const a2 = am.add({ type: 't', title: 'B' })
  events.length = 0

  ok('markRead returns true', am.markRead(a1.id) === true)
  ok('markRead emitted broadcast', events.includes('oz:alerts:changed'))
  events.length = 0
  ok('markRead already read returns true', am.markRead(a1.id) === true)
  ok('no broadcast on idempotent markRead', !events.includes('oz:alerts:changed'))

  ok('unreadCount === 1 (only B unread)', am.unreadCount() === 1)
  events.length = 0
  ok('markAllRead returns 1 (B)', am.markAllRead() === 1)
  ok('broadcast on markAllRead', events.includes('oz:alerts:changed'))
  ok('unreadCount === 0', am.unreadCount() === 0)

  ok('remove returns true for existing', am.remove(a1.id) === true)
  ok('remove returns false for missing', am.remove('nope') === false)
  ok('list().length === 1 after remove', am.list().length === 1)

  events.length = 0
  ok('clear returns 1', am.clear() === 1)
  ok('list empty after clear', am.list().length === 0)
  ok('clear emitted broadcast', events.includes('oz:alerts:changed'))
  ok('clear with no alerts returns 0', am.clear() === 0)
}

// ---- 8. persistence round-trip -------------------------------------------
section('persistence')
{
  const dir = freshDir()
  {
    const am = new AlertManager({ userDataDir: dir, saveDelayMs: 5 })
    am.add({ type: 'snapshot', severity: 'success', title: 'snap A' })
    am.add({ type: 'anti-logout', severity: 'urgent', title: 'login B' })
    am.flush()
  }
  // Re-instantiate from disk
  const am2 = new AlertManager({ userDataDir: dir, saveDelayMs: 5 })
  const list = am2.list()
  ok('persisted 2 alerts loaded', list.length === 2)
  ok('newest preserved (login B)', list[0].title === 'login B')
}

// ---- 9. cap eviction non-urgent first -----------------------------------
section('cap eviction')
{
  const dir = freshDir()
  const am = new AlertManager({ userDataDir: dir, saveDelayMs: 5 })
  // Add 1 urgent unread + 504 info → expect cap = 500, the 1 urgent must survive.
  am.add({ type: 'critical', severity: 'urgent', title: 'CRITICAL' })
  for (let i = 0; i < 504; i++) {
    am.add({ type: 'info', severity: 'info', title: `i${i}` })
  }
  ok('cap enforced (500 entries)', am.list().length === 500)
  const allTitles = am.list().map((a) => a.title)
  ok('urgent unread protected', allTitles.includes('CRITICAL'))
}

// ---- 10. cap eviction all-urgent fallback FIFO --------------------------
section('cap eviction all-urgent FIFO')
{
  const dir = freshDir()
  const am = new AlertManager({ userDataDir: dir, saveDelayMs: 5 })
  // 502 urgent → no non-urgent to evict, fallback FIFO drops oldest.
  for (let i = 0; i < 502; i++) {
    am.add({ type: 'critical', severity: 'urgent', title: `u${i}` })
  }
  ok('cap enforced (500)', am.list().length === 500)
  const titles = am.list().map((a) => a.title)
  ok('oldest u0 evicted', !titles.includes('u0'))
  ok('newest u501 present', titles.includes('u501'))
}

// ---- 11. schema mismatch → fresh ----------------------------------------
section('schema mismatch')
{
  const dir = freshDir()
  fs.writeFileSync(
    path.join(dir, 'alerts.json'),
    JSON.stringify({ version: 999, alerts: [{ id: 'old', title: 'x' }] }),
  )
  const am = new AlertManager({ userDataDir: dir, saveDelayMs: 5 })
  ok('mismatched version → empty list', am.list().length === 0)
}

// ---- 12. corrupt JSON → fresh -------------------------------------------
section('corrupt JSON')
{
  const dir = freshDir()
  fs.writeFileSync(path.join(dir, 'alerts.json'), '{not valid')
  const am = new AlertManager({ userDataDir: dir, saveDelayMs: 5 })
  ok('corrupt JSON → empty list', am.list().length === 0)
  // Subsequent adds still work
  const a = am.add({ type: 't', title: 'x' })
  ok('add still works after corrupt load', !!a)
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
