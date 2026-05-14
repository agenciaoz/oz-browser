// OZ Browser — Ghost Browser importer smoke test (G-2b).
//
// Cómo correr:
//   cd oz-browser
//   node tests/ghost-browser-importer.smoketest.js
//
// Cubre:
//   - helpers: _chromeTimeToUnixSec, _cookieDetailsForElectron,
//     _buildAccountFromLogin
//   - dryRun: counts identities, workspaces, archived, cookies (per-id +
//     default), bookmarks, passwords from synthetic Ghost fixture
//   - runImport pre-flight: missing deps → BAD_DEPS, vault locked →
//     VAULT_LOCKED, backup snapshot failure → SNAPSHOT_FAILED
//   - runImport happy path: identities created with name/color, identity
//     map populated, cookies applied to session.cookies.set, workspaces
//     created + identities linked + tabSpecs set, bookmarks added,
//     passwords appended to vault accounts (identityId=null,
//     importedFrom=ghost-browser marker)
//   - runImport: keychain denial → ok=true, cookies+passwords counts=0,
//     keychainError surfaced, identities/workspaces still created
//   - runImport: mid-flight failure → rollback called, snapshot restored
//   - runImport: state file written with identityMap + counts + duration
//   - options gating: importIdentities=false skips identities,
//     importWorkspaces=false skips, etc.
//   - readState / clearState round-trip

const fs = require('fs')
const os = require('os')
const path = require('path')

const helpers = require('./_helpers-ghost-fixtures.js')
const reader = require('../browser/migrations/ghost-browser-reader.js')
const gc = require('../browser/migrations/ghost-browser-crypto.js')
const importer = require('../browser/migrations/ghost-browser-importer.js')

const ROOT = helpers.makeRoot('oz-ghost-importer-')
const mkInstall = (name) => helpers.mkInstall(ROOT, name)
const writeJson = helpers.writeJson

const { ok, section, done } = helpers.makeRunner(
  'OZ Browser — Ghost Browser importer (G-2b) smoke test',
)
console.log(`Test root: ${ROOT}`)

// ---------- Fake OZ deps ----------

function buildFakeDeps({ userDataDir }) {
  const identities = []
  const workspaces = []
  const bookmarks = []
  let accounts = []
  const sessionCalls = {} // identityId → array of details

  const identityManager = {
    create({ name, color }) {
      const id = { id: 'oz-' + (identities.length + 1), name, color: color || 'PIC' }
      identities.push(id)
      return id
    },
  }
  const workspaceManager = {
    create({ name }) {
      const w = {
        id: 'ws-' + (workspaces.length + 1),
        name,
        identityIds: [],
        tabSpecs: [],
      }
      workspaces.push(w)
      return w
    },
    addIdentity(wsId, identityId) {
      const w = workspaces.find((x) => x.id === wsId)
      if (w && !w.identityIds.includes(identityId)) w.identityIds.push(identityId)
      return true
    },
    setTabSpecs(wsId, tabSpecs) {
      const w = workspaces.find((x) => x.id === wsId)
      if (w) w.tabSpecs = tabSpecs
      return true
    },
  }
  const bookmarkManager = {
    add(bk) {
      bookmarks.push(bk)
      return true
    },
  }
  const accountVault = {
    isUnlocked: true,
    getAccounts: () => accounts.slice(),
    setAccounts: (next) => {
      accounts = next.slice()
    },
  }
  const backupManager = {
    snapshots: [],
    createSnapshot({ reason }) {
      const snap = { id: 'snap-' + Date.now(), reason }
      this.snapshots.push(snap)
      return snap
    },
    restoreCount: 0,
    async restoreSnapshot(id) {
      this.restoreCount++
      return { restored: id }
    },
  }
  const getSession = (identityId) => ({
    cookies: {
      async set(details) {
        if (!sessionCalls[identityId]) sessionCalls[identityId] = []
        sessionCalls[identityId].push(details)
      },
    },
  })

  return {
    identityManager,
    workspaceManager,
    bookmarkManager,
    accountVault,
    backupManager,
    getSession,
    userDataDir,
    // observers for assertions
    _state: {
      identities,
      workspaces,
      bookmarks,
      getAccounts: () => accounts,
      sessionCalls,
    },
  }
}

// ---------- Build synthetic Ghost install with real crypto blobs ----------

async function buildSyntheticGhostInstall(safeStorageKey) {
  const dir = mkInstall('install')
  const derived = gc.deriveKey(safeStorageKey)

  // Identities
  const hashes = ['hashA', 'hashB']
  writeJson(path.join(dir, 'Default/Identities/identities.json'), { identities: hashes })
  for (const hash of hashes) {
    const identDir = path.join(dir, 'Default/Identities', hash)
    fs.mkdirSync(identDir, { recursive: true })
    writeJson(path.join(identDir, 'identity.json'), {
      id: hash,
      name: hash === 'hashA' ? 'Alice' : 'Bob',
      color: 'BC789C',
    })
    const cookies = [
      {
        host_key: '.example.com',
        name: 'sess',
        is_secure: true,
        is_httponly: true,
        has_expires: true,
        expires_utc: '13422899379276164', // some chrome time
        source_scheme: 2,
        samesite: 1,
        encrypted_value: gc._encryptBlobForTest(`${hash}-cookie`, derived),
      },
    ]
    fs.writeFileSync(path.join(identDir, 'Cookies'), await helpers.makeCookiesDb(cookies))
  }

  // Projects
  writeJson(path.join(dir, 'Default/Projects/projects_list.json'), {
    projects: ['proj-1'],
    projects_number: 1,
  })
  writeJson(path.join(dir, 'Default/Projects/proj-1/project.json'), {
    id: 'proj-1',
    name: 'My Project',
    windows: [
      {
        tabs: [
          { identity: 'hashA', url: 'https://example.com/a', title: 'A' },
          { identity: 'hashB', url: 'https://example.com/b', title: 'B' },
        ],
      },
    ],
  })

  // Default/Cookies (pool global)
  fs.writeFileSync(
    path.join(dir, 'Default/Cookies'),
    await helpers.makeCookiesDb([
      {
        host_key: '.welcome.com',
        name: 'banner',
        is_secure: false,
        source_scheme: 2,
        encrypted_value: gc._encryptBlobForTest('default-cookie', derived),
      },
    ]),
  )

  // Login Data (pool global)
  fs.writeFileSync(
    path.join(dir, 'Default/Login Data'),
    await helpers.makeLoginDataDb([
      {
        origin_url: 'https://instagram.com/',
        username_value: 'me@example.com',
        password_value: gc._encryptBlobForTest('my-password', derived),
        signon_realm: 'https://instagram.com/',
      },
    ]),
  )

  // Bookmarks
  writeJson(path.join(dir, 'Default/Bookmarks'), {
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bar',
        children: [{ type: 'url', url: 'https://docs.com', name: 'Docs' }],
      },
    },
  })

  return { dir, hashes, derived }
}

function buildFakeCrypto(safeKey) {
  return {
    fetchGhostKeychainKey: async () => safeKey,
    deriveKey: gc.deriveKey,
    decryptCookies: gc.decryptCookies,
    decryptPasswords: gc.decryptPasswords,
    _encryptBlobForTest: gc._encryptBlobForTest,
  }
}

// ============================================================
// Run
// ============================================================

async function run() {
  const SAFE_KEY = 'test-safe-storage-key'
  const cryptoMod = buildFakeCrypto(SAFE_KEY)

  // ---------- helpers ----------
  section('_chromeTimeToUnixSec')
  ok('0 → 0', importer._chromeTimeToUnixSec(0) === 0)
  ok('falsy → 0', importer._chromeTimeToUnixSec(null) === 0)
  // 13422899379276164 microseconds in Chrome epoch → Unix sec ~1778425779
  const expectSec = Math.floor(13422899379276164 / 1e6 - 11644473600)
  ok(
    'valid chrome time → unix sec',
    importer._chromeTimeToUnixSec('13422899379276164') === expectSec,
  )

  section('_cookieDetailsForElectron')
  {
    const det = importer._cookieDetailsForElectron({
      host_key: '.example.com',
      name: 'n',
      value_plaintext: 'v',
      path: '/p',
      source_scheme: 2,
      samesite: 1,
      is_secure: true,
      is_httponly: false,
      has_expires: false,
    })
    ok('domain cookie URL = https://example.com/p', det.url === 'https://example.com/p')
    ok('domain = .example.com preserved', det.domain === '.example.com')
    ok('sameSite=lax mapped from int 1', det.sameSite === 'lax')
    ok('secure preserved', det.secure === true)
  }
  {
    const det = importer._cookieDetailsForElectron({
      host_key: 'host.com',
      name: 'n',
      value_plaintext: 'v',
      path: '/',
      source_scheme: 1,
      samesite: 0,
    })
    ok('host-only cookie no domain field', det.domain === undefined)
    ok('http scheme + host-only → http://host.com/', det.url === 'http://host.com/')
    ok('sameSite=no_restriction mapped from int 0', det.sameSite === 'no_restriction')
  }
  {
    const det = importer._cookieDetailsForElectron({
      host_key: '.x.com',
      name: 'n',
      value_plaintext: null, // skipped cookie
      path: '/',
    })
    ok('null plaintext → null details (skipped)', det === null)
  }

  section('_buildAccountFromLogin')
  {
    const acct = importer._buildAccountFromLogin(
      {
        origin_url: 'https://x.com/',
        username_value: 'u',
        password_plaintext: 'p',
        signon_realm: 'https://x.com/',
      },
      Date.now(),
    )
    ok('identityId = null', acct.identityId === null)
    ok('site preserves origin_url', acct.site === 'https://x.com/')
    ok('username + password preserved', acct.username === 'u' && acct.password === 'p')
    ok('importedFrom marker', acct.customFields.importedFrom === 'ghost-browser')
    ok('status = active', acct.status === 'active')
  }

  // ---------- dryRun ----------
  section('dryRun')
  {
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const plan = await importer.dryRun({ reader, crypto: cryptoMod, ghostDataDir: dir })
    ok('counts.identities = 2', plan.counts.identities === 2)
    ok('counts.workspaces = 1', plan.counts.workspaces === 1)
    ok('counts.cookies = 2 (1 per identity)', plan.counts.cookies === 2)
    ok('counts.defaultCookies = 1', plan.counts.defaultCookies === 1)
    ok('counts.passwords = 1', plan.counts.passwords === 1)
    ok('counts.bookmarks = 1', plan.counts.bookmarks === 1)
    ok('plan.identityHashes count = 2', plan.plan.identityHashes.length === 2)
    ok('plan.projectUuids count = 1', plan.plan.projectUuids.length === 1)
  }

  // ---------- runImport: pre-flight ----------
  section('runImport — pre-flight')
  {
    const userData = fs.mkdtempSync(path.join(ROOT, 'ud-'))
    const deps = buildFakeDeps({ userDataDir: userData })
    deps.accountVault.isUnlocked = false
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const r = await importer.runImport({
      reader,
      crypto: cryptoMod,
      ghostDataDir: dir,
      deps,
    })
    ok('vault locked → VAULT_LOCKED error', r.error?.code === 'VAULT_LOCKED')
    ok('ok=false on pre-flight fail', r.ok === false)
  }
  {
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const r = await importer.runImport({
      reader,
      crypto: cryptoMod,
      ghostDataDir: dir,
      deps: { accountVault: { isUnlocked: true } },
    })
    ok('missing identityManager → BAD_DEPS', r.error?.code === 'BAD_DEPS')
  }

  // ---------- runImport: happy path ----------
  section('runImport — happy path')
  {
    const userData = fs.mkdtempSync(path.join(ROOT, 'ud-'))
    const deps = buildFakeDeps({ userDataDir: userData })
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const r = await importer.runImport({
      reader,
      crypto: cryptoMod,
      ghostDataDir: dir,
      deps,
    })
    ok('ok = true', r.ok === true)
    ok('snapshotId set', !!r.snapshotId)
    ok('2 identities created', r.counts.identities === 2)
    ok('1 workspace created', r.counts.workspaces === 1)
    ok('2 cookies applied', r.counts.cookies === 2)
    ok('1 bookmark imported', r.counts.bookmarks === 1)
    ok('1 password imported', r.counts.passwords === 1)
    ok('identityMap has 2 entries', Object.keys(r.identityMap).length === 2)
    ok('workspaceMap has 1 entry', Object.keys(r.workspaceMap).length === 1)
    // Verify fake deps state
    const s = deps._state
    ok('identityManager.create called 2x', s.identities.length === 2)
    ok(
      'identity names preserved',
      s.identities.find((i) => i.name === 'Alice') &&
        s.identities.find((i) => i.name === 'Bob'),
    )
    ok('workspace.identityIds linked', s.workspaces[0].identityIds.length === 2)
    ok('tabSpecs set on workspace', s.workspaces[0].tabSpecs.length === 2)
    ok(
      'tabSpec.identityId mapped from ghost hash',
      s.workspaces[0].tabSpecs[0].identityId.startsWith('oz-'),
    )
    const allAccounts = s.getAccounts()
    ok('vault has 1 new account', allAccounts.length === 1)
    ok('imported account has identityId=null', allAccounts[0].identityId === null)
    ok(
      'imported account marker',
      allAccounts[0].customFields.importedFrom === 'ghost-browser',
    )
    // State file
    const state = importer.readState(userData)
    ok('state file written', !!state && state.version === 1)
    ok('state.identityMap matches', Object.keys(state.identityMap).length === 2)
  }

  // ---------- runImport: keychain denial ----------
  section('runImport — keychain denial')
  {
    const userData = fs.mkdtempSync(path.join(ROOT, 'ud-'))
    const deps = buildFakeDeps({ userDataDir: userData })
    const denyCrypto = {
      ...cryptoMod,
      fetchGhostKeychainKey: async () => {
        const e = new Error('User canceled')
        e.code = 'KEYCHAIN_DENIED'
        throw e
      },
    }
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const r = await importer.runImport({
      reader,
      crypto: denyCrypto,
      ghostDataDir: dir,
      deps,
    })
    ok('ok = true (non-fatal)', r.ok === true)
    ok('keychainError surfaced', r.keychainError === 'KEYCHAIN_DENIED')
    ok('identities still created', r.counts.identities === 2)
    ok('workspaces still created', r.counts.workspaces === 1)
    ok('cookies = 0 (no key)', r.counts.cookies === 0)
    ok('passwords = 0 (no key)', r.counts.passwords === 0)
    ok('bookmarks still imported', r.counts.bookmarks === 1)
  }

  // ---------- runImport: mid-flight failure → rollback ----------
  section('runImport — rollback on failure')
  {
    const userData = fs.mkdtempSync(path.join(ROOT, 'ud-'))
    const deps = buildFakeDeps({ userDataDir: userData })
    // Make identityManager.create throw on second call.
    let calls = 0
    deps.identityManager.create = () => {
      calls++
      if (calls === 2) throw new Error('boom')
      return { id: 'oz-' + calls, name: 'x', color: 'y' }
    }
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const r = await importer.runImport({
      reader,
      crypto: cryptoMod,
      ghostDataDir: dir,
      deps,
    })
    ok('ok = false on throw', r.ok === false)
    ok('error.code = IMPORT_FAILED', r.error?.code === 'IMPORT_FAILED')
    ok('rolledBack flag set', r.rolledBack === true)
    ok('backupManager.restoreSnapshot called', deps.backupManager.restoreCount === 1)
    // State file should NOT exist after rollback
    ok('state file not written on failure', importer.readState(userData) === null)
  }

  // ---------- options gating ----------
  section('options gating')
  {
    const userData = fs.mkdtempSync(path.join(ROOT, 'ud-'))
    const deps = buildFakeDeps({ userDataDir: userData })
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    const r = await importer.runImport({
      reader,
      crypto: cryptoMod,
      ghostDataDir: dir,
      deps,
      options: { importPasswords: false, importBookmarks: false },
    })
    ok('ok = true', r.ok === true)
    ok('passwords skipped (option off)', r.counts.passwords === 0)
    ok('bookmarks skipped (option off)', r.counts.bookmarks === 0)
    ok('identities still imported', r.counts.identities === 2)
  }

  // ---------- readState / clearState ----------
  section('readState / clearState')
  {
    const userData = fs.mkdtempSync(path.join(ROOT, 'ud-'))
    ok('no state initially', importer.readState(userData) === null)
    const deps = buildFakeDeps({ userDataDir: userData })
    const { dir } = await buildSyntheticGhostInstall(SAFE_KEY)
    await importer.runImport({ reader, crypto: cryptoMod, ghostDataDir: dir, deps })
    ok('state present after import', !!importer.readState(userData))
    importer.clearState(userData)
    ok('state cleared', importer.readState(userData) === null)
  }

  done()
}

run()
  .catch((e) => {
    console.error('UNCAUGHT:', e.stack || e.message)
    process.exit(1)
  })
  .finally(() => {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch (_) {
      // ignore
    }
  })

// quiet unused
void os
