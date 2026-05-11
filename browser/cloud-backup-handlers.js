// OZ Browser — Cloud Backup IPC handler map (Bloque D-1.5).
//
// Doc: docs/modules/cloud-backup-handlers.md
// Bloque: D-1.5
//
// Mismo patrón que backup-handlers.js (1.6b). Handler map puro — el registro
// IPC vive en ipc-handlers.js.
//
// Gates:
//   - status/connect/disconnect/setAutoUpload: no requieren vault unlocked
//   - upload/download/list/delete: requieren cloud connected (no vault — los
//     .ozbackup ya son archivos cifrados standalone)
//   - downloadAndRestore: requiere vault unlocked + connected, MISMO pre-
//     restore safety net que backup-handlers.restore

const { shell } = require('electron')
const log = require('./logger')

function _err(code, message, extra = {}) {
  return { __error: { code, message, ...extra } }
}

function buildCloudBackupHandlers(browser) {
  function requireVaultUnlocked() {
    const v = browser.accountVault
    if (!v || !v.isUnlocked) return null
    return v
  }

  function cb() {
    return browser.cloudBackupManager
  }

  function notConfigured() {
    return _err(
      'NOT_CONFIGURED',
      'Cloud backup is not configured (OZ_DROPBOX_APP_KEY missing at build time).',
    )
  }

  function ensureConfigured() {
    if (!cb()) return notConfigured()
    return null
  }

  return {
    /**
     * Returns full status (connected, account, autoUpload, lastUploadAt,
     * lastUploadError, deviceFolder, etc).
     */
    status() {
      if (!cb()) {
        // Return a clean "disconnected, not configured" shape so UI can
        // render the disconnected view + a hint instead of a stack trace.
        return {
          connected: false,
          account: null,
          autoUpload: false,
          deviceFolder: null,
          notConfigured: true,
        }
      }
      try {
        return cb().getStatus()
      } catch (err) {
        return _err('STATUS_FAILED', err.message)
      }
    },

    /**
     * Start OAuth flow. Returns { ok, authUrl } (UI typically just gets
     * { ok } and we open the browser side-effect-style — but we return the
     * URL too for diagnostic / fallback display).
     */
    async connect() {
      try {
        const { authUrl } = cb().connect()
        await shell.openExternal(authUrl)
        return { ok: true, authUrl }
      } catch (err) {
        log.error('cloud-backup-handlers', 'connect failed', { message: err.message })
        return _err('CONNECT_FAILED', err.message)
      }
    },

    /**
     * Disconnect = clear tokens + reset state (preserves autoUpload pref).
     */
    disconnect() {
      try {
        const r = cb().disconnect()
        browser.broadcastToWebUI('oz:cloud-backup:changed')
        return r
      } catch (err) {
        log.error('cloud-backup-handlers', 'disconnect failed', { message: err.message })
        return _err('DISCONNECT_FAILED', err.message)
      }
    },

    setAutoUpload(enabled) {
      try {
        const r = cb().setAutoUpload(!!enabled)
        browser.broadcastToWebUI('oz:cloud-backup:changed')
        return { ok: true, ...r }
      } catch (err) {
        return _err('SET_AUTOUPLOAD_FAILED', err.message)
      }
    },

    /**
     * Manual upload of a specific local snapshot.
     */
    async uploadNow(snapshotId) {
      if (!snapshotId) return _err('BAD_ARG', 'snapshotId required')
      try {
        const r = await cb().uploadSnapshot(snapshotId)
        browser.broadcastToWebUI('oz:cloud-backup:changed')
        return { ok: true, ...r }
      } catch (err) {
        log.error('cloud-backup-handlers', 'uploadNow failed', {
          snapshotId,
          message: err.message,
        })
        return _err(err.code || 'UPLOAD_FAILED', err.message)
      }
    },

    /**
     * List snapshots for a specific device (defaults to current).
     */
    async listRemoteSnapshots(deviceFolder) {
      try {
        return await cb().listRemoteSnapshots(deviceFolder)
      } catch (err) {
        log.error('cloud-backup-handlers', 'listRemoteSnapshots failed', {
          deviceFolder,
          message: err.message,
        })
        return _err(err.code || 'LIST_REMOTE_FAILED', err.message)
      }
    },

    /**
     * Enumerate all devices that have uploaded snapshots to this account.
     */
    async listDevices() {
      try {
        return await cb().listDevices()
      } catch (err) {
        log.error('cloud-backup-handlers', 'listDevices failed', {
          message: err.message,
        })
        return _err(err.code || 'LIST_DEVICES_FAILED', err.message)
      }
    },

    /**
     * Download + restore from cloud. Vault MUST be unlocked. Auto-creates
     * a pre-restore safety snapshot first (same convention as local restore).
     */
    async downloadAndRestore({ snapshotId, deviceFolder } = {}) {
      if (!requireVaultUnlocked()) {
        return _err('LOCKED', 'Vault is locked — call oz.vault.unlock() first')
      }
      if (!snapshotId) return _err('BAD_ARG', 'snapshotId required')
      let preRestoreId = null
      try {
        const pre = browser.backupManager.createSnapshot({
          reason: 'pre-restore',
          label: `Auto pre-restore (cloud, ${new Date().toISOString().slice(0, 19)})`,
        })
        preRestoreId = pre.id
      } catch (err) {
        log.error('cloud-backup-handlers', 'pre-restore failed', {
          message: err.message,
        })
        return _err(
          'PRE_RESTORE_FAILED',
          `Could not create pre-restore snapshot: ${err.message}`,
        )
      }
      try {
        const r = await cb().restoreFromCloud(snapshotId, deviceFolder)
        if (browser.accountVault && browser.accountVault.isUnlocked) {
          browser.accountVault.lock()
        }
        browser.broadcastToWebUI('oz:vault:changed')
        browser.broadcastToWebUI('oz:timemachine:changed')
        browser.broadcastToWebUI('oz:cloud-backup:changed')
        browser.broadcastToWebUI('oz:timemachine:restore-completed', {
          id: snapshotId,
          preRestoreId,
          source: 'cloud',
          deviceFolder: deviceFolder || cb().getStatus().deviceFolder,
        })
        return {
          ok: true,
          id: snapshotId,
          preRestoreId,
          deviceFolder: deviceFolder || cb().getStatus().deviceFolder,
          restoredCount: r.restoredCount,
          header: r.header,
          requiresRestart: true,
        }
      } catch (err) {
        log.error('cloud-backup-handlers', 'downloadAndRestore failed', {
          snapshotId,
          deviceFolder,
          message: err.message,
        })
        return _err(err.code || 'RESTORE_FAILED', err.message, { preRestoreId })
      }
    },

    /**
     * Delete a remote snapshot.
     */
    async deleteRemote({ snapshotId, deviceFolder } = {}) {
      if (!snapshotId) return _err('BAD_ARG', 'snapshotId required')
      try {
        const r = await cb().deleteRemoteSnapshot(snapshotId, deviceFolder)
        browser.broadcastToWebUI('oz:cloud-backup:changed')
        return r
      } catch (err) {
        log.error('cloud-backup-handlers', 'deleteRemote failed', {
          snapshotId,
          deviceFolder,
          message: err.message,
        })
        return _err(err.code || 'DELETE_REMOTE_FAILED', err.message)
      }
    },
  }
}

module.exports = { buildCloudBackupHandlers }
