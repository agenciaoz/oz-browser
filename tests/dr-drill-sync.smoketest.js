// OZ Browser — Disaster Recovery drill (sync-based) — H-2.
//
// Cómo correr:
//   cd oz-browser && node tests/dr-drill-sync.smoketest.js
//
// Simulates the "Mac dies, new Mac with same Dropbox + Keychain" path:
//   1. Mac A populates ALL THREE sync sources (identities, workspaces with
//      tabSpecs, bookmarks) and pushes them to a shared fake Dropbox.
//   2. Mac B starts with EMPTY userData but the same fake vault (simulates
//      Keychain master key surviving the OS account migration).
//   3. Mac B sees the shared Dropbox, calls pullNow, and we assert it
//      received all three sources via cold-start.
//
// Scope notes:
//   - Vault accounts are NOT covered here — sync only handles record
//     metadata, not the vault blob. Vault recovery goes through the
//     backup path (H-3 + cloud-backup tests).
//   - Workspace `tabSpecs` and `activeTabId` are intentionally stripped by
//     the privacy carveout (ADR §1). Mac B receives the workspace shell
//     and re-fills tabSpecs on its own.

'use strict'

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// ---------- Electron stub ----------
const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-h2-dr-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

function makeFakeSession(label) {
  return {
    __label: label,
    setUserAgent() {},
    cookies: { onChanged: { addListener() {} } },
  }
}
const fakeElectron = {
  app: {
    getPath: (k) => (k === 'logs' ? TEST_LOGS : TEST_USERDATA),
    getName: () => 'OZ Browser Test',
    getAppPath: () => path.resolve(__dirname, '..'),
    on() {},
    whenReady: () => Promise.resolve(),
  },
  session: {
    defaultSession: makeFakeSession('default'),
    fromPartition: (p) => {
      if (!fakeElectron.session.__cache) fakeElectron.session.__cache = new Map()
      const c = fakeElectron.session.__cache
      if (c.has(p)) return c.get(p)
      const s = makeFakeSession(p)
      c.set(p, s)
      return s
    },
  },
}
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}
process.env.OZ_TIER = 'paid'

// ---------- Runner ----------
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
console.log('OZ Browser — H-2 DR drill (sync-based) smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// ---------- Doubles ----------
// Sync uses the master key for AES-GCM record encryption. Same key on both
// sides simulates the user's Keychain surviving the Mac migration.
const SHARED_MASTER_KEY = crypto.randomBytes(32)
function makeFakeVault() {
  return {
    isUnlocked: true,
    getMasterKey: () => SHARED_MASTER_KEY,
  }
}

function makeFakeDropbox() {
  const store = new Map()
  const folderEntries = new Map()
  let nextCursor = 1
  return {
    isAuthenticated: () => true,
    async upload(p, buf) {
      store.set(p, Buffer.from(buf))
      const dir = p.split('/').slice(0, -1).join('/')
      if (!folderEntries.has(dir)) folderEntries.set(dir, [])
      const list = folderEntries.get(dir)
      if (!list.find((e) => e.pathDisplay === p)) {
        list.push({
          name: p.split('/').pop(),
          pathDisplay: p,
          pathLower: p.toLowerCase(),
          size: buf.length,
          serverModified: new Date().toISOString(),
          isFolder: false,
          isDeleted: false,
        })
      }
    },
    async download(p) {
      const b = store.get(p)
      if (!b) {
        const e = new Error('not_found')
        e.code = 'NOT_FOUND'
        throw e
      }
      return b
    },
    async listFolder(p) {
      const entries = folderEntries.get(p) || []
      return { entries: entries.slice(), cursor: `c-${nextCursor++}`, hasMore: false }
    },
    async listFolderContinue() {
      return { entries: [], cursor: `c-${nextCursor++}`, hasMore: false }
    },
    async delete(p) {
      store.delete(p)
    },
    _store: store,
    _hasPath: (p) => store.has(p),
    _allPaths: () => Array.from(store.keys()).sort(),
  }
}

function freshModules() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fakeElectron.session.__cache = new Map()
  for (const m of [
    'identity-manager',
    'identity-manager-sync',
    'workspace-manager',
    'workspace-manager-sync',
    'bookmark-manager',
    'bookmark-manager-sync',
    'sync-queue',
    'sync-engine',
    'sync-pull',
    'sync-setup',
    'logger',
  ]) {
    delete require.cache[require.resolve(`../browser/${m}.js`)]
  }
  return {
    IdentityManager: require('../browser/identity-manager.js').IdentityManager,
    WorkspaceManager: require('../browser/workspace-manager.js').WorkspaceManager,
    BookmarkManager: require('../browser/bookmark-manager.js').BookmarkManager,
    setupSync: require('../browser/sync-setup.js').setupSync,
  }
}

// ============================================================
// Drill
// ============================================================
;(async () => {
  const sharedDropbox = makeFakeDropbox()
  const sharedVault = makeFakeVault()

  // ---------- Mac A — populate + push ----------
  section('Mac A — populate state and push to shared Dropbox')
  const macA = freshModules()
  const aIM = new macA.IdentityManager()
  const aWM = new macA.WorkspaceManager()
  const aBM = new macA.BookmarkManager()
  const aSetup = macA.setupSync({
    vault: sharedVault,
    dropbox: sharedDropbox,
    identityManager: aIM,
    workspaceManager: aWM,
    bookmarkManager: aBM,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-a-original',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  // 2 identities
  const alice = aIM.create({ name: 'Alice', color: '#aa11bb' })
  const bob = aIM.create({ name: 'Bob', color: '#22ccdd' })
  // 1 workspace with tabSpecs (privacy carveout will strip on push)
  const ws = aWM.create({ name: 'Agency Project', color: '#ee9900' })
  aWM.addIdentity(ws.id, alice.id)
  aWM.addIdentity(ws.id, bob.id)
  aWM.setTabSpecs(
    ws.id,
    [
      { id: 't1', url: 'https://twitter.com/alice', identityId: alice.id },
      { id: 't2', url: 'https://twitter.com/bob', identityId: bob.id },
    ],
    't1',
  )
  // 3 bookmarks
  aBM.add({ identityId: alice.id, url: 'https://docs.com', title: 'Docs' })
  aBM.add({ identityId: alice.id, url: 'https://blog.com', title: 'Blog' })
  aBM.add({ identityId: bob.id, url: 'https://x.com/help', title: 'X Help' })

  // Flush — drain the sync engine queue until empty.
  // drainOnce() processes one op per call. Folder names use the naive
  // ${recordType}s pluralization → 'identitys' (sic), 'workspaces',
  // 'bookmarks'.
  for (let i = 0; i < 20; i++) {
    const result = await aSetup.engine.drainOnce()
    if (result === 'idle') break
  }

  ok('Alice uploaded', sharedDropbox._hasPath(`/sync/identitys/${alice.id}.json.enc`))
  ok('Bob uploaded', sharedDropbox._hasPath(`/sync/identitys/${bob.id}.json.enc`))
  ok('Workspace uploaded', sharedDropbox._hasPath(`/sync/workspaces/${ws.id}.json.enc`))
  ok(
    'Bookmarks single-record uploaded',
    sharedDropbox._hasPath('/sync/bookmarks/all.json.enc'),
  )

  // Stop A's poll loop (we won't reuse the instance).
  aSetup.stop()

  // ---------- Phase 2 — Mac B starts EMPTY ----------
  section('Mac B — wipe userData, fresh boot, same vault+Dropbox')
  // Wipe userData EXCEPT logs. This simulates a brand-new Mac.
  // We deliberately do NOT preserve the original sync-state.json or
  // sync-queue.json — cold-start scenario.
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  ok('identities.json gone', !fs.existsSync(path.join(TEST_USERDATA, 'identities.json')))
  ok('workspaces.json gone', !fs.existsSync(path.join(TEST_USERDATA, 'workspaces.json')))
  ok('bookmarks.json gone', !fs.existsSync(path.join(TEST_USERDATA, 'bookmarks.json')))

  // Fresh modules — same as a fresh app boot.
  const macB = freshModules()
  const bIM = new macB.IdentityManager()
  const bWM = new macB.WorkspaceManager()
  const bBM = new macB.BookmarkManager()

  // Before sync — Mac B has only the auto-created Default identity / General
  // workspace / no bookmarks. Verifies cold-start state before pull.
  ok(
    'Mac B has only Default identity',
    bIM.list().length === 1 && bIM.list()[0].isDefault,
  )
  ok(
    'Mac B has only General workspace',
    bWM.list().length === 1 && bWM.list()[0].isDefault,
  )
  ok('Mac B has 0 bookmarks', bBM.list().length === 0)

  const bSetup = macB.setupSync({
    vault: sharedVault,
    dropbox: sharedDropbox,
    identityManager: bIM,
    workspaceManager: bWM,
    bookmarkManager: bBM,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-b-replacement',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  // ---------- Phase 3 — Pull cold-start ----------
  section('Mac B — pullNow (cold-start cursor, lists all 3 folders)')
  const pullResult = await bSetup.pullNow()
  ok('pullNow returned', !!pullResult)
  ok(
    'pulled 2 identities',
    pullResult.identity && pullResult.identity.applied === 2,
    `actual: ${JSON.stringify(pullResult.identity)}`,
  )
  ok(
    'pulled 1 workspace',
    pullResult.workspace && pullResult.workspace.applied === 1,
    `actual: ${JSON.stringify(pullResult.workspace)}`,
  )
  ok(
    'pulled bookmarks record',
    pullResult.bookmark && pullResult.bookmark.applied === 1,
    `actual: ${JSON.stringify(pullResult.bookmark)}`,
  )

  // ---------- Phase 4 — Verify Mac B recovered everything ----------
  section('Mac B — assert state recovered')
  const bIdentities = bIM.list()
  ok(
    'Mac B has 3 identities (Default + Alice + Bob)',
    bIdentities.length === 3,
    `count=${bIdentities.length} names=${bIdentities.map((i) => i.name).join(',')}`,
  )
  const bAlice = bIdentities.find((i) => i.id === alice.id)
  const bBob = bIdentities.find((i) => i.id === bob.id)
  ok('Alice recovered with same id', !!bAlice && bAlice.name === 'Alice')
  ok('Alice color recovered', !!bAlice && bAlice.color === '#aa11bb')
  ok('Bob recovered with same id', !!bBob && bBob.name === 'Bob')

  const bWorkspace = bWM.get(ws.id)
  ok('Mac B has the Agency Project workspace', !!bWorkspace)
  ok('Workspace name recovered', !!bWorkspace && bWorkspace.name === 'Agency Project')
  ok('Workspace color recovered', !!bWorkspace && bWorkspace.color === '#ee9900')
  // Privacy carveout — tabSpecs were NOT pushed; Mac B sees an empty array.
  ok(
    'tabSpecs NOT synced (privacy carveout) — Mac B sees []',
    Array.isArray(bWorkspace.tabSpecs) && bWorkspace.tabSpecs.length === 0,
  )
  ok('activeTabId NOT synced', bWorkspace.activeTabId === null)
  // identityIds[] IS synced (it's metadata, not content).
  ok(
    'Workspace identityIds[] recovered (both Alice + Bob)',
    bWorkspace.identityIds.includes(alice.id) && bWorkspace.identityIds.includes(bob.id),
  )

  const bBookmarks = bBM.list()
  ok('Mac B has 3 bookmarks', bBookmarks.length === 3)
  ok(
    'Docs bookmark recovered with Alice identity',
    bBookmarks.some((b) => b.url === 'https://docs.com' && b.identityId === alice.id),
  )
  ok(
    'X Help bookmark recovered with Bob identity',
    bBookmarks.some((b) => b.url === 'https://x.com/help' && b.identityId === bob.id),
  )

  bSetup.stop()

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
})().catch((e) => {
  console.error('UNCAUGHT:', e.stack || e.message)
  process.exit(1)
})
