// OZ Browser — BulkNotifications setup wrapper (v2 Etapa 4.2).
//
// Thin glue extracted from main.js to keep that file under the 500 LOC
// budget (ADR 0005). Same pattern as bulk-runner-setup.js / scheduled-
// actions-setup.js.
//
// Wires `BulkNotifications` onto the browser instance after
// `bulkRunnerSetup.setupBulkRunner(this)` has set `browser.bulkRunner`.

'use strict'

const { BulkNotifications } = require('./bulk-notifications')
const log = require('./logger')

function setupBulkNotifications(browser) {
  if (!browser.bulkRunner) {
    log.warn('bulk-notifications-setup', 'bulkRunner missing — skipping')
    return
  }
  browser.bulkNotifications = new BulkNotifications({
    bulkRunner: browser.bulkRunner,
    browser,
    settingsManager: browser.settingsManager,
    logger: log,
  })
  browser.bulkNotifications.install()
}

module.exports = { setupBulkNotifications }
