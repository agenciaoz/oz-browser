// OZ Browser — Ghost migration handlers (G-3).
//
// Doc: docs/modules/ghost-migration.md (TODO post-G-4)
// Bloque: G-3
//
// IPC + MCP handlers for the Ghost Browser import wizard. Mirrors the
// `name → fn` pattern used by account-handlers / scheduled-handlers /
// workspace-handlers.
//
// Public handler keys (called from preload bindings, see preload.js):
//   - detect()                   → { found, dataDir, version }
//   - dryRun(options)            → { counts, plan, options } or { __error }
//   - runImport(options)         → summary or { __error }
//   - getState()                 → state object from sidecar, or null
//   - clearState()               → { ok }
//
// Side-effects live in the importer module (G-2b). This handler module
// just orchestrates: pulls the right deps from `browser`, calls the
// importer, surfaces errors in the OZ standard envelope.

const os = require('os')
const log = require('./logger')

const reader = require('./migrations/ghost-browser-reader')
const crypto = require('./migrations/ghost-browser-crypto')
const importer = require('./migrations/ghost-browser-importer')

function _err(code, message) {
  return { __error: { code, message } }
}

function _buildImporterDeps(browser) {
  const { app } = require('electron')
  return {
    identityManager: browser.identityManager,
    workspaceManager: browser.workspaceManager,
    bookmarkManager: browser.bookmarkManager,
    accountVault: browser.accountVault,
    backupManager: browser.backupManager,
    // getSession is provided by IdentityManager. Returns the per-identity
    // session via fromPartition('persist:identity-<id>').
    getSession: (identityId) => {
      try {
        return browser.identityManager.getSession(identityId)
      } catch (_err) {
        return null
      }
    },
    userDataDir: app.getPath('userData'),
  }
}

function buildGhostMigrationHandlers(browser) {
  return {
    /**
     * Detects whether Ghost Browser is installed in the standard macOS
     * location. Safe to call always — no vault unlock required.
     *
     * @returns {{ found: boolean, dataDir: string|null, version: string|null }}
     */
    detect() {
      try {
        return reader.detectInstall({ homeDir: os.homedir() })
      } catch (err) {
        log.error('ghost-migration', 'detect failed', { message: err.message })
        return { found: false, dataDir: null, version: null }
      }
    },

    /**
     * Dry-run — preview counts without writing OZ state. Safe to call
     * before vault unlock (does not touch vault). Used by the wizard's
     * Preview step.
     *
     * @param {object} [options]
     * @returns {Promise<{ counts, plan, options } | { __error }>}
     */
    async dryRun(options = {}) {
      const det = reader.detectInstall({ homeDir: os.homedir() })
      if (!det.found) {
        return _err('NOT_FOUND', 'Ghost Browser install not found')
      }
      try {
        return await importer.dryRun({
          reader,
          crypto,
          ghostDataDir: det.dataDir,
          options,
        })
      } catch (err) {
        log.error('ghost-migration', 'dryRun failed', { message: err.message })
        return _err('DRY_RUN_FAILED', err.message)
      }
    },

    /**
     * Full import. Triggers macOS Keychain dialog the first time it's
     * called (the wizard pre-popup explainer should warn the user).
     * Vault must be unlocked.
     *
     * @param {object} [options]
     * @returns {Promise<summary | { __error }>}
     */
    async runImport(options = {}) {
      const vault = browser.accountVault
      if (!vault || !vault.isUnlocked) {
        return _err('LOCKED', 'Vault must be unlocked before importing')
      }
      const det = reader.detectInstall({ homeDir: os.homedir() })
      if (!det.found) {
        return _err('NOT_FOUND', 'Ghost Browser install not found')
      }
      try {
        log.info('ghost-migration', 'runImport start', {
          ghostDataDir: det.dataDir,
          options,
        })
        const summary = await importer.runImport({
          reader,
          crypto,
          ghostDataDir: det.dataDir,
          deps: _buildImporterDeps(browser),
          options,
        })
        if (summary.error) {
          log.error('ghost-migration', 'runImport returned error', summary.error)
        } else {
          log.info('ghost-migration', 'runImport done', summary.counts)
        }
        if (browser.broadcastToWebUI) {
          browser.broadcastToWebUI('oz:migration:done', {
            ok: summary.ok,
            counts: summary.counts,
            error: summary.error,
          })
        }
        return summary
      } catch (err) {
        log.error('ghost-migration', 'runImport throw', { message: err.message })
        return _err('IMPORT_FAILED', err.message)
      }
    },

    /**
     * Returns the persisted import state from the sidecar file
     * (userData/data/ghost-migration-state.json), or null if never run.
     * Wizard uses this to detect "already imported" and offer skip.
     */
    getState() {
      const { app } = require('electron')
      const userDataDir = app.getPath('userData')
      return importer.readState(userDataDir)
    },

    /**
     * Clears the import state sidecar. Used by Settings → "Forget import
     * history" button. Does NOT roll back the actual import — only erases
     * the marker that says "I already imported once".
     */
    clearState() {
      const { app } = require('electron')
      const userDataDir = app.getPath('userData')
      importer.clearState(userDataDir)
      return { ok: true }
    },
  }
}

module.exports = { buildGhostMigrationHandlers }
