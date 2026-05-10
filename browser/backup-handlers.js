// OZ Browser — Time Machine handler map (1.6b).
//
// Doc: docs/modules/backup-handlers.md
// Bloque: 1.6b
//
// Handler map puro consumido por IPC y MCP — mismo patrón que vault/excel.
// Vault gate uniforme: todas las operaciones requieren vault unlocked
// (porque el .ozbackup se cifra con la master key).
//
// Pre-restore safety net: restoreSnapshot SIEMPRE crea un snapshot del
// estado actual con reason='pre-restore' antes de ejecutar el restore.
// Si el restore falla a mitad, el user puede volver al pre-restore.

const log = require('./logger')

function lockedError(msg) {
  return {
    __error: {
      code: 'LOCKED',
      message: msg || 'Vault is locked — call oz.vault.unlock() first',
    },
  }
}

function buildBackupHandlers(browser) {
  function requireUnlocked() {
    const v = browser.accountVault
    if (!v || !v.isUnlocked) return null
    return v
  }

  return {
    /**
     * Take a snapshot manually or programmatically.
     * @param {{label?, reason?}} opts
     * Returns { ok, id, header } or { __error }.
     */
    create(opts = {}) {
      if (!requireUnlocked()) return lockedError()
      try {
        const r = browser.backupManager.createSnapshot({
          label: opts.label,
          reason: opts.reason || 'manual',
        })
        browser.broadcastToWebUI('oz:timemachine:changed')
        return { ok: true, id: r.id, header: r.header, filePath: r.filePath }
      } catch (err) {
        log.error('backup-handlers', 'create failed', { message: err.message })
        return {
          __error: { code: err.code || 'CREATE_FAILED', message: err.message },
        }
      }
    },

    /**
     * List snapshot metadata (no decrypt).
     * Returns array (always) or { __error }.
     */
    list() {
      try {
        return browser.backupManager.listSnapshots()
      } catch (err) {
        log.error('backup-handlers', 'list failed', { message: err.message })
        return { __error: { code: 'LIST_FAILED', message: err.message } }
      }
    },

    /**
     * Restore. Vault must be unlocked. Auto-creates pre-restore snapshot
     * BEFORE proceeding. Returns { ok, restoredCount, preRestoreId }.
     */
    restore(id) {
      if (!requireUnlocked()) return lockedError()
      if (!id) return { __error: { code: 'BAD_ARG', message: 'id required' } }
      let preRestoreId = null
      try {
        const pre = browser.backupManager.createSnapshot({
          reason: 'pre-restore',
          label: `Auto pre-restore (${new Date().toISOString().slice(0, 19)})`,
        })
        preRestoreId = pre.id
      } catch (err) {
        log.error('backup-handlers', 'pre-restore snapshot failed', {
          message: err.message,
        })
        // Don't proceed if we couldn't take a safety snapshot — the whole
        // point of Time Machine is recoverability.
        return {
          __error: {
            code: 'PRE_RESTORE_FAILED',
            message: `Could not create pre-restore snapshot: ${err.message}`,
          },
        }
      }
      try {
        const r = browser.backupManager.restoreSnapshot(id)
        // After restore, identities/workspaces/vault.enc on disk have changed
        // — but the in-memory state of IdentityManager/WorkspaceManager/Vault
        // still references the OLD data. Lock the vault so the user is forced
        // to unlock again (which re-reads vault.enc from disk = new content).
        // Identities/workspaces require an app restart to re-load — broadcast
        // an event so the UI can show the warning.
        if (browser.accountVault && browser.accountVault.isUnlocked) {
          browser.accountVault.lock()
        }
        browser.broadcastToWebUI('oz:vault:changed')
        browser.broadcastToWebUI('oz:timemachine:changed')
        browser.broadcastToWebUI('oz:timemachine:restore-completed', {
          id,
          preRestoreId,
        })
        return {
          ok: true,
          id,
          preRestoreId,
          restoredCount: r.restoredCount,
          header: r.header,
          requiresRestart: true,
        }
      } catch (err) {
        log.error('backup-handlers', 'restore failed', {
          id,
          message: err.message,
        })
        return {
          __error: {
            code: err.code || 'RESTORE_FAILED',
            message: err.message,
            preRestoreId, // user can roll back to this
          },
        }
      }
    },

    /**
     * Delete a snapshot. Returns { ok, deleted: bool } or { __error }.
     */
    remove(id) {
      if (!id) return { __error: { code: 'BAD_ARG', message: 'id required' } }
      try {
        const deleted = browser.backupManager.deleteSnapshot(id)
        if (deleted) browser.broadcastToWebUI('oz:timemachine:changed')
        return { ok: true, deleted }
      } catch (err) {
        return { __error: { code: 'DELETE_FAILED', message: err.message } }
      }
    },

    /**
     * Apply retention policy now (called automatically after each create
     * but exposed so user can trigger from Settings).
     */
    applyRetention(opts = {}) {
      try {
        const r = browser.backupManager.applyRetention({
          keepDailyDays: opts.keepDailyDays,
        })
        if (r.deletedCount > 0) browser.broadcastToWebUI('oz:timemachine:changed')
        return { ok: true, ...r }
      } catch (err) {
        return { __error: { code: 'RETENTION_FAILED', message: err.message } }
      }
    },
  }
}

module.exports = { buildBackupHandlers }
