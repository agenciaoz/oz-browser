// OZ Browser — Sync Bootstrap setup glue (D-3c-3c).
//
// Extracted from main.js per ADR 0005 (500-LOC rule). Wraps the creation +
// init + stop lifecycle of the sync bootstrap with try/catch + log adapters
// so main.js stays focused on orchestration order.
//
// Doc: docs/modules/sync-bootstrap.md (lifecycle section)

'use strict'

const log = require('./logger')
const { createSyncBootstrap } = require('./sync-bootstrap')

/**
 * Instantiate the sync bootstrap and attach it to `browser.syncBootstrap`.
 * Called BEFORE registerIpcHandlers so the handler map can wire to it.
 *
 * Throws on misconfiguration (missing required managers) — same contract as
 * createSyncBootstrap.
 */
function setupSyncBootstrap(browser) {
  browser.syncBootstrap = createSyncBootstrap(browser)
}

/**
 * Run init() — resumes sync if user had it enabled previously AND Dropbox is
 * still authenticated. Non-blocking: surfaces failures via log + broadcast.
 * Called AFTER registerIpcHandlers (when broadcasts are wired).
 */
async function startSyncBootstrap(browser) {
  if (!browser.syncBootstrap) return
  try {
    await browser.syncBootstrap.init()
  } catch (err) {
    log.warn('sync-bootstrap-setup', 'init threw', { message: err.message })
  }
}

/**
 * Best-effort stop on before-quit. Halts engine drain + pull poll interval
 * so quit doesn't race with vault.lock(). Queue + cursor stay persisted.
 */
function stopSyncBootstrap(browser) {
  if (!browser.syncBootstrap) return
  try {
    browser.syncBootstrap.stop()
  } catch (err) {
    log.warn('sync-bootstrap-setup', 'stop failed', { message: err.message })
  }
}

module.exports = {
  setupSyncBootstrap,
  startSyncBootstrap,
  stopSyncBootstrap,
}
