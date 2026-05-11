// OZ Browser — Cloud Backup Manager (Bloque D-1.3 / D-1.4).
//
// Orquesta el backup remoto de snapshots Time Machine a Dropbox. Cero
// re-cifrado: los .ozbackup ya son archivos cifrados AES-256-GCM standalone
// (formato 1.6a), se suben tal cual. Master key NUNCA sale del Keychain.
//
// Doc: docs/modules/cloud-backup-manager.md
// ADR: docs/architecture/0025-cloud-backup.md (D-1.8)
//
// Estructura de carpetas en Dropbox (Scoped App Folder = /Apps/OZ Browser/):
//   /<device-folder>/
//     snapshots/
//       2026-05-10T22-00-00.ozbackup
//       2026-05-10T03-00-00.ozbackup
//       ...
//   /<other-device-folder>/
//     snapshots/...
//
// Donde <device-folder> = `${hostnameSlug}-${shortId}` viene de device-info.
// Cada instalación de OZ aterriza en su propia carpeta para no colisionar.
//
// Estado local persistido en `userData/cloud-backup.json`:
//   {
//     "connected": bool,
//     "account": { accountId, email, name } | null,
//     "autoUpload": bool,
//     "lastUploadAt": ISO | null,
//     "lastUploadError": string | null,
//     "lastSyncAt": ISO | null,         // last list refresh
//     "schemaVersion": 1
//   }
//
// Auto-upload: cuando `connected && autoUpload === true` y el BackupManager
// emite 'snapshot-created', subimos en background fire-and-forget. Excluimos
// snapshots de `reason: 'pre-restore'` (son ruido, sucederán muy seguido).
//
// 'pre-quit' SÍ se sube (no queremos perderlo si la Mac muere antes del
// próximo daily cron).

const fs = require('fs')
const path = require('path')
const log = require('./logger')

const STATE_FILENAME = 'cloud-backup.json'
const STATE_SCHEMA_VERSION = 1
const SNAPSHOT_FILENAME_RE = /^[0-9TZ.-]+\.ozbackup$/
const APP_BASE_PATH = '' // App Folder root in Dropbox terms

function _initialState() {
  return {
    connected: false,
    account: null,
    autoUpload: false,
    lastUploadAt: null,
    lastUploadError: null,
    lastSyncAt: null,
    schemaVersion: STATE_SCHEMA_VERSION,
  }
}

/**
 * Factory. Wires up the auto-upload listener at construction time.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {object} opts.deviceInfo       result of device-info.createDeviceInfo
 * @param {object} opts.dropboxClient    result of dropbox-client.createDropboxClient
 * @param {object} opts.backupManager    instance of BackupManager (EventEmitter)
 */
function createCloudBackupManager(opts = {}) {
  const { userDataDir, deviceInfo, dropboxClient, backupManager } = opts
  if (!userDataDir) throw new Error('cloud-backup-manager: userDataDir required')
  if (!deviceInfo) throw new Error('cloud-backup-manager: deviceInfo required')
  if (!dropboxClient) throw new Error('cloud-backup-manager: dropboxClient required')
  if (!backupManager) throw new Error('cloud-backup-manager: backupManager required')

  const stateFile = path.join(userDataDir, STATE_FILENAME)
  let state = _readState(stateFile)
  // In-flight in-memory verifier/state cache for OAuth flow (only valid until
  // the redirect comes back — typically seconds).
  let pendingOAuth = null

  // -------- state I/O --------

  function _flush() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      const tmp = stateFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      fs.renameSync(tmp, stateFile)
    } catch (err) {
      log.warn('cloud-backup', 'state flush failed', { message: err.message })
    }
  }

  // -------- paths --------

  function _deviceFolder() {
    return deviceInfo.getDeviceFolder()
  }

  function _deviceSnapshotsPath(deviceFolder) {
    const df = deviceFolder || _deviceFolder()
    return `${APP_BASE_PATH}/${df}/snapshots`
  }

  // -------- OAuth wrappers --------

  /**
   * Returns { authUrl } — caller opens it via shell.openExternal. Verifier
   * + state stay in memory until the protocol redirect comes back to
   * completeConnect.
   */
  function connect() {
    if (state.connected) {
      // Tolerate re-connect — clear old session first
      log.info('cloud-backup', 're-connect requested, clearing prior session')
    }
    const { authUrl, codeVerifier, state: oauthState } = dropboxClient.startAuth()
    pendingOAuth = { codeVerifier, state: oauthState, startedAt: Date.now() }
    log.info('cloud-backup', 'oauth started')
    return { authUrl, expiresInSeconds: 600 }
  }

  /**
   * Called by the protocol-handler dispatcher when oz://auth/dropbox/callback
   * arrives. Validates state, exchanges code for tokens, fetches account
   * info, persists state.
   */
  async function completeConnect({ code, state: redirectState }) {
    if (!pendingOAuth) {
      throw new Error('No pending OAuth flow — call connect() first')
    }
    const verifier = pendingOAuth.codeVerifier
    const expected = pendingOAuth.state
    pendingOAuth = null
    await dropboxClient.completeAuth({
      code,
      state: redirectState,
      expectedCodeVerifier: verifier,
      expectedState: expected,
    })
    const account = await dropboxClient.getAccountInfo()
    state = {
      ...state,
      connected: true,
      account,
      autoUpload: state.autoUpload, // preserve user preference if set previously
    }
    _flush()
    // Best-effort: ensure the device folder exists in Dropbox so first upload
    // doesn't need to fight a race.
    try {
      await dropboxClient.ensureFolder(_deviceSnapshotsPath())
    } catch (err) {
      log.warn('cloud-backup', 'ensureFolder on connect failed (non-fatal)', {
        message: err.message,
      })
    }
    log.info('cloud-backup', 'connected', {
      email: account && account.email,
      deviceFolder: _deviceFolder(),
    })
    return { ok: true, account, deviceFolder: _deviceFolder() }
  }

  function disconnect() {
    pendingOAuth = null
    try {
      dropboxClient.clearAuth()
    } catch (err) {
      log.warn('cloud-backup', 'clearAuth threw', { message: err.message })
    }
    state = { ..._initialState(), autoUpload: state.autoUpload }
    _flush()
    log.info('cloud-backup', 'disconnected')
    return { ok: true }
  }

  function setAutoUpload(enabled) {
    state = { ...state, autoUpload: !!enabled }
    _flush()
    log.info('cloud-backup', 'autoUpload set', { autoUpload: state.autoUpload })
    return { autoUpload: state.autoUpload }
  }

  function getStatus() {
    return {
      ...state,
      deviceFolder: _deviceFolder(),
      hasPendingOAuth: !!pendingOAuth,
    }
  }

  // -------- upload --------

  /**
   * Upload a specific local snapshot to Dropbox. Reads the .ozbackup file
   * directly from backupManager.snapshotsDir.
   */
  async function uploadSnapshot(snapshotId) {
    if (!state.connected) {
      throw new Error('cloud-backup: not connected')
    }
    const filePath = path.join(backupManager.snapshotsDir, `${snapshotId}.ozbackup`)
    if (!fs.existsSync(filePath)) {
      throw new Error(`cloud-backup: local snapshot not found: ${snapshotId}`)
    }
    const contents = fs.readFileSync(filePath)
    const remotePath = `${_deviceSnapshotsPath()}/${snapshotId}.ozbackup`
    await dropboxClient.ensureFolder(_deviceSnapshotsPath())
    let resp
    try {
      resp = await dropboxClient.upload({ path: remotePath, contents })
    } catch (err) {
      state = {
        ...state,
        lastUploadError: err.message || String(err),
      }
      _flush()
      throw err
    }
    state = {
      ...state,
      lastUploadAt: new Date().toISOString(),
      lastUploadError: null,
    }
    _flush()
    log.info('cloud-backup', 'snapshot uploaded', {
      id: snapshotId,
      sizeBytes: contents.length,
      remotePath: resp.path,
    })
    return { ok: true, snapshotId, remotePath: resp.path, sizeBytes: contents.length }
  }

  // -------- listings --------

  /**
   * List snapshots in Dropbox for a given device. Defaults to current device.
   * Returns array sorted by id descending (newest first).
   *
   * Entries: { id, sizeBytes, serverModified, remotePath }
   */
  async function listRemoteSnapshots(deviceFolder) {
    if (!state.connected) throw new Error('cloud-backup: not connected')
    const folder = _deviceSnapshotsPath(deviceFolder)
    const items = await dropboxClient.listFolder(folder)
    const snaps = []
    for (const e of items) {
      if (e.isFolder) continue
      if (!SNAPSHOT_FILENAME_RE.test(e.name)) continue
      snaps.push({
        id: e.name.replace(/\.ozbackup$/, ''),
        sizeBytes: e.size,
        serverModified: e.serverModified,
        remotePath: e.pathDisplay || e.pathLower,
      })
    }
    snaps.sort((a, b) => (a.id < b.id ? 1 : -1))
    state = { ...state, lastSyncAt: new Date().toISOString() }
    _flush()
    return snaps
  }

  /**
   * Download a snapshot from Dropbox to the local snapshotsDir. Returns
   *   { localPath, deviceFolder, sizeBytes, contentHash }.
   *
   * Same-id collisions are safe: .ozbackup is AES-256-GCM authenticated,
   * so two files with the same id MUST decrypt to the same plaintext (or
   * one will fail decryption). Cross-device timestamp collisions are
   * statistically negligible (millisecond precision).
   *
   * NOTE: caller is responsible for invoking BackupManager.restoreSnapshot
   * separately if a restore is the goal — or use restoreFromCloud below.
   */
  async function downloadSnapshot(snapshotId, fromDeviceFolder) {
    if (!state.connected) throw new Error('cloud-backup: not connected')
    if (!snapshotId || typeof snapshotId !== 'string') {
      throw new Error('cloud-backup: snapshotId required')
    }
    const folder = _deviceSnapshotsPath(fromDeviceFolder)
    const remotePath = `${folder}/${snapshotId}.ozbackup`
    const resp = await dropboxClient.download(remotePath)
    const localPath = path.join(backupManager.snapshotsDir, `${snapshotId}.ozbackup`)
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    const tmp = localPath + '.dl'
    fs.writeFileSync(tmp, resp.contents)
    fs.renameSync(tmp, localPath)
    log.info('cloud-backup', 'snapshot downloaded', {
      snapshotId,
      fromDeviceFolder: fromDeviceFolder || _deviceFolder(),
      sizeBytes: resp.contents.length,
    })
    return {
      localPath,
      deviceFolder: fromDeviceFolder || _deviceFolder(),
      sizeBytes: resp.contents.length,
      contentHash: resp.contentHash,
    }
  }

  /**
   * Download + restore in one call. Same vault precondition as
   * BackupManager.restoreSnapshot — vault must be unlocked. Caller
   * (handler layer) is responsible for creating the `pre-restore`
   * snapshot before invoking this, same convention as the local restore
   * path in backup-handlers.js.
   */
  async function restoreFromCloud(snapshotId, fromDeviceFolder) {
    await downloadSnapshot(snapshotId, fromDeviceFolder)
    return backupManager.restoreSnapshot(snapshotId)
  }

  /**
   * Enumerate devices that have ever uploaded snapshots to this Dropbox
   * account (= sibling folders under the app root). For each device, count
   * snapshots + capture latest timestamp + total size.
   *
   * Cost: 1 listFolder for root + 1 per device. With <20 devices (realistic
   * cap for team mode) this is O(N) round-trips at ~100ms each = <2s. If
   * we ever go higher we'll add a parallelism cap, but premature for v1.
   *
   * Returns array sorted current-device-first, then alphabetical:
   *   {
   *     deviceFolder, isCurrentDevice,
   *     snapshotCount, latestSnapshotId, latestSnapshotAt,
   *     totalSizeBytes
   *   }
   */
  async function listDevices() {
    if (!state.connected) throw new Error('cloud-backup: not connected')
    const rootItems = await dropboxClient.listFolder(APP_BASE_PATH || '')
    const currentFolder = _deviceFolder()
    const out = []
    for (const e of rootItems) {
      if (!e.isFolder) continue
      const deviceFolder = e.name
      let snaps = []
      try {
        snaps = await listRemoteSnapshots(deviceFolder)
      } catch (err) {
        log.warn('cloud-backup', 'listDevices: snapshot listing failed', {
          deviceFolder,
          message: err.message,
        })
      }
      const latest = snaps[0] || null
      out.push({
        deviceFolder,
        isCurrentDevice: deviceFolder === currentFolder,
        snapshotCount: snaps.length,
        latestSnapshotId: latest ? latest.id : null,
        latestSnapshotAt: latest ? latest.serverModified : null,
        totalSizeBytes: snaps.reduce((acc, s) => acc + (s.sizeBytes || 0), 0),
      })
    }
    out.sort((a, b) => {
      if (a.isCurrentDevice && !b.isCurrentDevice) return -1
      if (!a.isCurrentDevice && b.isCurrentDevice) return 1
      return a.deviceFolder < b.deviceFolder ? -1 : 1
    })
    return out
  }

  /**
   * Delete a remote snapshot.
   */
  async function deleteRemoteSnapshot(snapshotId, deviceFolder) {
    if (!state.connected) throw new Error('cloud-backup: not connected')
    const folder = _deviceSnapshotsPath(deviceFolder)
    const remotePath = `${folder}/${snapshotId}.ozbackup`
    await dropboxClient.delete(remotePath)
    log.info('cloud-backup', 'remote snapshot deleted', { snapshotId, remotePath })
    return { ok: true, snapshotId }
  }

  // -------- auto-upload hook --------

  /**
   * Called by main.js once Vault is unlocked + BackupManager exists. Wires
   * the listener that auto-uploads snapshots when enabled.
   */
  function init() {
    backupManager.on('snapshot-created', (info) => {
      // Cheap pre-checks before kicking off async work.
      if (!state.connected || !state.autoUpload) return
      // pre-restore snapshots are intermediate state; skip them to avoid
      // amplification (each restore would push noise to Dropbox).
      if (info.header && info.header.reason === 'pre-restore') return
      log.info('cloud-backup', 'auto-uploading snapshot', {
        id: info.id,
        reason: info.header && info.header.reason,
      })
      uploadSnapshot(info.id).catch((err) => {
        log.warn('cloud-backup', 'auto-upload failed', {
          id: info.id,
          message: err.message,
          code: err.code,
        })
      })
    })
    log.info('cloud-backup', 'initialized', {
      connected: state.connected,
      autoUpload: state.autoUpload,
      deviceFolder: _deviceFolder(),
    })
  }

  return {
    init,
    getStatus,
    connect,
    completeConnect,
    disconnect,
    setAutoUpload,
    uploadSnapshot,
    downloadSnapshot,
    restoreFromCloud,
    listDevices,
    listRemoteSnapshots,
    deleteRemoteSnapshot,
    // Path accessors (used by D-1.4 cross-device features)
    _deviceSnapshotsPath,
    _deviceFolder,
    // Test helpers
    _readState: () => ({ ...state }),
    _setState: (patch) => {
      state = { ...state, ...patch }
      _flush()
    },
  }
}

function _readState(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || typeof obj.schemaVersion !== 'number') {
      return _initialState()
    }
    return { ..._initialState(), ...obj }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('cloud-backup', 'state read failed, using defaults', {
        message: err.message,
      })
    }
    return _initialState()
  }
}

module.exports = {
  createCloudBackupManager,
  STATE_FILENAME,
  STATE_SCHEMA_VERSION,
  SNAPSHOT_FILENAME_RE,
  _initialState,
  _readState,
}
