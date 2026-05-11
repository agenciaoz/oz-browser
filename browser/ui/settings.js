// OZ Browser — Settings modal (1.10a).
//
// Doc: docs/modules/ui-settings.md
//
// Modal full-screen con sidebar de secciones (General/Privacy/Automation/
// Backup/Performance/About). Cada control de input está bound a un setting
// específico via data-bind (sección.key). El cambio dispara save inmediato
// (debounced 250ms para evitar thrash al typear en number/text inputs).
//
// IIFE wrap — same global-lexical-scope reasoning del resto de UI scripts.

;(function () {
  const { safe } = window.OZ.utils

  class SettingsUI {
    constructor() {
      this.$modal = document.getElementById('oz-settings-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/settings', 'modal markup missing')
        }
        return
      }
      this.$openBtn = document.getElementById('oz-settings-button')
      this.$err = document.getElementById('oz-settings-error')
      this.$nav = document.getElementById('oz-settings-nav')
      this.$content = document.getElementById('oz-settings-content')

      // Bind table — DOM id → {section, key, type}
      this.bindings = [
        { id: 'oz-stg-devMode', section: 'general', key: 'devMode', type: 'bool' },
        { id: 'oz-stg-freeTier', section: 'general', key: 'freeTier', type: 'bool' },
        { id: 'oz-stg-logLevel', section: 'general', key: 'logLevel', type: 'string' },
        {
          id: 'oz-stg-autoClearOnQuit',
          section: 'privacy',
          key: 'autoClearOnQuit',
          type: 'bool',
        },
        {
          id: 'oz-stg-mcpEnabled',
          section: 'automation',
          key: 'mcpEnabled',
          type: 'bool',
        },
        { id: 'oz-stg-mcpPort', section: 'automation', key: 'mcpPort', type: 'int' },
        {
          id: 'oz-stg-mcpToken',
          section: 'automation',
          key: 'mcpToken',
          type: 'stringOrNull',
        },
        {
          id: 'oz-stg-dailySnapshot',
          section: 'backup',
          key: 'dailySnapshot',
          type: 'bool',
        },
        {
          id: 'oz-stg-retentionDays',
          section: 'backup',
          key: 'retentionDays',
          type: 'int',
        },
        {
          id: 'oz-stg-autoTabDiscard',
          section: 'performance',
          key: 'autoTabDiscard',
          type: 'bool',
        },
        {
          id: 'oz-stg-discardIdleMin',
          section: 'performance',
          key: 'discardIdleMin',
          type: 'int',
        },
        // E2-C-5: notification settings
        {
          id: 'oz-stg-showOSAlert',
          section: 'notifications',
          key: 'showOSAlert',
          type: 'bool',
        },
      ]

      this._saveTimer = null
      this.settings = null
      this._wire()
    }

    _wire() {
      if (this.$openBtn) this.$openBtn.addEventListener('click', () => this.open())
      this.$modal.addEventListener('click', (ev) => {
        if (ev.target.dataset.close !== undefined) this.close()
      })
      // Section nav
      this.$nav.querySelectorAll('button[data-section]').forEach((btn) => {
        btn.addEventListener('click', () => this.showSection(btn.dataset.section))
      })
      // Reset all
      const resetBtn = document.getElementById('oz-stg-reset-all')
      if (resetBtn) {
        resetBtn.addEventListener('click', () => this.handleResetAll())
      }
      // Bind every input
      for (const b of this.bindings) {
        const el = document.getElementById(b.id)
        if (!el) continue
        const event =
          el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input'
        el.addEventListener(event, () => this.handleChange(b, el))
      }
    }

    async open() {
      this.$modal.hidden = false
      await safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      this.clearError()
      await this.refresh()
      this.showSection('general')
    }

    close() {
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
    }

    showSection(name) {
      this.$nav.querySelectorAll('button[data-section]').forEach((b) => {
        b.classList.toggle('active', b.dataset.section === name)
      })
      this.$content.querySelectorAll('section[data-section]').forEach((s) => {
        s.hidden = s.dataset.section !== name
      })
    }

    showError(msg) {
      this.$err.textContent = msg
      this.$err.hidden = false
    }
    clearError() {
      this.$err.hidden = true
      this.$err.textContent = ''
    }

    async refresh() {
      this.settings = await safe(window.oz.settings.getAll(), 'settings.getAll')
      if (!this.settings) {
        this.showError('Could not load settings.')
        return
      }
      // Populate inputs
      for (const b of this.bindings) {
        const el = document.getElementById(b.id)
        if (!el) continue
        const v = this.settings[b.section] ? this.settings[b.section][b.key] : null
        if (b.type === 'bool') el.checked = !!v
        else if (b.type === 'int' || b.type === 'string')
          el.value = v == null ? '' : String(v)
        else if (b.type === 'stringOrNull') el.value = v == null ? '' : String(v)
      }
      // About
      const ver = document.getElementById('oz-stg-version')
      if (ver) ver.textContent = this.settings.version + ' (schema)'
    }

    handleChange(binding, el) {
      this.clearError()
      let value
      if (binding.type === 'bool') value = !!el.checked
      else if (binding.type === 'int') {
        value = parseInt(el.value, 10)
        if (Number.isNaN(value)) return
      } else if (binding.type === 'string') value = el.value
      else if (binding.type === 'stringOrNull')
        value = el.value.trim() === '' ? null : el.value
      // Debounce so typing in port/text doesn't fire 1 IPC per keystroke
      clearTimeout(this._saveTimer)
      this._saveTimer = setTimeout(() => this.saveOne(binding, value), 250)
    }

    async saveOne(binding, value) {
      const r = await safe(
        window.oz.settings.set(binding.section, { [binding.key]: value }),
        'settings.set',
      )
      if (r && r.__error) {
        this.showError(
          `${binding.section}.${binding.key}: ${r.__error.reason || r.__error.code}`,
        )
      }
    }

    async handleResetAll() {
      if (
        !confirm(
          'Reset ALL settings to defaults?\n\nIdentities, workspaces, accounts, bookmarks, proxies, and fingerprints are NOT affected — only the user preferences here.',
        )
      )
        return
      await safe(window.oz.settings.resetAll(), 'settings.resetAll')
      await this.refresh()
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.SettingsUI = SettingsUI
})()
