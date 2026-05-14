// OZ Browser — Performance baseline + soft-threshold tripwires (H-4).
//
// Cómo correr:
//   cd oz-browser && node tests/perf-baseline.smoketest.js
//
// What this measures (synthetic state — N=50 identities, N=10 workspaces,
// N=500 bookmarks, N=500 vault accounts):
//   - IdentityManager._load() — boot path
//   - WorkspaceManager._load()
//   - BookmarkManager._load()
//   - Vault.unlock() — heaviest: 500-account AES-GCM decrypt
//   - BackupManager.createSnapshot() — flat-pack + gzip + AES-GCM
//
// Soft thresholds (intentionally loose — these are tripwires for 10x
// regressions, NOT SLO checks). The hard SLOs live in
// docs/PLAN-MAESTRO.md §0.5. Numbers measured on Jose's M2 Mac:
//   Manager load (50 identities):   ~5ms   → threshold 250ms
//   Vault unlock (500 accounts):    ~15ms  → threshold 500ms
//   Snapshot create (full state):   ~25ms  → threshold 1000ms
//
// Output: at the bottom, a table row to paste into docs/BENCHMARKS.md.

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-h4-perf-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (k) => (k === 'logs' ? TEST_LOGS : TEST_USERDATA),
  getName: () => 'OZ Browser Test',
  getVersion: () => '0.0.0-test',
  on() {},
  whenReady: () => Promise.resolve(),
}
Module._load = ((orig) =>
  function (request, ...rest) {
    if (request === 'electron') return { app: fakeApp }
    return orig.call(this, request, ...rest)
  })(Module._load)

process.env.OZ_TIER = 'paid'

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

console.log('OZ Browser — H-4 perf baseline smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)
console.log(`Node: ${process.version}  Platform: ${process.platform} ${process.arch}`)

// ---------- Mock Keychain ----------
function makeMockKeychain() {
  const store = new Map()
  return {
    getPassword: (s, a) => store.get(`${s}:${a}`) || null,
    setPassword: (s, a, p) => store.set(`${s}:${a}`, p),
    deletePassword: (s, a) => store.delete(`${s}:${a}`),
  }
}

// ---------- timing helper ----------
function timeMs(label, fn) {
  const start = process.hrtime.bigint()
  const out = fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  console.log(`    ${label}: ${ms.toFixed(2)}ms`)
  return { ms, out }
}
async function timeMsAsync(label, fn) {
  const start = process.hrtime.bigint()
  const out = await fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  console.log(`    ${label}: ${ms.toFixed(2)}ms`)
  return { ms, out }
}

// ---------- modules ----------
function freshModules() {
  for (const m of [
    '../browser/identity-manager.js',
    '../browser/workspace-manager.js',
    '../browser/bookmark-manager.js',
    '../browser/account-vault.js',
    '../browser/backup-manager.js',
    '../browser/logger.js',
  ]) {
    delete require.cache[require.resolve(m)]
  }
  return {
    IM: require('../browser/identity-manager.js'),
    WM: require('../browser/workspace-manager.js'),
    BM: require('../browser/bookmark-manager.js'),
    AV: require('../browser/account-vault.js'),
    BK: require('../browser/backup-manager.js'),
  }
}

// ---------- Phase 1 — Generate synthetic state on disk ----------
section(
  'Phase 1 — generate synthetic state (50 identities, 10 workspaces, 500 bookmarks, 500 vault accounts)',
)

const N_IDENTITIES = 50
const N_WORKSPACES = 10
const N_TABS_PER_WS = 5
const N_BOOKMARKS = 500
const N_ACCOUNTS = 500

const synthIdentities = []
synthIdentities.push({
  id: 'default',
  name: 'Default',
  color: '#8a8a8a',
  fingerprintSeed: 'default-seed',
  createdAt: Date.now(),
  updatedAt: new Date().toISOString(),
  isDefault: true,
  locked: false,
  workspaceId: 'general',
})
for (let i = 0; i < N_IDENTITIES; i++) {
  synthIdentities.push({
    id: `id-${i.toString().padStart(3, '0')}`,
    name: `Identity ${i}`,
    color: `#${(i * 0x102030).toString(16).slice(0, 6).padEnd(6, '0')}`,
    fingerprintSeed: `seed-${i}`,
    createdAt: Date.now(),
    updatedAt: new Date().toISOString(),
    isDefault: false,
    locked: false,
    workspaceId: 'general',
  })
}
fs.writeFileSync(
  path.join(TEST_USERDATA, 'identities.json'),
  JSON.stringify(synthIdentities, null, 2),
)

const synthWorkspaces = []
synthWorkspaces.push({
  id: 'general',
  name: 'General Browsing',
  color: '#8a8a8a',
  isDefault: true,
  isArchived: false,
  isFrozen: false,
  quickTabsMode: 'on-click',
  createdAt: Date.now(),
  updatedAt: new Date().toISOString(),
  tabSpecs: [],
  activeTabId: null,
  identityIds: ['default'],
})
for (let w = 0; w < N_WORKSPACES; w++) {
  const tabSpecs = []
  for (let t = 0; t < N_TABS_PER_WS; t++) {
    tabSpecs.push({
      id: `tab-${w}-${t}`,
      url: `https://example.com/ws${w}/tab${t}`,
      title: `Tab ${t}`,
      identityId: `id-${(w * 5 + t).toString().padStart(3, '0')}`,
    })
  }
  synthWorkspaces.push({
    id: `ws-${w}`,
    name: `Workspace ${w}`,
    color: '#5b8def',
    isDefault: false,
    isArchived: false,
    isFrozen: false,
    quickTabsMode: 'on-click',
    createdAt: Date.now(),
    updatedAt: new Date().toISOString(),
    tabSpecs,
    activeTabId: tabSpecs[0].id,
    identityIds: tabSpecs.map((t) => t.identityId),
  })
}
fs.writeFileSync(
  path.join(TEST_USERDATA, 'workspaces.json'),
  JSON.stringify(synthWorkspaces, null, 2),
)

const synthBookmarks = []
for (let b = 0; b < N_BOOKMARKS; b++) {
  synthBookmarks.push({
    id: `bk-${b}`,
    identityId: `id-${(b % N_IDENTITIES).toString().padStart(3, '0')}`,
    url: `https://example.com/page/${b}`,
    title: `Bookmark ${b}`,
    favicon: null,
    addedAt: Date.now(),
  })
}
fs.writeFileSync(
  path.join(TEST_USERDATA, 'bookmarks.json'),
  JSON.stringify(synthBookmarks, null, 2),
)

console.log(
  `    Wrote identities.json (${fs.statSync(path.join(TEST_USERDATA, 'identities.json')).size} bytes)`,
)
console.log(
  `    Wrote workspaces.json (${fs.statSync(path.join(TEST_USERDATA, 'workspaces.json')).size} bytes)`,
)
console.log(
  `    Wrote bookmarks.json (${fs.statSync(path.join(TEST_USERDATA, 'bookmarks.json')).size} bytes)`,
)

// ---------- Phase 2 — Measure cold-load of each manager ----------
async function main() {
  section('Phase 2 — measure cold-load')
  const mods = freshModules()

  const tIM = timeMs(
    'IdentityManager constructor (cold)',
    () => new mods.IM.IdentityManager(),
  )
  ok('IM loaded 51 identities', tIM.out.list().length === 51)
  ok(
    'IM cold load < 250ms (50 identities)',
    tIM.ms < 250,
    `actual ${tIM.ms.toFixed(2)}ms`,
  )

  const tWM = timeMs(
    'WorkspaceManager constructor (cold)',
    () => new mods.WM.WorkspaceManager({ dataDir: TEST_USERDATA }),
  )
  ok('WM loaded 11 workspaces', tWM.out.list().length === 11)
  ok(
    'WM cold load < 250ms (10 ws × 5 tabs)',
    tWM.ms < 250,
    `actual ${tWM.ms.toFixed(2)}ms`,
  )

  const tBM = timeMs(
    'BookmarkManager constructor (cold)',
    () => new mods.BM.BookmarkManager({ dataDir: TEST_USERDATA }),
  )
  ok('BM loaded 500 bookmarks', tBM.out.list().length === 500)
  ok(
    'BM cold load < 250ms (500 bookmarks)',
    tBM.ms < 250,
    `actual ${tBM.ms.toFixed(2)}ms`,
  )

  // ---------- Phase 3 — Vault unlock with 500 accounts ----------
  section('Phase 3 — vault unlock with 500 accounts')
  const keychain = makeMockKeychain()
  // Seed vault: create with 0 accounts, then setAccounts with 500.
  const seedVault = new mods.AV.Vault({
    keychain,
    dataDir: path.join(TEST_USERDATA, 'data'),
  })
  await seedVault.unlock()
  const synthAccounts = []
  for (let a = 0; a < N_ACCOUNTS; a++) {
    synthAccounts.push({
      id: `acc-${a}`,
      identityId: `id-${(a % N_IDENTITIES).toString().padStart(3, '0')}`,
      site: `https://site${a}.com`,
      username: `user${a}@example.com`,
      password: `Password${a}!_strong_enough_for_realism`,
      totpSecret: a % 5 === 0 ? `JBSWY3DPEHPK3PXP-${a}` : null,
    })
  }
  seedVault.setAccounts(synthAccounts)
  seedVault.lock()

  // Now measure the cold unlock.
  delete require.cache[require.resolve('../browser/account-vault.js')]
  const AV2 = require('../browser/account-vault.js')
  const v = new AV2.Vault({ keychain, dataDir: path.join(TEST_USERDATA, 'data') })
  const tUnlock = await timeMsAsync('Vault.unlock() (500 accounts)', () => v.unlock())
  ok('vault has 500 accounts after unlock', v.getAccounts().length === 500)
  ok(
    'Vault unlock < 500ms (500 accounts)',
    tUnlock.ms < 500,
    `actual ${tUnlock.ms.toFixed(2)}ms`,
  )

  // ---------- Phase 4 — Snapshot of full state ----------
  section('Phase 4 — backup snapshot of full state')
  const backup = new mods.BK.BackupManager({
    userDataDir: TEST_USERDATA,
    vault: v,
    appVersion: '0.0.0-test',
  })
  const tSnap = timeMs('createSnapshot() (full state)', () =>
    backup.createSnapshot({ reason: 'perf-baseline' }),
  )
  ok('snapshot ok', !!tSnap.out.id)
  ok(
    'snapshot create < 1000ms (full state)',
    tSnap.ms < 1000,
    `actual ${tSnap.ms.toFixed(2)}ms`,
  )

  // ---------- Phase 5 — Baseline table row ----------
  section('Phase 5 — baseline table (paste into docs/BENCHMARKS.md)')
  const today = new Date().toISOString().slice(0, 10)
  console.log(
    `\n| ${today} | H-4 perf-baseline | ${process.platform}/${process.arch} | ` +
      `IM:${tIM.ms.toFixed(1)}ms WM:${tWM.ms.toFixed(1)}ms BM:${tBM.ms.toFixed(1)}ms ` +
      `Unlock:${tUnlock.ms.toFixed(1)}ms Snap:${tSnap.ms.toFixed(1)}ms ` +
      `(50id/10ws/500bk/500acc) |`,
  )

  // ---------- Cleanup ----------
  try {
    fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
  } catch (_) {
    /* ignore */
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' (' + f.detail + ')' : ''}`)
    }
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('UNCAUGHT:', e.stack || e.message)
  process.exit(1)
})
