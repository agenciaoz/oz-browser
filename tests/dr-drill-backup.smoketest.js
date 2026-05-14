// OZ Browser — Disaster Recovery drill (backup-based) — H-3.
//
// Cómo correr:
//   cd oz-browser && node tests/dr-drill-backup.smoketest.js
//
// Simulates the "Mac dies, restore from .ozbackup" path:
//   1. Build state with real OZ managers (3 identities, 2 workspaces, 3
//      bookmarks, 2 vault accounts, fingerprints + proxy-assignment files).
//   2. backupManager.createSnapshot — writes .ozbackup to data/snapshots/.
//   3. Capture file contents pre-wipe for later comparison.
//   4. WIPE userData (preserve only the snapshot file + Keychain).
//   5. Verify managers re-instantiated post-wipe see no state.
//   6. Restore from snapshot (same Keychain key — simulating user using
//      same macOS account on new Mac).
//   7. Re-instantiate managers post-restore — assert ALL state recovered.
//
// This catches: silently-missing file types in backup scope, Keychain
// re-binding issues, atomic restore correctness.
//
// What's NOT covered (intentional):
//   - Cookies (live in Partitions/ — backed up via _walkSync; test fixture
//     skips this for simplicity, but the codepath is the same).
//   - Multi-device sync recovery (that's H-2, the sync-based DR drill).
//   - Cloud upload of the backup (that's D-1 cloud-backup.smoketest).

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-h3-dr-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  getName: () => 'OZ Browser Test',
  getVersion: () => '0.0.0-test',
  on() {},
  whenReady: () => Promise.resolve(),
}
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return { app: fakeApp }
  return originalLoad.call(this, request, parent, ...rest)
}

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
console.log('OZ Browser — H-3 DR drill (backup-based) smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// ---------- Mock Keychain shared across re-instantiations ----------
//
// CRITICAL to the DR scenario: the same Keychain entry must survive the
// userData wipe. macOS Keychain is independent of ~/Library/Application
// Support — that's the whole point of the design. Our mock mirrors this:
// the keychain instance lives outside the directory we wipe.
function makeMockKeychain() {
  const store = new Map()
  return {
    _store: store,
    getPassword: (s, a) => store.get(`${s}:${a}`) || null,
    setPassword: (s, a, p) => store.set(`${s}:${a}`, p),
    deletePassword: (s, a) => store.delete(`${s}:${a}`),
  }
}
const SHARED_KEYCHAIN = makeMockKeychain()

// ---------- Helpers ----------
function freshModules() {
  for (const m of [
    '../browser/identity-manager.js',
    '../browser/workspace-manager.js',
    '../browser/bookmark-manager.js',
    '../browser/account-vault.js',
    '../browser/backup-manager.js',
    '../browser/logger.js',
  ]) {
    try {
      delete require.cache[require.resolve(m)]
    } catch (_) {
      /* ignore */
    }
  }
  return {
    IM: require('../browser/identity-manager.js'),
    WM: require('../browser/workspace-manager.js'),
    BM: require('../browser/bookmark-manager.js'),
    AV: require('../browser/account-vault.js'),
    BK: require('../browser/backup-manager.js'),
  }
}

function wipeUserData(preserveSnapshotsDir) {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    const full = path.join(TEST_USERDATA, f)
    if (preserveSnapshotsDir && f === 'data') {
      // Preserve only data/snapshots/, drop everything else under data/.
      for (const sub of fs.readdirSync(full)) {
        if (sub !== 'snapshots') {
          fs.rmSync(path.join(full, sub), { recursive: true, force: true })
        }
      }
    } else {
      fs.rmSync(full, { recursive: true, force: true })
    }
  }
}

async function main() {
  // ============================================================
  // Phase 1 — Build state with real managers
  // ============================================================
  section('Phase 1 — populate state')
  const mods1 = freshModules()
  const im1 = new mods1.IM.IdentityManager()
  const wm1 = new mods1.WM.WorkspaceManager({ dataDir: TEST_USERDATA })
  const bm1 = new mods1.BM.BookmarkManager({ dataDir: TEST_USERDATA })
  const vault1 = new mods1.AV.Vault({
    keychain: SHARED_KEYCHAIN,
    dataDir: path.join(TEST_USERDATA, 'data'),
  })
  await vault1.unlock()
  const backup1 = new mods1.BK.BackupManager({
    userDataDir: TEST_USERDATA,
    vault: vault1,
    appVersion: '0.0.0-test',
  })

  // Create identities (Alice, Bob).
  const alice = im1.create({ name: 'Alice', color: '#aabbcc' })
  const bob = im1.create({ name: 'Bob', color: '#ddeeff' })
  ok('created Alice + Bob', !!alice.id && !!bob.id)

  // Create workspace, attach identities, set tabSpecs.
  const ws = wm1.create({ name: 'Agency Project' })
  wm1.addIdentity(ws.id, alice.id)
  wm1.addIdentity(ws.id, bob.id)
  wm1.setTabSpecs(
    ws.id,
    [
      { id: 't1', url: 'https://twitter.com/alice', identityId: alice.id },
      { id: 't2', url: 'https://twitter.com/bob', identityId: bob.id },
    ],
    't1',
  )
  ok(
    'workspace + tabSpecs created',
    wm1.list().some((w) => w.name === 'Agency Project'),
  )

  // Bookmarks.
  bm1.add({ identityId: alice.id, url: 'https://docs.com', title: 'Docs' })
  bm1.add({ identityId: alice.id, url: 'https://blog.com', title: 'Blog' })
  bm1.add({ identityId: bob.id, url: 'https://x.com/help', title: 'X Help' })
  ok('3 bookmarks added', bm1.list().length === 3)

  // Vault accounts (with real passwords — sensitive content!).
  vault1.setAccounts([
    {
      id: 'acc1',
      identityId: alice.id,
      site: 'twitter.com',
      username: 'alice_handle',
      password: 'AlicePassw0rd!',
    },
    {
      id: 'acc2',
      identityId: bob.id,
      site: 'instagram.com',
      username: 'bob_ig',
      password: 'BobInstaP@ss',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    },
  ])
  ok('vault has 2 accounts', vault1.getAccounts().length === 2)

  // Write auxiliary files that backup-manager should also collect.
  fs.writeFileSync(
    path.join(TEST_USERDATA, 'proxy-assignments.json'),
    JSON.stringify({ [alice.id]: 'proxy-1', [bob.id]: 'proxy-2' }, null, 2),
  )
  fs.writeFileSync(
    path.join(TEST_USERDATA, 'fingerprints.json'),
    JSON.stringify({
      [alice.id]: { ua: 'mac-chrome-129', screen: '1920x1080' },
      [bob.id]: { ua: 'mac-chrome-129', screen: '1440x900' },
    }),
  )
  fs.writeFileSync(
    path.join(TEST_USERDATA, 'settings.json'),
    JSON.stringify({ theme: 'dark', tabDiscardSec: 300 }),
  )
  ok(
    'auxiliary files written',
    fs.existsSync(path.join(TEST_USERDATA, 'fingerprints.json')),
  )

  // Capture pre-wipe file contents for post-restore comparison.
  const preWipe = {
    identities: fs.readFileSync(path.join(TEST_USERDATA, 'identities.json'), 'utf-8'),
    workspaces: fs.readFileSync(path.join(TEST_USERDATA, 'workspaces.json'), 'utf-8'),
    bookmarks: fs.readFileSync(path.join(TEST_USERDATA, 'bookmarks.json'), 'utf-8'),
    proxyAssignments: fs.readFileSync(
      path.join(TEST_USERDATA, 'proxy-assignments.json'),
      'utf-8',
    ),
    fingerprints: fs.readFileSync(path.join(TEST_USERDATA, 'fingerprints.json'), 'utf-8'),
    settings: fs.readFileSync(path.join(TEST_USERDATA, 'settings.json'), 'utf-8'),
  }

  // ============================================================
  // Phase 2 — Snapshot
  // ============================================================
  section('Phase 2 — take snapshot')
  const snap = backup1.createSnapshot({ reason: 'manual', label: 'pre-DR-drill' })
  ok('snapshot created', !!snap.id && !!snap.filePath)
  ok('snapshot file exists', fs.existsSync(snap.filePath))
  ok('snapshot file > 0 bytes', fs.statSync(snap.filePath).size > 0)
  ok(
    'snapshot fileCount >= 8 (now includes bookmarks/proxy-assign/fingerprints)',
    snap.header.fileCount >= 8,
    `actual: ${snap.header.fileCount}`,
  )

  // ============================================================
  // Phase 3 — Wipe (simulate Mac dies, new Mac comes online with same
  // Keychain but empty Application Support)
  // ============================================================
  section('Phase 3 — wipe userData (preserve only the snapshot)')
  wipeUserData(true)
  // Snapshot should still exist.
  ok('snapshot file survived wipe', fs.existsSync(snap.filePath))
  // identities.json should NOT exist.
  ok(
    'identities.json gone after wipe',
    !fs.existsSync(path.join(TEST_USERDATA, 'identities.json')),
  )

  // ============================================================
  // Phase 4 — Re-instantiate managers (verify they see EMPTY state)
  // ============================================================
  section('Phase 4 — verify post-wipe state is empty')
  const mods2 = freshModules()
  const im2 = new mods2.IM.IdentityManager()
  const wm2 = new mods2.WM.WorkspaceManager({ dataDir: TEST_USERDATA })
  const bm2 = new mods2.BM.BookmarkManager({ dataDir: TEST_USERDATA })
  // Only Default identity should exist (auto-created on load).
  ok('im2 has just Default', im2.list().length === 1 && im2.list()[0].isDefault)
  ok('wm2 has just General', wm2.list().length === 1 && wm2.list()[0].isDefault)
  ok('bm2 has 0 bookmarks', bm2.list().length === 0)

  // ============================================================
  // Phase 5 — Restore from snapshot
  // ============================================================
  section('Phase 5 — restore snapshot')
  // Need a vault instance unlocked with the SAME master key (which is
  // recovered from the Keychain — that's why we share the keychain mock).
  const vault2 = new mods2.AV.Vault({
    keychain: SHARED_KEYCHAIN,
    dataDir: path.join(TEST_USERDATA, 'data'),
  })
  await vault2.unlock() // reads master key from SHARED_KEYCHAIN → same key as vault1
  ok('vault2 unlocked with restored Keychain key', vault2.isUnlocked === true)
  const backup2 = new mods2.BK.BackupManager({
    userDataDir: TEST_USERDATA,
    vault: vault2,
    appVersion: '0.0.0-test',
  })
  const result = await backup2.restoreSnapshot(snap.id)
  ok('restoreSnapshot ok', result.ok === true)
  ok('restoredCount > 0', result.restoredCount > 0, `restored: ${result.restoredCount}`)

  // ============================================================
  // Phase 6 — Verify state fully recovered
  // ============================================================
  section('Phase 6 — verify state recovered')

  // File-level byte equality.
  for (const [name, file, content] of [
    ['identities.json', 'identities.json', preWipe.identities],
    ['workspaces.json', 'workspaces.json', preWipe.workspaces],
    ['bookmarks.json', 'bookmarks.json', preWipe.bookmarks],
    ['proxy-assignments.json', 'proxy-assignments.json', preWipe.proxyAssignments],
    ['fingerprints.json', 'fingerprints.json', preWipe.fingerprints],
    ['settings.json', 'settings.json', preWipe.settings],
  ]) {
    const after = fs.readFileSync(path.join(TEST_USERDATA, file), 'utf-8')
    ok(`${name} restored byte-identical`, after === content)
  }

  // Re-instantiate managers and verify they parse the restored files.
  const mods3 = freshModules()
  const im3 = new mods3.IM.IdentityManager()
  const wm3 = new mods3.WM.WorkspaceManager({ dataDir: TEST_USERDATA })
  const bm3 = new mods3.BM.BookmarkManager({ dataDir: TEST_USERDATA })
  ok('im3 has 3 identities (Default+Alice+Bob)', im3.list().length === 3)
  ok(
    'Alice present',
    im3.list().some((i) => i.name === 'Alice'),
  )
  ok(
    'Bob present',
    im3.list().some((i) => i.name === 'Bob'),
  )
  ok(
    'wm3 has 2 workspaces incl Agency Project',
    wm3.list().length === 2 && wm3.list().some((w) => w.name === 'Agency Project'),
  )
  ok('bm3 has 3 bookmarks restored', bm3.list().length === 3)

  // Vault accounts decrypt and round-trip.
  const vault3 = new mods3.AV.Vault({
    keychain: SHARED_KEYCHAIN,
    dataDir: path.join(TEST_USERDATA, 'data'),
  })
  await vault3.unlock()
  const accounts = vault3.getAccounts()
  ok('vault3 has 2 accounts', accounts.length === 2)
  ok(
    'AlicePassw0rd! decrypts correctly',
    accounts.find((a) => a.id === 'acc1' && a.password === 'AlicePassw0rd!'),
  )
  ok(
    'BobInstaP@ss decrypts correctly',
    accounts.find((a) => a.id === 'acc2' && a.password === 'BobInstaP@ss'),
  )
  ok(
    "Bob's TOTP secret preserved",
    accounts.find((a) => a.id === 'acc2' && a.totpSecret === 'JBSWY3DPEHPK3PXP'),
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
