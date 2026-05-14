// OZ Browser — Logging redaction regression test (H-1).
//
// Cómo correr:
//   cd oz-browser && node tests/logging-redaction.smoketest.js
//
// Why: logs land on disk at ~/Library/Logs/oz-browser/oz-browser.log and stay
// there for weeks. The 4 sync paths below previously logged full records,
// which carry secrets after AES-GCM decrypt:
//   - identity records carry `fingerprintSeed` (anti-detection entropy)
//   - workspace records carry `tabSpecs` (full browsing URLs)
//   - bookmark records carry full URL collection
//   - remote-apply events carry the decoded body
//
// This test drives the invalid-input paths with sentinels and asserts they
// never appear in the logged output. Treat it as a tripwire — if anyone
// re-introduces a `{ record }` / `{ body }` / `{ evt }` log call, this fails.

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-h1-log-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  getName: () => 'OZ Browser Test',
  getVersion: () => '0.0.0-test',
  on() {},
  whenReady: () => Promise.resolve(),
}
const fakeElectron = { app: fakeApp }
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

// ---------- runner ----------
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
console.log('OZ Browser — H-1 logging redaction smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// ---------- Capture stdout/stderr ----------
//
// The OZ logger writes to both the log file AND console (via console.log /
// console.warn / console.error). Capturing those streams catches every log
// call — including the case where someone bypasses log.* and uses console
// directly.
let captured = ''
const _origLog = console.log
const _origWarn = console.warn
const _origErr = console.error
function startCapture() {
  captured = ''
  console.log = (...args) => {
    captured += args.join(' ') + '\n'
  }
  console.warn = (...args) => {
    captured += args.join(' ') + '\n'
  }
  console.error = (...args) => {
    captured += args.join(' ') + '\n'
  }
}
function stopCapture() {
  console.log = _origLog
  console.warn = _origWarn
  console.error = _origErr
}

// Sentinels — strings that should NEVER appear in logs.
const SENTINELS = {
  fingerprintSeed: 'FP-SEED-SENTINEL-9X7K2',
  tabSpecUrl: 'https://TAB-URL-SENTINEL.invalid/page',
  bookmarkUrl: 'https://BOOKMARK-URL-SENTINEL.invalid/page',
  bookmarkTitle: 'BOOKMARK-TITLE-SENTINEL',
}

function assertNoSentinels(label) {
  for (const [field, value] of Object.entries(SENTINELS)) {
    ok(
      `${label}: log does not contain ${field} sentinel`,
      !captured.includes(value),
      captured.length > 1000 ? captured.slice(0, 800) + '… (truncated)' : captured,
    )
  }
}

// ---------- Load modules under Electron stub ----------
for (const m of [
  '../browser/identity-manager.js',
  '../browser/workspace-manager.js',
  '../browser/bookmark-manager.js',
  '../browser/identity-manager-sync.js',
  '../browser/workspace-manager-sync.js',
  '../browser/bookmark-manager-sync.js',
  '../browser/logger.js',
]) {
  try {
    delete require.cache[require.resolve(m)]
  } catch (_) {
    /* ignore */
  }
}

const IM = require('../browser/identity-manager.js')
const WM = require('../browser/workspace-manager.js')
const BM = require('../browser/bookmark-manager.js')
const identitySync = require('../browser/identity-manager-sync.js')
const workspaceSync = require('../browser/workspace-manager-sync.js')
const bookmarkSync = require('../browser/bookmark-manager-sync.js')

// ============================================================
// Test 1 — identity-manager-sync.applyRemoteUpsert invalid-record path
// Drives the path that previously logged `{ record }` (full record).
// We pass a record without `id` so the function bails, AFTER setting the
// fingerprintSeed sentinel to ensure it would have been logged.
// ============================================================
section('identity-manager-sync.applyRemoteUpsert with invalid record')
{
  const im = new IM.IdentityManager()
  startCapture()
  // Missing `id` triggers the invalid-record path.
  const result = identitySync.applyRemoteUpsert(im, {
    fingerprintSeed: SENTINELS.fingerprintSeed,
    name: 'malformed',
    color: '#abcdef',
    // no `id` here — intentional
  })
  stopCapture()
  ok('returns null', result === null)
  assertNoSentinels('identity invalid record')
}

// ============================================================
// Test 2 — workspace-manager-sync.applyRemoteUpsert invalid-record path
// Previously logged `{ record }` including tabSpecs (URLs).
// ============================================================
section('workspace-manager-sync.applyRemoteUpsert with invalid record')
{
  const wm = new WM.WorkspaceManager({ dataDir: TEST_USERDATA })
  startCapture()
  const result = workspaceSync.applyRemoteUpsert(wm, {
    name: 'malformed',
    tabSpecs: [{ url: SENTINELS.tabSpecUrl, title: 'sentinel tab' }],
    // no `id` — invalid path
  })
  stopCapture()
  ok('returns null', result === null)
  assertNoSentinels('workspace invalid record')
}

// ============================================================
// Test 3 — bookmark-manager-sync.applyRemoteUpsert invalid-body path
// Previously logged `{ body }`. We pass a string (typeof !== 'object').
// The sentinel goes in via a primitive that JSON.stringify would print.
// ============================================================
section('bookmark-manager-sync.applyRemoteUpsert with invalid body')
{
  const bm = new BM.BookmarkManager({ dataDir: TEST_USERDATA })
  startCapture()
  // Pass a string — body is not an object, triggers invalid-body path.
  const result = bookmarkSync.applyRemoteUpsert(
    bm,
    `string with ${SENTINELS.bookmarkUrl} inside`,
  )
  stopCapture()
  ok('returns null', result === null)
  assertNoSentinels('bookmark invalid body')
}

// ============================================================
// Test 4 — sync-setup remote-apply unknown action path
// Previously logged `{ evt }` (full event including decoded body). Drive
// it by spinning up setupSync with stubs, then emitting on the real puller
// it exposes back to us.
// ============================================================
section('sync-setup remote-apply unknown action')
{
  process.env.OZ_TIER = 'paid'
  for (const m of [
    '../browser/identity-manager.js',
    '../browser/sync-queue.js',
    '../browser/sync-engine.js',
    '../browser/sync-pull.js',
    '../browser/sync-setup.js',
    '../browser/logger.js',
  ]) {
    delete require.cache[require.resolve(m)]
  }
  const { IdentityManager } = require('../browser/identity-manager.js')
  const { setupSync } = require('../browser/sync-setup.js')

  const im = new IdentityManager()
  const fakeVault = {
    isUnlocked: true,
    getMasterKey: () => Buffer.alloc(32),
  }
  const fakeDropbox = {
    isAuthenticated: () => true,
    async upload() {},
    async download() {
      const e = new Error('not_found')
      e.code = 'NOT_FOUND'
      throw e
    },
    async listFolder() {
      return { entries: [], cursor: 'c-1', hasMore: false }
    },
    async listFolderContinue() {
      return { entries: [], cursor: 'c-1', hasMore: false }
    },
    async delete() {},
  }

  const setup = setupSync({
    vault: fakeVault,
    dropbox: fakeDropbox,
    identityManager: im,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-h1test1',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  startCapture()
  // Emit an event with unknown action — hits the 'unknown action' log.
  setup.puller.emit('remote-apply', {
    action: 'mystery-action',
    recordType: 'identity',
    recordId: 'id-1',
    body: {
      id: 'id-1',
      fingerprintSeed: SENTINELS.fingerprintSeed,
      name: 'leaky',
    },
    header: {},
  })
  stopCapture()
  assertNoSentinels('sync-setup unknown action')
}

// ============================================================
// Output
// ============================================================
console.log(`\nPassed: ${passed}`)
console.log(`Failed: ${failed}`)
try {
  fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
} catch (_) {
  /* ignore */
}
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) {
    console.log(`  - ${f.label}`)
    if (f.detail) console.log(`    ${f.detail.slice(0, 400)}`)
  }
  process.exit(1)
}
