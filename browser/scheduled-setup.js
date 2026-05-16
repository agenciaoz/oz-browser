// OZ Browser — Scheduled Actions setup glue (Bloque F-4a, v1).
//
// Mismo patrón que sync-bootstrap-setup (D-3c-3c): tres funciones
// (setup / start / stop) que main.js llama en los puntos lifecycle
// correctos. Mantiene main.js delgado y este archivo testeable con
// fakes (no requiere Electron real).
//
// Lifecycle
//   1. setupScheduledActions(browser, opts)
//      - Llamado ANTES de registerExtraIpcHandlers.
//      - Instancia ScheduledActions con filePath en userData.
//      - Registra los 3 handlers reales contra browser.workspaceManager
//        / syncBootstrap / backupManager (deps tomadas via injected
//        wrappers, tolerant a missing — el helper de F-2 skip las que
//        faltan).
//      - Attaches browser.scheduledActions + browser.handlers.scheduled.
//      - Wires observability — action-fired / action-failed / warn al
//        logger.
//   2. startScheduledActions(browser)
//      - Llamado DESPUÉS de registerExtraIpcHandlers (cuando broadcasts
//        están listos por si el primer tick quiere notificar).
//      - Arranca el runner loop con la cadencia default (60s).
//   3. stopScheduledActions(browser)
//      - Llamado en before-quit ANTES de vault.lock(), igual que
//        stopSyncBootstrap. Drena in-flight handlers.
//
// Tests: tests/scheduled-setup.smoketest.js usa fakes para los 3
// pasos. La validación visual end-to-end (UI + lifecycle real) queda
// para F-4b (Settings UI) + smoke manual de Jose.
//
// Doc: docs/modules/scheduled-setup.md (será creado con F-4b).

'use strict'

const path = require('path')

const log = require('./logger')
const { ScheduledActions } = require('./scheduled-actions')
const { registerScheduledActionHandlers } = require('./scheduled-action-handlers')
const { buildScheduledHandlers } = require('./scheduled-handlers')

const DEFAULT_FILE_NAME = 'scheduled-actions.json'

/**
 * Build the deps bag for registerScheduledActionHandlers based on what
 * the live `browser` exposes. Each dep is wrapped in a thin closure so
 * the underlying object is read at FIRE time (not setup time) — that
 * lets us setup before sync/backup are themselves initialized.
 *
 * Exported for unit tests so a fake browser can verify the wrappers
 * route to the correct underlying surfaces.
 */
function _buildDeps(browser, electron) {
  const { BrowserWindow } = electron || {}

  const deps = {
    vault: browser.accountVault || null,
  }

  // open-workspace — switch the focused window (or the first window
  // if none focused) to the target workspaceId.
  if (browser.workspaceManager && BrowserWindow) {
    deps.openWorkspace = async (workspaceId) => {
      const wm = browser.workspaceManager
      if (!wm.get(workspaceId)) {
        return { skipped: true, reason: 'unknown-workspace' }
      }
      const win =
        (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow()) ||
        (BrowserWindow.getAllWindows && BrowserWindow.getAllWindows()[0])
      if (!win) {
        return { skipped: true, reason: 'no-window' }
      }
      // Lazy-load to avoid circular import warnings during setup.
      const { switchWorkspace } = require('./window-workspace')
      await switchWorkspace({
        window: win,
        browser,
        targetWorkspaceId: workspaceId,
      })
      return { switched: true, workspaceId }
    }
  }

  // sync-push — v1 maps to syncBootstrap.pullNow() which is the
  // "Sync Now" surface from D-3c-3c. The push side drains
  // automatically when the queue has items; pullNow forces a fresh
  // round-trip. A dedicated pushNow API can come later in v2 if we
  // ever want to decouple them.
  if (browser.syncBootstrap) {
    deps.syncPush = async () => {
      const sb = browser.syncBootstrap
      // pullNow itself is NOT_CONFIGURED-safe per sync-handlers contract.
      const result = await sb.pullNow()
      return result || { ok: true }
    }
  }

  if (
    browser.backupManager &&
    typeof browser.backupManager.createSnapshot === 'function'
  ) {
    deps.backupManager = browser.backupManager
  }

  // K1-extras (v1.4.1): session warmer needs identityManager + (optional)
  // workspaceManager + accountVault. The handler factory itself defaults
  // sessionFactory/netRequest to electron.session.fromPartition + net.request
  // so we only pass managers — keeps this wiring small.
  if (browser.identityManager && typeof browser.identityManager.list === 'function') {
    deps.identityManager = browser.identityManager
    if (browser.workspaceManager) deps.workspaceManager = browser.workspaceManager
    if (browser.accountVault) deps.accountVault = browser.accountVault
  }

  return deps
}

/**
 * Instantiate the scheduler and attach to `browser.scheduledActions` +
 * `browser.handlers.scheduled`. Idempotent — second call returns early.
 *
 * @param {object} browser - the main process root object
 * @param {object} [opts]
 * @param {string} [opts.userDataDir] - override for tests
 * @param {object} [opts.electron] - override Electron import for tests
 */
function setupScheduledActions(browser, opts = {}) {
  if (browser.scheduledActions) return browser.scheduledActions

  const electron = opts.electron || _safeRequireElectron()
  const userDataDir =
    opts.userDataDir ||
    (electron && electron.app ? electron.app.getPath('userData') : null)

  if (!userDataDir) {
    log.warn('scheduled-setup', 'no userDataDir available; scheduled actions disabled')
    return null
  }

  const filePath = path.join(userDataDir, DEFAULT_FILE_NAME)
  const sa = new ScheduledActions({ filePath })
  sa.load()

  const deps = _buildDeps(browser, electron)
  const registered = registerScheduledActionHandlers(sa, deps)
  log.info('scheduled-setup', 'instantiated', {
    filePath,
    registeredHandlers: registered,
    actionCount: sa.size(),
  })

  // Observability — surface fire/fail/skip so they show up in
  // ~/Library/Logs/OZ Browser/oz-browser.log without flooding.
  sa.on('action-fired', (evt) => {
    log.info('scheduled', 'action-fired', {
      id: evt.id,
      durationMs: evt.result && evt.result.durationMs,
    })
  })
  sa.on('action-failed', (evt) => {
    log.warn('scheduled', 'action-failed', {
      id: evt.id,
      error: evt.result && evt.result.error,
      code: evt.result && evt.result.code,
    })
  })
  sa.on('warn', (w) => {
    log.warn('scheduled', w.reason || 'warn', { detail: w })
  })

  browser.scheduledActions = sa
  browser.handlers = browser.handlers || {}
  browser.handlers.scheduled = buildScheduledHandlers(browser)
  return sa
}

/**
 * Start the runner loop. Idempotent.
 */
function startScheduledActions(browser, opts = {}) {
  if (!browser.scheduledActions) return
  if (browser.scheduledActions.isRunning()) return
  try {
    browser.scheduledActions.start(opts.startOpts || {})
  } catch (err) {
    log.warn('scheduled-setup', 'start failed', { message: err.message })
  }
}

/**
 * Stop the runner loop. Drains in-flight handlers — await this in
 * before-quit BEFORE vault.lock() so handlers that need the master
 * key don't observe a locked vault mid-fire. Idempotent.
 */
async function stopScheduledActions(browser) {
  if (!browser.scheduledActions) return
  try {
    await browser.scheduledActions.stop()
  } catch (err) {
    log.warn('scheduled-setup', 'stop failed', { message: err.message })
  }
}

function _safeRequireElectron() {
  try {
    return require('electron')
  } catch {
    return null
  }
}

module.exports = {
  setupScheduledActions,
  startScheduledActions,
  stopScheduledActions,
  _buildDeps,
  DEFAULT_FILE_NAME,
}
