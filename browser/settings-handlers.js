// OZ Browser — Settings domain handlers (1.10a).
//
// Doc: docs/modules/settings-handlers.md
// ADR: docs/architecture/0019-settings-model.md
//
// Exports: buildSettingsHandlers(browser) -> Record<string, fn>

const log = require('./logger')

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
      }
      return r
    },

    resetSection(section) {
      if (!sm()) return { __error: { code: 'NO_SETTINGS_MANAGER' } }
      const r = sm().resetSection(section)
      if (r && !r.__error) {
        browser.broadcastToWebUI('oz:settings:changed', { section })
      }
      return r
    },

    resetAll() {
      if (!sm()) return null
      const r = sm().resetAll()
      browser.broadcastToWebUI('oz:settings:changed', { section: '*' })
      return r
    },
  }
}

module.exports = { buildSettingsHandlers }
