// OZ Browser — Team Manager (Bloque E-5).
//
// Orquestador del team mode. Combina:
//   - team-identity (X25519 keypair + memberId, ECDH key half)
//   - team-keystore (ECIES wrap/unwrap del masterKey)
//   - invite-token (oz://team/invite tokens)
//   - vault (replaceMasterKey + archiveMasterKey on join)
//   - backupManager (createSnapshot pre-team-join safety net)
//   - dropbox-client (upload/download/list de /team/ paths)
//
// Doc: docs/modules/team-manager.md
// ADR: docs/architecture/0027-team-mode.md
//
// State persistido en userData/team.json:
//   {
//     "role": "standalone" | "owner" | "member",
//     "teamId": "uuid" | null,
//     "ownerMemberId": "uuid" | null,
//     "myMemberId": "uuid",     // also lives in team-identity.json; cached aquí
//     "joinedAt": "ISO" | null,
//     "schemaVersion": 1
//   }
//
// Dropbox /team/ layout:
//   /team/teamId.json                       (plaintext: { id, ownerMemberId, createdAt })
//   /team/members/<memberId>.pub            (32-byte X25519 pub, base64url)
//   /team/wrapped-keys/<memberId>.bin       (124-byte ECIES blob)

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const log = require('./logger')
const { wrapMasterKey, unwrapMasterKey, BLOB_LEN } = require('./team-keystore')
const {
  generateInviteToken,
  parseInviteToken,
  extractTokenFromUrl,
  isExpired,
} = require('./invite-token')

const STATE_FILENAME = 'team.json'
const SCHEMA_VERSION = 1
const TEAM_ROOT = '/team'
const TEAM_ID_FILE = `${TEAM_ROOT}/teamId.json`
const MEMBERS_DIR = `${TEAM_ROOT}/members`
const WRAPPED_KEYS_DIR = `${TEAM_ROOT}/wrapped-keys`
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_POLL_TIMEOUT_MS = 60_000

class TeamError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'TEAM_ERROR'
  }
}

function _initialState() {
  return {
    role: 'standalone',
    teamId: null,
    ownerMemberId: null,
    myMemberId: null,
    joinedAt: null,
    schemaVersion: SCHEMA_VERSION,
  }
}

function _readState(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return _initialState()
    return { ..._initialState(), ...obj }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('team-manager', 'state read failed', { message: err.message })
    }
    return _initialState()
  }
}

function _b64urlDecode(str) {
  const pad = str.length % 4
  if (pad) str += '='.repeat(4 - pad)
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function _b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function _genUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * Factory. All dependencies injected for testability.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {object} opts.vault            account-vault instance
 * @param {object} opts.backupManager
 * @param {object} opts.teamIdentity     createTeamIdentity instance
 * @param {object} opts.dropboxClient    createDropboxClient instance
 */
function createTeamManager({
  userDataDir,
  vault,
  backupManager,
  teamIdentity,
  dropboxClient,
}) {
  if (!userDataDir) throw new TeamError('userDataDir required', 'BAD_ARG')
  if (!vault) throw new TeamError('vault required', 'BAD_ARG')
  if (!backupManager) throw new TeamError('backupManager required', 'BAD_ARG')
  if (!teamIdentity) throw new TeamError('teamIdentity required', 'BAD_ARG')
  if (!dropboxClient) throw new TeamError('dropboxClient required', 'BAD_ARG')

  const stateFile = path.join(userDataDir, STATE_FILENAME)
  let state = _readState(stateFile)
  // Inject memberId from identity on first load.
  if (!state.myMemberId) {
    state.myMemberId = teamIdentity.getMemberId()
    _flush()
  }

  function _flush() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = stateFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      fs.renameSync(tmp, stateFile)
    } catch (err) {
      log.warn('team-manager', 'state flush failed', { message: err.message })
    }
  }

  function getStatus() {
    return { ...state }
  }

  function _requireUnlockedVault() {
    if (!vault.isUnlocked || !vault.getMasterKey) {
      throw new TeamError('Vault locked — unlock first', 'LOCKED')
    }
    const mk = vault.getMasterKey()
    if (!mk) throw new TeamError('Vault locked — unlock first', 'LOCKED')
    return mk
  }

  async function _uploadOwnPubKey() {
    const me = teamIdentity.ensureIdentity()
    const pubBuf = teamIdentity.getPublicKey()
    await dropboxClient.upload({
      path: `${MEMBERS_DIR}/${me.memberId}.pub`,
      contents: Buffer.from(_b64urlEncode(pubBuf), 'utf-8'),
      mode: 'overwrite',
    })
  }

  // ---------- standalone → owner ----------

  async function createTeam() {
    if (state.role !== 'standalone') {
      throw new TeamError(`Cannot createTeam from role=${state.role}`, 'BAD_ROLE')
    }
    _requireUnlockedVault()
    await dropboxClient.ensureFolder(TEAM_ROOT)
    await dropboxClient.ensureFolder(MEMBERS_DIR)
    await dropboxClient.ensureFolder(WRAPPED_KEYS_DIR)
    const me = teamIdentity.ensureIdentity()
    const teamId = _genUuid()
    const teamRec = {
      id: teamId,
      ownerMemberId: me.memberId,
      createdAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
    }
    await dropboxClient.upload({
      path: TEAM_ID_FILE,
      contents: Buffer.from(JSON.stringify(teamRec, null, 2), 'utf-8'),
      mode: 'overwrite',
    })
    await _uploadOwnPubKey()
    state = {
      ...state,
      role: 'owner',
      teamId,
      ownerMemberId: me.memberId,
      myMemberId: me.memberId,
      joinedAt: new Date().toISOString(),
    }
    _flush()
    log.info('team-manager', 'team created', { teamId, ownerMemberId: me.memberId })
    return { ok: true, teamId, ownerMemberId: me.memberId }
  }

  function generateInvite({ ttlMs } = {}) {
    if (state.role !== 'owner') {
      throw new TeamError('Only owner can generate invites', 'BAD_ROLE')
    }
    const pubBuf = teamIdentity.getPublicKey()
    return generateInviteToken({
      teamId: state.teamId,
      ownerMemberId: state.ownerMemberId,
      ownerPublicKey: pubBuf,
      ttlMs,
    })
  }

  // ---------- standalone → member (acceptInvite) ----------

  async function _pollForWrappedKey(memberId, { pollIntervalMs, pollTimeoutMs }) {
    const interval = pollIntervalMs || DEFAULT_POLL_INTERVAL_MS
    const timeout = pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS
    const remotePath = `${WRAPPED_KEYS_DIR}/${memberId}.bin`
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        const r = await dropboxClient.download(remotePath)
        if (Buffer.isBuffer(r.contents) && r.contents.length === BLOB_LEN) {
          return r.contents
        }
        log.warn('team-manager', 'wrapped key unexpected size', {
          len: r.contents && r.contents.length,
        })
      } catch (err) {
        // path/not_found while owner hasn't wrapped yet — expected, keep polling.
        const summary = (err && err.message) || ''
        if (!/not_found/i.test(summary)) {
          log.warn('team-manager', 'pollForWrappedKey failed (continuing)', {
            message: err.message,
            code: err.code,
          })
        }
      }
      await new Promise((r) => setTimeout(r, interval))
    }
    return null // timed out
  }

  async function acceptInvite(tokenStrOrUrl, opts = {}) {
    if (state.role !== 'standalone') {
      throw new TeamError(`Cannot acceptInvite from role=${state.role}`, 'BAD_ROLE')
    }
    const tokenStr = tokenStrOrUrl.startsWith('oz://')
      ? extractTokenFromUrl(tokenStrOrUrl)
      : tokenStrOrUrl
    const tokenObj = parseInviteToken(tokenStr)
    if (isExpired(tokenObj)) throw new TeamError('Invite expired', 'EXPIRED')
    _requireUnlockedVault()

    // 1. Pre-team-join safety snapshot (local-only, encrypted with OLD masterKey)
    let preJoinSnapshot
    try {
      preJoinSnapshot = backupManager.createSnapshot({
        reason: 'pre-team-join',
        label: `pre-team-join ${new Date().toISOString().slice(0, 19)}`,
      })
    } catch (err) {
      throw new TeamError(`Pre-join snapshot failed: ${err.message}`, 'PRE_JOIN_FAILED')
    }

    // 2. Archive current master key under a recoverable label
    const archiveLabel = `pre-team-join-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const archive = vault.archiveMasterKey(archiveLabel)

    // 3. Ensure own team identity + upload pub key for owner to see
    const me = teamIdentity.ensureIdentity()
    await dropboxClient.ensureFolder(MEMBERS_DIR)
    await dropboxClient.ensureFolder(WRAPPED_KEYS_DIR)
    await _uploadOwnPubKey()

    // 4. Poll for wrapped-key from owner
    const blob = await _pollForWrappedKey(me.memberId, opts)
    if (!blob) {
      throw new TeamError(
        'Owner did not wrap key within timeout (poll again later via retryAcceptInvite)',
        'PENDING',
      )
    }

    // 5. Unwrap with own private key
    let newMasterKey
    try {
      newMasterKey = unwrapMasterKey(
        teamIdentity.getPrivateKey(),
        teamIdentity.getPublicKey(),
        blob,
      )
    } catch (err) {
      throw new TeamError(`Unwrap failed: ${err.message}`, err.code || 'UNWRAP_FAILED')
    }

    // 6. Replace vault master key (wipes accounts as side effect)
    vault.replaceMasterKey(newMasterKey, { preserveAccounts: false })
    newMasterKey.fill(0)

    // 7. Update state
    state = {
      ...state,
      role: 'member',
      teamId: tokenObj.teamId,
      ownerMemberId: tokenObj.ownerMemberId,
      myMemberId: me.memberId,
      joinedAt: new Date().toISOString(),
    }
    _flush()
    log.warn('team-manager', 'JOINED team (destructive: pre-join data archived)', {
      teamId: tokenObj.teamId,
      preJoinSnapshotId: preJoinSnapshot.id,
      keyArchive: archive.archiveAccount,
    })
    return {
      ok: true,
      teamId: tokenObj.teamId,
      ownerMemberId: tokenObj.ownerMemberId,
      preJoinSnapshotId: preJoinSnapshot.id,
      keyArchive: archive.archiveAccount,
    }
  }

  // ---------- owner daemon ----------

  async function wrapKeyForPendingMembers() {
    if (state.role !== 'owner') return { ok: true, wrapped: 0, reason: 'not-owner' }
    if (!vault.isUnlocked) return { ok: true, wrapped: 0, reason: 'vault-locked' }
    const mk = vault.getMasterKey()
    if (!mk) return { ok: true, wrapped: 0, reason: 'no-master-key' }

    const membersPage = await dropboxClient.listFolderAll(MEMBERS_DIR)
    const wrappedPage = await dropboxClient.listFolderAll(WRAPPED_KEYS_DIR)
    const wrappedSet = new Set(
      wrappedPage.entries
        .filter((e) => !e.isFolder && /\.bin$/.test(e.name))
        .map((e) => e.name.replace(/\.bin$/, '')),
    )
    let wrapped = 0
    for (const entry of membersPage.entries) {
      if (entry.isFolder) continue
      if (!/\.pub$/.test(entry.name)) continue
      const memberId = entry.name.replace(/\.pub$/, '')
      if (memberId === state.ownerMemberId) continue // skip owner self
      if (wrappedSet.has(memberId)) continue
      try {
        const dl = await dropboxClient.download(`${MEMBERS_DIR}/${entry.name}`)
        const pubB64 = dl.contents.toString('utf-8').trim()
        const peerPub = _b64urlDecode(pubB64)
        if (peerPub.length !== 32) {
          log.warn('team-manager', 'member pubkey bad length', {
            memberId,
            len: peerPub.length,
          })
          continue
        }
        const blob = wrapMasterKey(peerPub, mk)
        await dropboxClient.upload({
          path: `${WRAPPED_KEYS_DIR}/${memberId}.bin`,
          contents: blob,
          mode: 'overwrite',
        })
        wrapped++
        log.info('team-manager', 'wrapped masterKey for member', { memberId })
      } catch (err) {
        log.error('team-manager', 'wrap-for-member failed (continuing)', {
          memberId,
          message: err.message,
        })
      }
    }
    return { ok: true, wrapped, totalMembers: membersPage.entries.length }
  }

  // ---------- listings + member ops ----------

  async function listMembers() {
    if (state.role === 'standalone') return []
    const membersPage = await dropboxClient.listFolderAll(MEMBERS_DIR)
    const wrappedPage = await dropboxClient.listFolderAll(WRAPPED_KEYS_DIR)
    const wrappedSet = new Set(
      wrappedPage.entries
        .filter((e) => !e.isFolder && /\.bin$/.test(e.name))
        .map((e) => e.name.replace(/\.bin$/, '')),
    )
    return membersPage.entries
      .filter((e) => !e.isFolder && /\.pub$/.test(e.name))
      .map((e) => {
        const memberId = e.name.replace(/\.pub$/, '')
        return {
          memberId,
          isOwner: memberId === state.ownerMemberId,
          isMe: memberId === state.myMemberId,
          hasWrappedKey: wrappedSet.has(memberId),
          serverModified: e.serverModified,
        }
      })
  }

  async function removeMember(memberId) {
    if (state.role !== 'owner') {
      throw new TeamError('Only owner can remove members', 'BAD_ROLE')
    }
    if (memberId === state.ownerMemberId) {
      throw new TeamError(
        'Owner cannot remove self via removeMember (use disbandTeam)',
        'BAD_ARG',
      )
    }
    try {
      await dropboxClient.delete(`${WRAPPED_KEYS_DIR}/${memberId}.bin`)
    } catch (err) {
      log.warn('team-manager', 'remove wrapped-key failed (may not exist)', {
        memberId,
        message: err.message,
      })
    }
    try {
      await dropboxClient.delete(`${MEMBERS_DIR}/${memberId}.pub`)
    } catch (err) {
      log.warn('team-manager', 'remove pub key failed', {
        memberId,
        message: err.message,
      })
    }
    log.warn('team-manager', 'member removed', { memberId })
    return { ok: true, memberId }
  }

  async function leaveTeam() {
    if (state.role !== 'member') {
      throw new TeamError(`leaveTeam requires role=member, got ${state.role}`, 'BAD_ROLE')
    }
    // Remove our pub + wrapped-key from Dropbox
    const memberId = state.myMemberId
    try {
      await dropboxClient.delete(`${MEMBERS_DIR}/${memberId}.pub`)
    } catch (_) {
      /* ignore */
    }
    try {
      await dropboxClient.delete(`${WRAPPED_KEYS_DIR}/${memberId}.bin`)
    } catch (_) {
      /* ignore */
    }
    // Wipe local team identity + state. Vault keeps the team's masterKey
    // (user can still access their own snapshots created post-join; new
    // snapshots no longer share with the team).
    teamIdentity.clear()
    state = { ..._initialState(), myMemberId: teamIdentity.ensureIdentity().memberId }
    _flush()
    log.warn('team-manager', 'left team', { previousTeamId: state.teamId })
    return { ok: true }
  }

  async function disbandTeam() {
    if (state.role !== 'owner') {
      throw new TeamError(
        `disbandTeam requires role=owner, got ${state.role}`,
        'BAD_ROLE',
      )
    }
    // Delete /team/ folder contents on Dropbox.
    // We delete the root folder; Dropbox handles recursive.
    try {
      await dropboxClient.delete(TEAM_ROOT)
    } catch (err) {
      log.warn('team-manager', 'disband delete failed', { message: err.message })
    }
    state = { ..._initialState(), myMemberId: state.myMemberId }
    _flush()
    log.warn('team-manager', 'team disbanded')
    return { ok: true }
  }

  return {
    getStatus,
    createTeam,
    generateInvite,
    acceptInvite,
    leaveTeam,
    disbandTeam,
    listMembers,
    removeMember,
    wrapKeyForPendingMembers,
    // Test introspection
    _readState: () => ({ ...state }),
  }
}

module.exports = {
  createTeamManager,
  TeamError,
  STATE_FILENAME,
  SCHEMA_VERSION,
  TEAM_ROOT,
  TEAM_ID_FILE,
  MEMBERS_DIR,
  WRAPPED_KEYS_DIR,
  _initialState,
  _readState,
  _genUuid,
}
