// OZ Browser — Settings domain handlers (1.10a).
//
// Doc: docs/modules/settings-handlers.md
// ADR: docs/architecture/0019-settings-model.md
//
// Exports: buildSettingsHandlers(browser) -> Record<string, fn>
//
// v1.6.1: after a successful set/reset that touches the `automation` section,
// fire reconcileMcpRuntime() so the MCP server starts/stops/reconfigures
// without an app restart. Reconcile is fire-and-forget (no await) so the
// settings RPC stays snappy from the UI's perspective; failures are logged
// and surfaced via the next status() snapshot, not via the settings RPC.

const log = require('./logger')
const { reconcileMcpRuntime } = require('./mcp-server-setup')

function maybeReconcileMcp(browser, section) {
  if (section !== 'automation' && section !== '*') return
  reconcileMcpRuntime(browser)
    .then((status) => {
      browser.broadcastToWebUI('oz:mcp:status', status)
    })
    .catch((err) => {
      log.warn('settings-handlers', 'mcp reconcile failed', { error: err.message })
    })
}

function buildSettingsHandlers(browser) {
  const sm = () => browser.settingsManager

  return {
    getAll() {
      if (!sm()) return null
      return sm().getAll()
    },

    get(section) {
      if (!sm()) return null
      return sm().get(section)
    },

    set(section, patch) {
      if (!sm()) return { __error: { code: 'NO_SETTINGS_MANAGER' } }
      const r = sm().set(section, patch || {})
      if (r && !r.__error) {
        browser.broadcastToWebUI('oz:settings:changed', { section })
        log.info('settings-handlers', 'set', {
          section,
          changedKeys: Object.keys(patch || {}),
        })
        maybeReconcileMcp(browser, section)
      }
      return r
    },

    resetSection(section) {
      if (!sm()) return { __error: { code: 'NO_SETTINGS_MANAGER' } }
      const r = sm().resetSection(section)
      if (r && !r.__error) {
        browser.broadcastToWebUI('oz:settings:changed', { section })
        maybeReconcileMcp(browser, section)
      }
      return r
    },

    resetAll() {
      if (!sm()) return null
      const r = sm().resetAll()
      browser.broadcastToWebUI('oz:settings:changed', { section: '*' })
      maybeReconcileMcp(browser, '*')
      return r
    },
  }
}

module.exports = { buildSettingsHandlers }
