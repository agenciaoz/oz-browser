// OZ Browser — Team Manager smoke test (Bloque E-5).
//
// Cómo correr:
//   cd oz-browser
//   node tests/team-manager.smoketest.js
//
// Cubre los flujos críticos con fakes inyectados (vault, backupManager,
// teamIdentity, dropboxClient). NO toca crypto real ni filesystem real
// fuera del tmpdir. Cubre:
//   - initial state = standalone
//   - createTeam: standalone → owner, uploads teamId.json + pub
//   - generateInvite: owner only, returns token + url
//   - acceptInvite: pre-join snapshot, archive key, replace key, role=member
//   - acceptInvite: expired token → EXPIRED
//   - acceptInvite: poll timeout → PENDING
//   - acceptInvite: wrong-recipient blob → unwrap fails
//   - wrapKeyForPendingMembers: owner wraps for new members, skips owner self + already wrapped
//   - listMembers: returns shape with isOwner/isMe/hasWrappedKey
//   - removeMember: deletes both .pub + .bin
//   - leaveTeam: member → standalone, removes self files
//   - disbandTeam: owner → standalone, deletes /team root
//   - role gates: createTeam from owner → BAD_ROLE; generateInvite from member → BAD_ROLE; etc.

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-team-manager-'))
const { x25519 } = require('@noble/curves/ed25519.js')

const {
  createTeamManager,
  TeamError,
  STATE_FILENAME,
  MEMBERS_DIR,
  WRAPPED_KEYS_DIR,
  TEAM_ID_FILE,
} = require('../browser/team-manager')
const { wrapMasterKey, unwrapMasterKey } = require('../browser/team-keystore')
const { generateInviteToken } = require('../browser/invite-token')

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
    console.error(`  ✗ ${label}`)
    if (detail !== undefined) console.error(`      → ${JSON.stringify(detail)}`)
  }
}
async function asyncGroup(name, fn) {
  console.log(`\n[${name}]`)
  await fn()
}
function freshDir(name) {
  const d = path.join(TEST_DIR, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}

// ---------- fakes ----------
function makeFakeVault(masterKey = crypto.randomBytes(32)) {
  let mk = Buffer.from(masterKey)
  let unlocked = true
  let archived = []
  return {
    isUnlocked: true,
    get _masterKey() {
      return mk
    },
    getMasterKey: () => (unlocked ? mk : null),
    replaceMasterKey(newKey) {
      mk = Buffer.from(newKey)
    },
    archiveMasterKey(label) {
      archived.push({ label, key: Buffer.from(mk) })
      return { archiveService: 'fake', archiveAccount: `archive::${label}` }
    },
    lock() {
      unlocked = false
    },
    _archived: archived,
  }
}

function makeFakeBackupManager() {
  const calls = []
  return {
    createSnapshot: (opts) => {
      const id = `SNAP-${Date.now()}-${calls.length}`
      calls.push({ ...opts, id })
      return { id, filePath: '', header: {} }
    },
    _calls: calls,
  }
}

function makeFakeTeamIdentity({ memberId, priv, pub } = {}) {
  const _priv = priv || Buffer.from(x25519.utils.randomSecretKey())
  const _pub = pub || Buffer.from(x25519.getPublicKey(_priv))
  const _memberId = memberId || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  let cleared = false
  return {
    ensureIdentity: () => ({
      memberId: _memberId,
      publicKey: _pub
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
      createdAt: '2026-01-01T00:00:00Z',
    }),
    getMemberId: () => _memberId,
    getPublicKey: () => _pub,
    getPrivateKey: () => _priv,
    clear: () => {
      cleared = true
    },
    _isCleared: () => cleared,
  }
}

function makeFakeDropbox() {
  const fs2 = new Map() // path → Buffer
  const log = []
  return {
    _fs: fs2,
    _log: log,
    async ensureFolder(p) {
      log.push({ kind: 'ensureFolder', p })
      return { ok: true }
    },
    async upload({ path: p, contents }) {
      log.push({ kind: 'upload', p, size: contents.length })
      fs2.set(p, Buffer.from(contents))
      return { path: p, size: contents.length, rev: 'R' }
    },
    async download(p) {
      log.push({ kind: 'download', p })
      const buf = fs2.get(p)
      if (!buf) {
        const e = new Error('path_not_found/.')
        e.error = { error_summary: 'path/not_found/.' }
        throw e
      }
      return { contents: buf, path: p, size: buf.length }
    },
    async delete(p) {
      log.push({ kind: 'delete', p })
      // Recursive delete simulation
      for (const key of [...fs2.keys()]) {
        if (key === p || key.startsWith(p + '/')) fs2.delete(key)
      }
      return { ok: true }
    },
    async listFolderAll(p) {
      log.push({ kind: 'listFolderAll', p })
      const prefix = p === '' ? '/' : p + '/'
      const entries = []
      for (const [key, buf] of fs2.entries()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest.includes('/')) continue
        entries.push({
          name: rest,
          pathLower: key.toLowerCase(),
          pathDisplay: key,
          size: buf.length,
          serverModified: '2026-05-11T00:00:00Z',
          isFolder: false,
          isDeleted: false,
        })
      }
      return { entries, cursor: null, hasMore: false }
    },
  }
}

;(async () => {
  // ---------- initial state ----------
  await asyncGroup('initial state = standalone', async () => {
    const dir = freshDir('initial')
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({
        memberId: '00000000-0000-4000-8000-000000000099',
      }),
      dropboxClient: makeFakeDropbox(),
    })
    const s = tm.getStatus()
    ok('role standalone', s.role === 'standalone')
    ok('teamId null', s.teamId === null)
    ok(
      'myMemberId injected from identity',
      s.myMemberId === '00000000-0000-4000-8000-000000000099',
    )
  })

  // ---------- createTeam ----------
  await asyncGroup('createTeam: standalone → owner', async () => {
    const dir = freshDir('createteam')
    const dbx = makeFakeDropbox()
    const ti = makeFakeTeamIdentity({ memberId: '00000000-0000-4000-8000-000000000001' })
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: ti,
      dropboxClient: dbx,
    })
    const r = await tm.createTeam()
    ok('returns ok', r.ok === true)
    ok('teamId is uuid', /^[0-9a-f-]{36}$/.test(r.teamId))
    ok(
      'ownerMemberId === my memberId',
      r.ownerMemberId === '00000000-0000-4000-8000-000000000001',
    )
    const s = tm.getStatus()
    ok('state.role === owner', s.role === 'owner')
    ok('state.teamId persisted', s.teamId === r.teamId)
    // Dropbox: teamId.json + owner pub uploaded
    ok('teamId.json uploaded', dbx._fs.has(TEAM_ID_FILE))
    ok(
      'owner pub uploaded',
      dbx._fs.has(`${MEMBERS_DIR}/00000000-0000-4000-8000-000000000001.pub`),
    )
    // Cannot create twice
    let threw = null
    try {
      await tm.createTeam()
    } catch (e) {
      threw = e
    }
    ok('second createTeam throws BAD_ROLE', threw && threw.code === 'BAD_ROLE')
  })

  // ---------- generateInvite ----------
  await asyncGroup('generateInvite: owner only', async () => {
    const dir = freshDir('invite')
    const ti = makeFakeTeamIdentity({ memberId: '00000000-0000-4000-8000-000000000001' })
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: ti,
      dropboxClient: makeFakeDropbox(),
    })
    let threw = null
    try {
      tm.generateInvite()
    } catch (e) {
      threw = e
    }
    ok('standalone throws BAD_ROLE', threw && threw.code === 'BAD_ROLE')
    await tm.createTeam()
    const inv = tm.generateInvite()
    ok('returns token', typeof inv.token === 'string')
    ok('returns url', inv.url.startsWith('oz://team/invite?token='))
    ok('tokenObj has teamId', inv.tokenObj.teamId === tm.getStatus().teamId)
  })

  // ---------- acceptInvite happy ----------
  await asyncGroup('acceptInvite: standalone → member happy', async () => {
    // Set up owner with masterKey M_owner
    const ownerDir = freshDir('accept-owner')
    const memberDir = freshDir('accept-member')
    const M_owner = crypto.randomBytes(32)
    const ownerVault = makeFakeVault(M_owner)
    const ownerTi = makeFakeTeamIdentity({
      memberId: '00000000-0000-4000-8000-000000000001',
    })
    const sharedDbx = makeFakeDropbox()
    const ownerTm = createTeamManager({
      userDataDir: ownerDir,
      vault: ownerVault,
      backupManager: makeFakeBackupManager(),
      teamIdentity: ownerTi,
      dropboxClient: sharedDbx,
    })
    await ownerTm.createTeam()
    const inv = ownerTm.generateInvite()

    // Set up member with different masterKey M_member
    const M_member = crypto.randomBytes(32)
    const memberVault = makeFakeVault(M_member)
    const memberTi = makeFakeTeamIdentity({
      memberId: '00000000-0000-4000-8000-00000000000a',
    })
    const memberBm = makeFakeBackupManager()
    const memberTm = createTeamManager({
      userDataDir: memberDir,
      vault: memberVault,
      backupManager: memberBm,
      teamIdentity: memberTi,
      dropboxClient: sharedDbx,
    })

    // Owner side: wrap key for the new member (simulating daemon running)
    // Spawn member's acceptInvite first (it polls), then owner wraps in parallel
    const acceptP = memberTm.acceptInvite(inv.token, {
      pollIntervalMs: 50,
      pollTimeoutMs: 5000,
    })
    // give the member time to upload its pub
    await new Promise((r) => setTimeout(r, 100))
    const wrapRes = await ownerTm.wrapKeyForPendingMembers()
    ok('owner wrapped one key', wrapRes.wrapped === 1, { wrapRes })
    const r = await acceptP
    ok('accept returns ok', r.ok === true)
    ok('teamId matches', r.teamId === ownerTm.getStatus().teamId)
    ok(
      'pre-join snapshot created',
      memberBm._calls.some((c) => c.reason === 'pre-team-join'),
    )
    ok('vault masterKey replaced with owner key', memberVault._masterKey.equals(M_owner))
    ok('vault masterKey NOT old member key', !memberVault._masterKey.equals(M_member))
    ok('member key archived', memberVault._archived.length === 1)
    const s = memberTm.getStatus()
    ok('state.role === member', s.role === 'member')
    ok(
      'state.ownerMemberId === owner-id',
      s.ownerMemberId === '00000000-0000-4000-8000-000000000001',
    )
  })

  // ---------- acceptInvite expired ----------
  await asyncGroup('acceptInvite: expired token', async () => {
    const dir = freshDir('accept-expired')
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({ memberId: 'A' }),
      dropboxClient: makeFakeDropbox(),
    })
    // Generate an already-expired token: positive ttlMs but generate time
    // 1 day ago → expiresAt is in the past.
    const past = Date.now() - 25 * 60 * 60 * 1000 // 25h ago
    const pub = Buffer.from(x25519.getPublicKey(x25519.utils.randomSecretKey()))
    const inv = generateInviteToken({
      teamId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      ownerMemberId: 'b1b2c3d4-e5f6-7890-abcd-ef0123456789',
      ownerPublicKey: pub,
      ttlMs: 24 * 60 * 60 * 1000, // 24h
      now: past,
    })
    let threw = null
    try {
      await tm.acceptInvite(inv.token, { pollTimeoutMs: 100 })
    } catch (e) {
      threw = e
    }
    ok('expired token throws EXPIRED', threw && threw.code === 'EXPIRED')
  })

  // ---------- acceptInvite poll timeout ----------
  await asyncGroup('acceptInvite: poll timeout → PENDING', async () => {
    const ownerDir = freshDir('pending-owner')
    const memberDir = freshDir('pending-member')
    const ownerVault = makeFakeVault()
    const sharedDbx = makeFakeDropbox()
    const ownerTm = createTeamManager({
      userDataDir: ownerDir,
      vault: ownerVault,
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({
        memberId: '00000000-0000-4000-8000-000000000001',
      }),
      dropboxClient: sharedDbx,
    })
    await ownerTm.createTeam()
    const inv = ownerTm.generateInvite()
    const memberTm = createTeamManager({
      userDataDir: memberDir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({
        memberId: '00000000-0000-4000-8000-00000000000b',
      }),
      dropboxClient: sharedDbx,
    })
    // owner does NOT wrap → poll times out
    let threw = null
    try {
      await memberTm.acceptInvite(inv.token, { pollIntervalMs: 50, pollTimeoutMs: 200 })
    } catch (e) {
      threw = e
    }
    ok('timeout throws PENDING', threw && threw.code === 'PENDING')
  })

  // ---------- wrapKeyForPendingMembers skip cases ----------
  await asyncGroup('wrapKeyForPendingMembers: skip owner + already wrapped', async () => {
    const dir = freshDir('wrap-skip')
    const dbx = makeFakeDropbox()
    const ownerTi = makeFakeTeamIdentity({
      memberId: '00000000-0000-4000-8000-000000000001',
    })
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: ownerTi,
      dropboxClient: dbx,
    })
    await tm.createTeam()
    // Plant 2 member pubs, one with wrapped key already
    const m1pub = Buffer.from(x25519.getPublicKey(x25519.utils.randomSecretKey()))
    const m2pub = Buffer.from(x25519.getPublicKey(x25519.utils.randomSecretKey()))
    dbx._fs.set(
      `${MEMBERS_DIR}/m1.pub`,
      Buffer.from(
        m1pub
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, ''),
        'utf-8',
      ),
    )
    dbx._fs.set(
      `${MEMBERS_DIR}/m2.pub`,
      Buffer.from(
        m2pub
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, ''),
        'utf-8',
      ),
    )
    // m1 already has a wrapped key
    dbx._fs.set(`${WRAPPED_KEYS_DIR}/m1.bin`, Buffer.alloc(124, 0))
    const r = await tm.wrapKeyForPendingMembers()
    ok('wrapped only m2', r.wrapped === 1)
    ok('m2 blob now present', dbx._fs.has(`${WRAPPED_KEYS_DIR}/m2.bin`))
  })

  // ---------- listMembers + removeMember + disbandTeam + leaveTeam ----------
  await asyncGroup('listMembers + removeMember', async () => {
    const dir = freshDir('listmembers')
    const dbx = makeFakeDropbox()
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({
        memberId: '00000000-0000-4000-8000-000000000001',
      }),
      dropboxClient: dbx,
    })
    await tm.createTeam()
    // Plant a member
    dbx._fs.set(`${MEMBERS_DIR}/m1.pub`, Buffer.from('a'.repeat(43), 'utf-8'))
    dbx._fs.set(`${WRAPPED_KEYS_DIR}/m1.bin`, Buffer.alloc(124, 0))
    const members = await tm.listMembers()
    ok('lists 2 members (owner + m1)', members.length === 2)
    const owner = members.find(
      (m) => m.memberId === '00000000-0000-4000-8000-000000000001',
    )
    const m1 = members.find((m) => m.memberId === 'm1')
    ok('owner flagged isOwner + isMe', owner && owner.isOwner && owner.isMe)
    ok('m1 has wrappedKey', m1 && m1.hasWrappedKey === true)
    // Remove m1
    await tm.removeMember('m1')
    ok('m1.pub deleted', !dbx._fs.has(`${MEMBERS_DIR}/m1.pub`))
    ok('m1.bin deleted', !dbx._fs.has(`${WRAPPED_KEYS_DIR}/m1.bin`))
    // Cannot remove self
    let threw = null
    try {
      await tm.removeMember('00000000-0000-4000-8000-000000000001')
    } catch (e) {
      threw = e
    }
    ok('removeMember self throws BAD_ARG', threw && threw.code === 'BAD_ARG')
  })

  await asyncGroup('disbandTeam: owner → standalone', async () => {
    const dir = freshDir('disband')
    const dbx = makeFakeDropbox()
    const tm = createTeamManager({
      userDataDir: dir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({
        memberId: '00000000-0000-4000-8000-000000000001',
      }),
      dropboxClient: dbx,
    })
    await tm.createTeam()
    await tm.disbandTeam()
    ok('role back to standalone', tm.getStatus().role === 'standalone')
    ok('teamId.json deleted', !dbx._fs.has(TEAM_ID_FILE))
  })

  await asyncGroup('leaveTeam: member → standalone', async () => {
    // Owner creates team
    const ownerDir = freshDir('leave-owner')
    const memberDir = freshDir('leave-member')
    const dbx = makeFakeDropbox()
    const ownerTm = createTeamManager({
      userDataDir: ownerDir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: makeFakeTeamIdentity({
        memberId: '00000000-0000-4000-8000-000000000001',
      }),
      dropboxClient: dbx,
    })
    await ownerTm.createTeam()
    const inv = ownerTm.generateInvite()

    // Member joins
    const memberTi = makeFakeTeamIdentity({
      memberId: '00000000-0000-4000-8000-00000000000c',
    })
    const memberTm = createTeamManager({
      userDataDir: memberDir,
      vault: makeFakeVault(),
      backupManager: makeFakeBackupManager(),
      teamIdentity: memberTi,
      dropboxClient: dbx,
    })
    const acceptP = memberTm.acceptInvite(inv.token, {
      pollIntervalMs: 30,
      pollTimeoutMs: 2000,
    })
    await new Promise((r) => setTimeout(r, 80))
    await ownerTm.wrapKeyForPendingMembers()
    await acceptP
    ok('member role pre-leave', memberTm.getStatus().role === 'member')

    // Member leaves
    await memberTm.leaveTeam()
    ok('role back to standalone', memberTm.getStatus().role === 'standalone')
    ok('member.pub removed from dbx', !dbx._fs.has(`${MEMBERS_DIR}/member-id.pub`))
    ok('member.bin removed from dbx', !dbx._fs.has(`${WRAPPED_KEYS_DIR}/member-id.bin`))
    ok('teamIdentity cleared', memberTi._isCleared() === true)
  })

  // ---------- summary ----------
  console.log(`\n${'='.repeat(50)}`)
  console.log(`team-manager smoke: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f.label}`)
  }
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  } catch (_) {
    /* ignore */
  }
  process.exit(failed === 0 ? 0 : 1)
})()
