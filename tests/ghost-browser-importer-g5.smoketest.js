// OZ Browser — G-5 idempotency + replace + self-heal smoke tests.
//
// Cómo correr:
//   cd oz-browser && node tests/ghost-browser-importer-g5.smoketest.js
//
// Covers the 3 G-5 fixes:
//   1. Merge mode (default) — running import twice over the same Ghost data
//      creates entities once. Second run reports reused == N, created == 0.
//   2. Replace mode — re-running with mode='replace' removes the previously
//      imported entities first, then re-imports fresh. State.json refreshed.
//   3. Self-healing in wireIdentityWorkspaceSync — recovers a workspace
//      whose tabSpecs reference identities but workspace.identityIds=[] and
//      identity.workspaceId='general' (the exact bug Jose hit pre-G-5).

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---------- Tmp userData + Electron stub ----------
// userData is per-section to keep tests isolated. We swap `currentUserData`
// before constructing managers; fakeApp.getPath reads it live.
let currentUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-g5-init-'))

const fakeApp = {
  getPath(key) {
    if (key === 'logs') {
      const p = path.join(currentUserData, 'logs')
      fs.mkdirSync(p, { recursive: true })
      return p
    }
    return currentUserData
  },
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

// ---------- Test runner ----------
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

console.log('OZ Browser — G-5 idempotency + replace + self-heal smoke test')

// ---------- Modules under test ----------
const reader = require('../browser/migrations/ghost-browser-reader.js')
const gc = require('../browser/migrations/ghost-browser-crypto.js')
const importer = require('../browser/migrations/ghost-browser-importer.js')
const helpers = require('./_helpers-ghost-fixtures.js')
const IWSYNC = require('../browser/identity-workspace-sync.js')

function makeMockKeychain() {
  const store = new Map()
  return {
    _store: store,
    getPassword: (s, a) => store.get(`${s}:${a}`) || null,
    setPassword: (s, a, p) => store.set(`${s}:${a}`, p),
    deletePassword: (s, a) => store.delete(`${s}:${a}`),
  }
}

function makeSessionSink() {
  const sessions = new Map()
  return {
    getSession(identityId) {
      if (!sessions.has(identityId)) {
        const cookieStore = []
        sessions.set(identityId, {
          cookies: {
            set: async (det) => {
              cookieStore.push(det)
            },
            _store: cookieStore,
          },
        })
      }
      return sessions.get(identityId)
    },
    _sessions: sessions,
  }
}

// ---------- Build synthetic Ghost install once, reuse for all sections ----------
const FIXTURE_ROOT = helpers.makeRoot('oz-g5-fix-')
const SAFE_KEY = 'g5-safe-storage-key'

async function buildSyntheticGhostInstall() {
  const dir = helpers.mkInstall(FIXTURE_ROOT, 'install')
  const derived = gc.deriveKey(SAFE_KEY)
  const hashes = ['ghost-hashA', 'ghost-hashB']
  helpers.writeJson(path.join(dir, 'Default/Identities/identities.json'), {
    identities: hashes,
  })
  for (const hash of hashes) {
    const identDir = path.join(dir, 'Default/Identities', hash)
    fs.mkdirSync(identDir, { recursive: true })
    helpers.writeJson(path.join(identDir, 'identity.json'), {
      id: hash,
      name: hash === 'ghost-hashA' ? 'Alice' : 'Bob',
      color: 'BC789C',
    })
    const cookies = [
      {
        host_key: '.example.com',
        name: `sess-${hash}`,
        is_secure: true,
        is_httponly: true,
        has_expires: true,
        expires_utc: '13422899379276164',
        source_scheme: 2,
        samesite: 1,
        encrypted_value: gc._encryptBlobForTest(`${hash}-cookie`, derived),
      },
    ]
    fs.writeFileSync(path.join(identDir, 'Cookies'), await helpers.makeCookiesDb(cookies))
  }
  helpers.writeJson(path.join(dir, 'Default/Projects/projects_list.json'), {
    projects: ['proj-1'],
    projects_number: 1,
  })
  helpers.writeJson(path.join(dir, 'Default/Projects/proj-1/project.json'), {
    id: 'proj-1',
    name: 'My Project',
    windows: [
      {
        tabs: [
          { identity: 'ghost-hashA', url: 'https://example.com/a', title: 'A' },
          { identity: 'ghost-hashB', url: 'https://example.com/b', title: 'B' },
        ],
      },
    ],
  })
  fs.writeFileSync(
    path.join(dir, 'Default/Login Data'),
    await helpers.makeLoginDataDb([]),
  )
  return dir
}

// Build a fresh set of OZ managers + wire identity↔workspace sync.
// Sets currentUserData global so fakeApp.getPath returns the section's dir.
function makeFreshDeps(userDataDir) {
  currentUserData = userDataDir
  // Force-fresh module cache so managers see the empty disk state.
  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/bookmark-manager.js')]
  delete require.cache[require.resolve('../browser/account-vault.js')]
  delete require.cache[require.resolve('../browser/backup-manager.js')]
  const IM = require('../browser/identity-manager.js')
  const WM = require('../browser/workspace-manager.js')
  const BM = require('../browser/bookmark-manager.js')
  const AV = require('../browser/account-vault.js')
  const BK = require('../browser/backup-manager.js')
  const identityManager = new IM.IdentityManager()
  const workspaceManager = new WM.WorkspaceManager()
  const bookmarkManager = new BM.BookmarkManager()
  IWSYNC.wireIdentityWorkspaceSync({ identityManager, workspaceManager })
  const keychain = makeMockKeychain()
  const accountVault = new AV.Vault({
    keychain,
    dataDir: path.join(userDataDir, 'data'),
  })
  const backupManager = new BK.BackupManager({
    userDataDir,
    vault: accountVault,
    appVersion: '0.0.0-test',
  })
  const sessionSink = makeSessionSink()
  return {
    identityManager,
    workspaceManager,
    bookmarkManager,
    accountVault,
    backupManager,
    getSession: sessionSink.getSession,
    userDataDir,
    _internal: { sessionSink, keychain },
  }
}

const fakeCrypto = {
  ...gc,
  fetchGhostKeychainKey: async () => SAFE_KEY,
}

async function main() {
  const ghostDir = await buildSyntheticGhostInstall()

  // ============================================================
  // SECTION 1 — Merge mode idempotency
  // ============================================================
  section('runImport — merge mode idempotency (run twice, second is no-op)')

  const ud1 = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-g5-merge-'))
  const deps1 = makeFreshDeps(ud1)
  await deps1.accountVault.unlock()

  const run1 = await importer.runImport({
    reader,
    crypto: fakeCrypto,
    ghostDataDir: ghostDir,
    deps: deps1,
    options: {},
  })
  ok('run1 ok', run1.ok === true)
  ok('run1 mode = merge (default)', run1.mode === 'merge')
  ok('run1 identities created = 2', run1.counts.identities === 2)
  ok('run1 workspaces created = 1', run1.counts.workspaces === 1)
  ok('run1 reused.identities = 0', run1.reused.identities === 0)
  ok('run1 reused.workspaces = 0', run1.reused.workspaces === 0)

  // Run 2 — same source, default merge mode → should reuse everything.
  const run2 = await importer.runImport({
    reader,
    crypto: fakeCrypto,
    ghostDataDir: ghostDir,
    deps: deps1,
    options: {},
  })
  ok('run2 ok', run2.ok === true)
  ok('run2 identities created = 0 (idempotent)', run2.counts.identities === 0)
  ok('run2 workspaces created = 0 (idempotent)', run2.counts.workspaces === 0)
  ok('run2 reused.identities = 2', run2.reused.identities === 2)
  ok('run2 reused.workspaces = 1', run2.reused.workspaces === 1)
  // state.json should still reflect the same mapping
  const state2 = importer.readState(ud1)
  ok('state2 identityMap unchanged size', Object.keys(state2.identityMap).length === 2)
  ok('state2 workspaceMap unchanged size', Object.keys(state2.workspaceMap).length === 1)

  // Disk state — verify no duplicates
  const idJson1 = JSON.parse(fs.readFileSync(path.join(ud1, 'identities.json'), 'utf-8'))
  const wsJson1 = JSON.parse(fs.readFileSync(path.join(ud1, 'workspaces.json'), 'utf-8'))
  ok('identities.json has 3 (Default + Alice + Bob)', idJson1.length === 3)
  ok('workspaces.json has 2 (general + My Project)', wsJson1.length === 2)
  const myProj1 = wsJson1.find((w) => w.name === 'My Project')
  ok(
    'My Project still has 2 identityIds (no boot wipe)',
    myProj1 && myProj1.identityIds.length === 2,
  )

  // ============================================================
  // SECTION 2 — Replace mode removes previous import + re-creates
  // ============================================================
  section('runImport — replace mode removes previous + re-imports')

  const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-g5-replace-'))
  const deps2 = makeFreshDeps(ud2)
  await deps2.accountVault.unlock()

  // First import (merge default)
  const r1 = await importer.runImport({
    reader,
    crypto: fakeCrypto,
    ghostDataDir: ghostDir,
    deps: deps2,
    options: {},
  })
  ok('first import ok', r1.ok === true)
  const firstIdentityIds = Object.values(r1.identityMap)
  const firstWorkspaceIds = Object.values(r1.workspaceMap)

  // Manually add a non-Ghost identity to verify replace does NOT touch it.
  const survivor = deps2.identityManager.create({ name: 'Survivor' })
  ok('survivor identity created', !!survivor && !!survivor.id)

  // Second import — replace mode
  const r2 = await importer.runImport({
    reader,
    crypto: fakeCrypto,
    ghostDataDir: ghostDir,
    deps: deps2,
    options: { mode: 'replace' },
  })
  ok('replace import ok', r2.ok === true)
  ok('replace mode = replace', r2.mode === 'replace')
  ok('replace removed.identities = 2', r2.removed.identities === 2)
  ok('replace removed.workspaces = 1', r2.removed.workspaces === 1)
  ok('replace counts.identities = 2 (re-created)', r2.counts.identities === 2)
  ok('replace counts.workspaces = 1 (re-created)', r2.counts.workspaces === 1)

  // Previous identity IDs are GONE
  for (const oldId of firstIdentityIds) {
    ok(
      `previous identity ${oldId.slice(0, 8)} removed`,
      !deps2.identityManager.get(oldId),
    )
  }
  for (const oldWsId of firstWorkspaceIds) {
    ok(
      `previous workspace ${oldWsId.slice(0, 8)} removed`,
      !deps2.workspaceManager.get(oldWsId),
    )
  }
  // Survivor untouched
  ok('survivor identity untouched by replace', !!deps2.identityManager.get(survivor.id))
  // state.json reflects only the new run
  const state2b = importer.readState(ud2)
  const newMapValues = Object.values(state2b.identityMap || {})
  ok(
    'state.identityMap contains only NEW ids (not old)',
    newMapValues.every((id) => !firstIdentityIds.includes(id)),
  )

  // ============================================================
  // SECTION 3 — Self-heal: workspace with empty identityIds + valid tabSpecs
  //                       gets identity moved to it at wireIdentityWorkspaceSync
  // ============================================================
  section('wireIdentityWorkspaceSync — self-heal from tabSpec evidence')

  const ud3 = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-g5-heal-'))
  currentUserData = ud3
  // Hand-craft the broken state Jose hit pre-G-5: a workspace whose
  // tabSpecs[].identityId references a valid identity X, but
  // workspace.identityIds=[] AND identity.workspaceId='general'.
  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  const IM3 = require('../browser/identity-manager.js')
  const WM3 = require('../browser/workspace-manager.js')
  const im3 = new IM3.IdentityManager()
  const wm3 = new WM3.WorkspaceManager()

  // Create identity Alice and workspace Project, but DO NOT call moveToWorkspace.
  const aliceId = im3.create({ name: 'Alice' }).id
  const projWs = wm3.create({ name: 'Project' })
  // Mimic the bug: tabSpec references Alice in Project, but Alice.workspaceId='general'.
  wm3.setTabSpecs(
    projWs.id,
    [{ id: 'tab-1', url: 'https://x.com', identityId: aliceId }],
    'tab-1',
  )
  // Sanity: pre-wire state matches the bug shape
  ok('pre-wire: Alice.workspaceId = general', im3.get(aliceId).workspaceId === 'general')
  ok('pre-wire: Project.identityIds = []', wm3.get(projWs.id).identityIds.length === 0)
  ok(
    'pre-wire: Project.tabSpecs[0].identityId = Alice',
    wm3.get(projWs.id).tabSpecs[0].identityId === aliceId,
  )

  // Wire the sync (this triggers syncIdentityWorkspaces with step 1.5).
  IWSYNC.wireIdentityWorkspaceSync({ identityManager: im3, workspaceManager: wm3 })

  ok(
    'post-wire: Alice.workspaceId = projWs.id',
    im3.get(aliceId).workspaceId === projWs.id,
  )
  ok(
    'post-wire: Project.identityIds = [Alice]',
    wm3.get(projWs.id).identityIds.includes(aliceId),
  )
  ok(
    'post-wire: Project.identityIds.length = 1',
    wm3.get(projWs.id).identityIds.length === 1,
  )

  // ============================================================
  // SECTION 4 — Self-heal SKIPS General Browsing
  // ============================================================
  section('wireIdentityWorkspaceSync — general workspace excluded from self-heal')

  const ud4 = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-g5-heal-general-'))
  currentUserData = ud4
  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  const IM4 = require('../browser/identity-manager.js')
  const WM4 = require('../browser/workspace-manager.js')
  const im4 = new IM4.IdentityManager()
  const wm4 = new WM4.WorkspaceManager()
  // Project workspace + Alice identity claimed by Project
  const aliceP = im4.create({ name: 'Alice', workspaceId: 'general' }).id
  const proj4 = wm4.create({ name: 'Project' })
  // Put Alice's tab in General Browsing too (a tab open in general — legitimate)
  wm4.setTabSpecs(
    'general',
    [{ id: 'tab-g', url: 'https://general.com', identityId: aliceP }],
    'tab-g',
  )
  wm4.setTabSpecs(
    proj4.id,
    [{ id: 'tab-p', url: 'https://x.com', identityId: aliceP }],
    'tab-p',
  )
  // Wire sync — should claim Alice for Project (not General)
  IWSYNC.wireIdentityWorkspaceSync({ identityManager: im4, workspaceManager: wm4 })
  ok('Alice claimed by Project (not General)', im4.get(aliceP).workspaceId === proj4.id)
  ok('Project.identityIds includes Alice', wm4.get(proj4.id).identityIds.includes(aliceP))
  ok(
    'General does NOT have Alice in identityIds',
    !wm4.get('general').identityIds.includes(aliceP),
  )

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(2)
})
