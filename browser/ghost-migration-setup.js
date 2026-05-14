// OZ Browser — Ghost migration setup glue (G-3).
//
// Mismo patrón que scheduled-setup / sync-bootstrap-setup: una función
// setup() que main.js llama ANTES de registerExtraIpcHandlers. Attaches
// browser.handlers.ghostMigration. IPC channels son registrados desde
// ipc-handlers-extra.js (sigue ADR 0005 modular 500 LOC rule).
//
// No lifecycle start/stop needed — el importer es one-shot por click del
// usuario, no hay timer ni background loop.
//
// Doc: docs/modules/ghost-migration.md (post-G-4).

'use strict'

const log = require('./logger')
const { buildGhostMigrationHandlers } = require('./ghost-migration-handlers')

function setupGhostMigration(browser) {
  browser.handlers = browser.handlers || {}
  browser.handlers.ghostMigration = buildGhostMigrationHandlers(browser)
  log.info('ghost-migration-setup', 'handlers attached')
}

module.exports = { setupGhostMigration }
