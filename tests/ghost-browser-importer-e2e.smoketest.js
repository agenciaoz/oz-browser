// OZ Browser — Ghost Browser importer E2E integration test (G-4).
//
// Cómo correr:
//   cd oz-browser && node tests/ghost-browser-importer-e2e.smoketest.js
//
// Unlike ghost-browser-importer.smoketest.js (fake deps), this wires the
// importer against REAL OZ infra: IdentityManager, WorkspaceManager,
// BookmarkManager, Vault (+ mock Keychain), BackupManager. Still stubbed:
// Electron `app` (Module._load swap), session.fromPartition() (no Electron
// runtime), Ghost Keychain (fakeCrypto returns SAFE_KEY without `security`).
//
// Covers: happy-path disk state, state sidecar, rollback restores disk,
// re-instantiated managers see persisted import.

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---------- Tmp userData + Electron stub ----------
const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-ghost-e2e-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath(key) {
    if (key === 'logs') return TEST_LOGS
    return TEST_USERDATA
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

console.log('OZ Browser — Ghost Browser importer E2E (G-4) smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// ---------- Modules under test — loaded AFTER Electron stub ----------
const reader = require('../browser/migrations/ghost-browser-reader.js')
const gc = require('../browser/migrations/ghost-browser-crypto.js')
const importer = require('../browser/migrations/ghost-browser-importer.js')
const helpers = require('./_helpers-ghost-fixtures.js')

// Mock Keychain (same shape as account-vault.smoketest.js)
function makeMockKeychain() {
  const store = new Map()
  return {
    _store: store,
    getPassword(service, account) {
      return store.get(`${service}:${account}`) || null
    },
    setPassword(service, account, password) {
      store.set(`${service}:${account}`, password)
    },
    deletePassword(service, account) {
      return store.delete(`${service}:${account}`)
    },
  }
}

// ---------- Synthetic Ghost install ----------
const FIXTURE_ROOT = helpers.makeRoot('oz-ghost-e2e-fix-')
const SAFE_KEY = 'e2e-safe-storage-key'

async function buildSyntheticGhostInstall() {
  const dir = helpers.mkInstall(FIXTURE_ROOT, 'install')
  const derived = gc.deriveKey(SAFE_KEY)

  // 2 identities, each with 1 cookie
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

  // 1 workspace project with 2 tabs referencing both identities
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

  // 1 password (pool-global)
  fs.writeFileSync(
    path.join(dir, 'Default/Login Data'),
    await helpers.makeLoginDataDb([
      {
        origin_url: 'https://instagram.com/',
        username_value: 'jose@example.com',
        password_value: gc._encryptBlobForTest('my-real-password', derived),
        signon_realm: 'https://instagram.com/',
      },
    ]),
  )

  // 1 bookmark
  helpers.writeJson(path.join(dir, 'Default/Bookmarks'), {
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bar',
        children: [{ type: 'url', url: 'https://docs.example.com', name: 'Docs' }],
      },
    },
  })

  return { dir, hashes }
}

// In-memory cookie sink replacing Electron session.fromPartition().
function makeSessionSink() {
  const calls = {} // identityId → details[]
  return {
    calls,
    getSession(identityId) {
      return {
        cookies: {
          async set(details) {
            if (!calls[identityId]) calls[identityId] = []
            calls[identityId].push(details)
          },
        },
      }
    },
  }
}

// Fake crypto — bypasses macOS `security` popup but uses real decrypt.
function buildFakeCrypto() {
  return {
    fetchGhostKeychainKey: async () => SAFE_KEY,
    deriveKey: gc.deriveKey,
    decryptCookies: gc.decryptCookies,
    decryptPasswords: gc.decryptPasswords,
  }
}

// ---------- Build real OZ deps against tmp userData ----------
async function buildRealDeps() {
  // Wipe between tests (preserve TEST_LOGS) so each gets clean userData.
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  // Re-require to reset module-level state.
  for (const m of [
    '../browser/identity-manager.js',
    '../browser/workspace-manager.js',
    '../browser/bookmark-manager.js',
    '../browser/account-vault.js',
    '../browser/backup-manager.js',
  ]) {
    delete require.cache[require.resolve(m)]
  }
  const IM = require('../browser/identity-manager.js')
  const WM = require('../browser/workspace-manager.js')
  const BM = require('../browser/bookmark-manager.js')
  const AV = require('../browser/account-vault.js')
  const BK = require('../browser/backup-manager.js')

  const identityManager = new IM.IdentityManager()
  const workspaceManager = new WM.WorkspaceManager({ dataDir: TEST_USERDATA })
  const bookmarkManager = new BM.BookmarkManager({ dataDir: TEST_USERDATA })

  // G-5: wire the identity↔workspace sync hooks just like main.js does in
  // production. Without this, identityManager.moveToWorkspace mutates
  // identity.workspaceId but workspace.identityIds[] stays empty (the hook
  // is what fires workspaceManager.addIdentity on move). Mirrors the
  // production wiring exercised by Browser.init().
  const IWSYNC = require('../browser/identity-workspace-sync.js')
  IWSYNC.wireIdentityWorkspaceSync({ identityManager, workspaceManager })

  const keychain = makeMockKeychain()
  const accountVault = new AV.Vault({
    keychain,
    dataDir: path.join(TEST_USERDATA, 'data'),
  })
  await accountVault.unlock()

  const backupManager = new BK.BackupManager({
    userDataDir: TEST_USERDATA,
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
    userDataDir: TEST_USERDATA,
    _internal: { sessionSink, keychain },
  }
}

// ---------- Test cases ----------
async function testHappyPath() {
  section('Happy path — full pipeline against REAL managers')
  const { dir } = await buildSyntheticGhostInstall()
  const deps = await buildRealDeps()
  const cryptoMod = buildFakeCrypto()

  const r = await importer.runImport({
    reader,
    crypto: cryptoMod,
    ghostDataDir: dir,
    deps,
  })

  ok('ok = true', r.ok === true, JSON.stringify(r.error))
  ok('no error', r.error === null)
  ok('snapshotId set', typeof r.snapshotId === 'string' && r.snapshotId.length > 0)
  ok('2 identities counted', r.counts.identities === 2)
  ok('1 workspace counted', r.counts.workspaces === 1)
  ok('2 cookies counted', r.counts.cookies === 2)
  ok('1 bookmark counted', r.counts.bookmarks === 1)
  ok('1 password counted', r.counts.passwords === 1)

  // --- Assert REAL identities.json on disk ---
  const idJson = JSON.parse(
    fs.readFileSync(path.join(TEST_USERDATA, 'identities.json'), 'utf-8'),
  )
  ok('identities.json has 3 entries (Default + Alice + Bob)', idJson.length === 3)
  ok(
    'Alice persisted to disk',
    idJson.some((i) => i.name === 'Alice'),
  )
  ok(
    'Bob persisted to disk',
    idJson.some((i) => i.name === 'Bob'),
  )
  ok(
    'imported identities color preserved',
    idJson.filter((i) => i.color === 'BC789C').length === 2,
  )

  // --- Assert REAL workspaces.json on disk ---
  const wsJson = JSON.parse(
    fs.readFileSync(path.join(TEST_USERDATA, 'workspaces.json'), 'utf-8'),
  )
  ok('workspaces.json has 2 entries (General + My Project)', wsJson.length === 2)
  const myProject = wsJson.find((w) => w.name === 'My Project')
  ok('My Project persisted', !!myProject)
  ok(
    'My Project has 2 identityIds linked',
    myProject && myProject.identityIds && myProject.identityIds.length === 2,
  )
  ok(
    'My Project has 2 tabSpecs',
    myProject && Array.isArray(myProject.tabSpecs) && myProject.tabSpecs.length === 2,
  )
  ok(
    'tabSpec.identityId mapped to OZ id (not Ghost hash)',
    myProject &&
      myProject.tabSpecs.every((t) => t.identityId && !t.identityId.startsWith('ghost-')),
  )

  // --- Assert REAL bookmarks.json on disk ---
  const bmJson = JSON.parse(
    fs.readFileSync(path.join(TEST_USERDATA, 'bookmarks.json'), 'utf-8'),
  )
  ok('bookmarks.json has 1 entry', bmJson.length === 1)
  ok('bookmark url preserved', bmJson[0].url === 'https://docs.example.com')
  ok('bookmark assigned to identityId="default"', bmJson[0].identityId === 'default')

  // --- Assert REAL vault contents (re-unlock to round-trip through disk) ---
  delete require.cache[require.resolve('../browser/account-vault.js')]
  const AV2 = require('../browser/account-vault.js')
  const v2 = new AV2.Vault({
    keychain: deps._internal.keychain,
    dataDir: path.join(TEST_USERDATA, 'data'),
  })
  await v2.unlock()
  const accounts = v2.getAccounts()
  ok('vault has 1 account', accounts.length === 1)
  ok('account password decrypted', accounts[0].password === 'my-real-password')
  ok(
    'account marker importedFrom = ghost-browser',
    accounts[0].customFields && accounts[0].customFields.importedFrom === 'ghost-browser',
  )
  ok('account identityId = null (unassigned)', accounts[0].identityId === null)

  // --- Assert snapshot file actually written to disk ---
  const snapshotsDir = path.join(TEST_USERDATA, 'data', 'snapshots')
  const snapFiles = fs.readdirSync(snapshotsDir).filter((f) => f.endsWith('.ozbackup'))
  ok('snapshot file written to data/snapshots/', snapFiles.length >= 1)

  // --- Assert session.cookies.set called per identity ---
  const ozIds = Object.values(r.identityMap)
  const sessCalls = deps._internal.sessionSink.calls
  ok(
    'session.cookies.set called for both OZ identities',
    ozIds.every((id) => sessCalls[id] && sessCalls[id].length === 1),
  )

  // --- Assert state sidecar ---
  const state = importer.readState(TEST_USERDATA)
  ok('state sidecar written', !!state)
  ok(
    'state.identityMap has 2 entries',
    state && Object.keys(state.identityMap).length === 2,
  )
  ok(
    'state.counts.identities = 2',
    state && state.counts && state.counts.identities === 2,
  )
}

async function testRollbackOnFailure() {
  section('Rollback path — mid-flight throw restores pre-import disk state')
  const { dir } = await buildSyntheticGhostInstall()
  const deps = await buildRealDeps()
  const cryptoMod = buildFakeCrypto()

  // Capture pre-import disk state.
  const idPath = path.join(TEST_USERDATA, 'identities.json')
  const idJsonBefore = JSON.parse(fs.readFileSync(idPath, 'utf-8'))
  ok('pre-import: 1 identity (Default)', idJsonBefore.length === 1)

  // Patch identityManager.create to throw on the 2nd call (after Alice is
  // created and persisted to disk).
  const realCreate = deps.identityManager.create.bind(deps.identityManager)
  let calls = 0
  deps.identityManager.create = (opts) => {
    calls++
    if (calls === 2) throw new Error('simulated mid-flight failure')
    return realCreate(opts)
  }

  const r = await importer.runImport({
    reader,
    crypto: cryptoMod,
    ghostDataDir: dir,
    deps,
  })

  ok('ok = false', r.ok === false)
  ok('error.code = IMPORT_FAILED', r.error && r.error.code === 'IMPORT_FAILED')
  ok('rolledBack = true', r.rolledBack === true)
  ok('no rollbackError', !r.rollbackError)

  // Assert disk state actually reverted.
  const idJsonAfter = JSON.parse(fs.readFileSync(idPath, 'utf-8'))
  ok(
    'identities.json restored to pre-import (1 entry)',
    idJsonAfter.length === 1,
    `actual: ${idJsonAfter.length} entries`,
  )
  ok('restored identity is Default', idJsonAfter[0] && idJsonAfter[0].isDefault === true)
  ok('state sidecar NOT written on failure', importer.readState(TEST_USERDATA) === null)
}

async function testReinstantiationSeesImport() {
  section('Re-instantiation — fresh managers see persisted import')
  const { dir } = await buildSyntheticGhostInstall()
  const deps = await buildRealDeps()
  const cryptoMod = buildFakeCrypto()

  const r = await importer.runImport({
    reader,
    crypto: cryptoMod,
    ghostDataDir: dir,
    deps,
  })
  ok('import ok', r.ok === true, JSON.stringify(r.error))

  // Now re-instantiate (simulates next app launch).
  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/bookmark-manager.js')]
  const IM2 = require('../browser/identity-manager.js')
  const WM2 = require('../browser/workspace-manager.js')
  const BM2 = require('../browser/bookmark-manager.js')

  const im2 = new IM2.IdentityManager()
  const wm2 = new WM2.WorkspaceManager({ dataDir: TEST_USERDATA })
  const bm2 = new BM2.BookmarkManager({ dataDir: TEST_USERDATA })

  ok('re-instantiated IM lists 3 identities', im2.list().length === 3)
  ok(
    're-instantiated IM has Alice',
    im2.list().some((i) => i.name === 'Alice'),
  )
  ok('re-instantiated WM lists 2 workspaces', wm2.list().length === 2)
  ok(
    're-instantiated WM has "My Project"',
    wm2.list().some((w) => w.name === 'My Project'),
  )
  ok('re-instantiated BM lists 1 bookmark', bm2.list().length === 1)
}

// ---------- Main ----------
async function main() {
  try {
    await testHappyPath()
    await testRollbackOnFailure()
    await testReinstantiationSeesImport()
  } finally {
    // Best-effort cleanup
    try {
      fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
    try {
      fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
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
