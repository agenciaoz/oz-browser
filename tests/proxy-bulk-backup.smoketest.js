// OZ Browser — proxy-bulk-backup smoke test (H-2 extras, v1.1.6).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-bulk-backup.smoketest.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const orig = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/proxy-bulk-backup.js')]
const { buildProxyBulkBackup, MAX_KEPT } = require('../browser/proxy-bulk-backup.js')

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

console.log('OZ Browser — proxy-bulk-backup smoke test')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-bbk-'))
const fakeProxyManager = {
  _list: [
    { id: 'p1', name: 'P1', host: 'a', port: 1 },
    { id: 'p2', name: 'P2', host: 'b', port: 2 },
  ],
  list() {
    return this._list
  },
}

// ============================================================================
console.log('\nfactory + snapshot happy')
// ============================================================================

const bk = buildProxyBulkBackup({
  proxyManager: fakeProxyManager,
  userDataDir: tmpDir,
})

ok(
  'factory throws without userDataDir',
  (() => {
    try {
      buildProxyBulkBackup({ proxyManager: fakeProxyManager })
      return false
    } catch (e) {
      return /userDataDir required/.test(e.message)
    }
  })(),
)

const snap = bk.snapshot({ reason: 'bulk-delete', ids: ['p1', 'p2'] })
ok('snapshot returns ok + path + count', snap.ok && snap.path && snap.count === 2)
ok('snapshot file exists', fs.existsSync(snap.path))
ok(
  'snapshot json has ts, reason, ids, proxies',
  (() => {
    const j = JSON.parse(fs.readFileSync(snap.path, 'utf-8'))
    return (
      j.ts &&
      j.reason === 'bulk-delete' &&
      Array.isArray(j.ids) &&
      j.ids.length === 2 &&
      Array.isArray(j.proxies) &&
      j.proxies.length === 2
    )
  })(),
)

// ============================================================================
console.log('\ndefensive guards')
// ============================================================================

const bkNoMgr = buildProxyBulkBackup({ userDataDir: tmpDir })
ok(
  'snapshot without proxyManager → ok:false NO_PROXY_MANAGER',
  bkNoMgr.snapshot({ reason: 'x' }).__error ||
    bkNoMgr.snapshot({ reason: 'x' }).reason === 'NO_PROXY_MANAGER',
)

// snapshot with proxyManager.list throwing → ok:false
const bkBroken = buildProxyBulkBackup({
  proxyManager: {
    list() {
      throw new Error('boom')
    },
  },
  userDataDir: tmpDir,
})
ok(
  'snapshot with broken proxyManager → ok:false (caught)',
  !bkBroken.snapshot({ reason: 'y' }).ok,
)

// ============================================================================
console.log('\nlist')
// ============================================================================

const list1 = bk.list()
ok('list has at least 1 entry', Array.isArray(list1) && list1.length >= 1)
ok(
  'list entry shape: ts, reason, count, idsCount, path',
  list1[0].ts &&
    typeof list1[0].reason === 'string' &&
    typeof list1[0].count === 'number' &&
    typeof list1[0].idsCount === 'number' &&
    list1[0].path,
)

// ============================================================================
console.log('\npruneOldBackups + MAX_KEPT')
// ============================================================================

// Take MAX_KEPT + 5 snapshots; verify list size caps at MAX_KEPT.
let counter = 0
const bkCount = buildProxyBulkBackup({
  proxyManager: fakeProxyManager,
  userDataDir: tmpDir,
  // monotonically increasing ts so sort works
  now: () => new Date(Date.now() + ++counter * 1000),
})
for (let i = 0; i < MAX_KEPT + 5; i++) {
  bkCount.snapshot({ reason: 'stress' })
}
const final = bkCount.list()
ok(`list capped at MAX_KEPT (${MAX_KEPT}) after over-creation`, final.length === MAX_KEPT)

// cleanup
try {
  for (const f of fs.readdirSync(path.join(tmpDir, 'proxy-bulk-backups'))) {
    fs.unlinkSync(path.join(tmpDir, 'proxy-bulk-backups', f))
  }
  fs.rmdirSync(path.join(tmpDir, 'proxy-bulk-backups'))
  fs.rmdirSync(tmpDir)
} catch (_err) {
  // ignore
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
