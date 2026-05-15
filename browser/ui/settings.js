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
        // D-3c-3c: cross-device sync. The 'enabled' toggle does NOT go
        // through the generic save path because enabling triggers cold-start
        // + engine start (server-side state, not just a settings write).
        // We handle it specially in handleChange via window.oz.sync.setEnabled.
        {
          id: 'oz-stg-syncEnabled',
          section: 'sync',
          key: 'enabled',
          type: 'bool',
          syncSpecial: true,
        },
      ]

      this._saveTimer = null
      this.settings = null
      this._syncStatus = null
      this._syncUnsubscribe = null
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
      // D-3c-3c: Sync Now button
      const syncNowBtn = document.getElementById('oz-stg-syncNowBtn')
      if (syncNowBtn) {
        syncNowBtn.addEventListener('click', () => this.handleSyncNow())
      }
      // Bind every input
      for (const b of this.bindings) {
        const el = document.getElementById(b.id)
        if (!el) continue
        const event =
          el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input'
        el.addEventListener(event, () => this.handleChange(b, el))
      }
      // D-3c-3c: subscribe to sync status changes — engine pushes update the
      // pill without re-opening the modal. Subscription stays for the lifetime
      // of the renderer; no need to unwire on close because the modal hides
      // (doesn't unmount).
      if (window.oz && window.oz.sync && typeof window.oz.sync.onChanged === 'function') {
        this._syncUnsubscribe = window.oz.sync.onChanged(() => {
          if (!this.$modal.hidden) this.refreshSyncStatus()
        })
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
      // F-4b: when the Scheduled section becomes visible, refresh its
      // list+status. The UI is auto-instantiated by scheduled-actions-ui.js
      // (loaded before settings.js) on its own IIFE. We only kick refresh
      // here so the data is current when the user navigates to the tab.
      if (
        name === 'scheduled' &&
        window.OZ &&
        window.OZ.scheduledActionsUI &&
        typeof window.OZ.scheduledActionsUI.refresh === 'function'
      ) {
        window.OZ.scheduledActionsUI.refresh()
      }
      // G-3: same pattern for the Migration section — refresh detect +
      // dryRun counts each time the user navigates here.
      if (
        name === 'migration' &&
        window.OZ &&
        window.OZ.ghostMigrationUI &&
        typeof window.OZ.ghostMigrationUI.refresh === 'function'
      ) {
        window.OZ.ghostMigrationUI.refresh()
      }
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
      if (ver) ver.textContent = String(this.settings.version)
      const appVerEl = document.getElementById('oz-stg-app-version')
      if (appVerEl) {
        try {
          const v = await (window.oz && window.oz.app
            ? window.oz.app.getVersion()
            : Promise.resolve('?'))
          appVerEl.textContent = v || '?'
        } catch (_err) {
          appVerEl.textContent = '?'
        }
      }
      // D-3c-3c: Sync status (computed live, NOT persisted in settings).
      await this.refreshSyncStatus()
    }

    async refreshSyncStatus() {
      if (!window.oz || !window.oz.sync) return
      const status = await safe(window.oz.sync.getStatus(), 'sync.getStatus')
      if (!status || status.__error) return
      this._syncStatus = status
      const pill = document.getElementById('oz-stg-syncStatusPill')
      const desc = document.getElementById('oz-stg-syncStatusDesc')
      const ts = document.getElementById('oz-stg-syncTimestamps')
      const toggle = document.getElementById('oz-stg-syncEnabled')
      const syncNowBtn = document.getElementById('oz-stg-syncNowBtn')
      if (!pill || !desc) return

      // Compute pill class + label from a small priority chain.
      let pillClass = 'oz-sync-pill-stopped'
      let pillLabel = 'Stopped'
      let descText = 'Sync is off. Toggle "Enable" to start syncing this device.'

      if (!status.configured) {
        pillClass = 'oz-sync-pill-warning'
        pillLabel = 'Not configured'
        descText = 'Dropbox app key missing in this build. Sync is disabled.'
      } else if (!status.dropboxConnected) {
        pillClass = 'oz-sync-pill-warning'
        pillLabel = 'Dropbox not connected'
        descText =
          'Connect Dropbox first in Cloud Backup settings, then come back to enable sync.'
      } else if (status.needsReauth) {
        pillClass = 'oz-sync-pill-error'
        pillLabel = 'Needs re-auth'
        descText =
          'Your Dropbox session expired. Reconnect from Cloud Backup, then re-enable sync.'
      } else if (!status.vaultUnlocked && status.enabled) {
        pillClass = 'oz-sync-pill-warning'
        pillLabel = 'Vault locked'
        descText =
          'Sync is enabled but the Vault is locked. Unlock it from Accounts to resume.'
      } else if (status.running) {
        pillClass = 'oz-sync-pill-running'
        pillLabel = 'Running'
        descText =
          status.queueDepth > 0
            ? `Running. ${status.queueDepth} change${status.queueDepth === 1 ? '' : 's'} pending push.`
            : 'Running. All local changes pushed.'
      } else if (status.enabled) {
        // Enabled but not running — usually transient (about to start).
        pillClass = 'oz-sync-pill-warning'
        pillLabel = 'Starting…'
        descText = 'Sync is enabled but the engine has not started yet.'
      }

      pill.className = 'oz-sync-pill ' + pillClass
      pill.textContent = pillLabel
      desc.textContent = descText
      if (toggle) toggle.checked = !!status.enabled
      // Disable Sync Now if there's nothing to pull (not running or not connected).
      if (syncNowBtn) {
        syncNowBtn.disabled = !status.running
      }
      // Timestamps row
      if (ts) {
        const parts = []
        if (status.lastPullAt) parts.push(`Last pull: ${formatTs(status.lastPullAt)}`)
        if (status.lastPushAt) parts.push(`Last push: ${formatTs(status.lastPushAt)}`)
        if (status.lastError) parts.push(`Last error: ${status.lastError.code}`)
        ts.textContent = parts.length ? parts.join(' · ') : 'Never synced yet.'
      }
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
      // D-3c-3c: sync.enabled goes through a dedicated handler (server-side
      // state, not just a settings write). Skip debounce so the user sees
      // immediate feedback (cold-start kicks in synchronously on enable).
      if (binding.syncSpecial) {
        this.handleSyncEnabledChange(value, el)
        return
      }
      // Debounce so typing in port/text doesn't fire 1 IPC per keystroke
      clearTimeout(this._saveTimer)
      this._saveTimer = setTimeout(() => this.saveOne(binding, value), 250)
    }

    async handleSyncEnabledChange(enabled, el) {
      if (!window.oz || !window.oz.sync) {
        this.showError('Sync API not available')
        if (el) el.checked = !enabled
        return
      }
      const r = await safe(window.oz.sync.setEnabled(enabled), 'sync.setEnabled')
      if (!r || r.__error || !r.ok) {
        const reason = (r && r.reason) || (r && r.__error && r.__error.code) || 'unknown'
        const map = {
          NEEDS_DROPBOX_APP: 'This build was not configured with a Dropbox app key.',
          NEEDS_REAUTH:
            'Dropbox is not connected. Connect it from Cloud Backup settings first.',
          BUILD_FAILED: 'Could not build the sync engine.',
          NOT_CONFIGURED: 'Sync is not available — Dropbox is not configured.',
        }
        this.showError(map[reason] || `Could not change sync state: ${reason}`)
        // Revert the checkbox to match server truth.
        if (el) el.checked = !enabled
        await this.refreshSyncStatus()
        return
      }
      // Success — refresh the pill + the desc.
      await this.refreshSyncStatus()
    }

    async handleSyncNow() {
      if (!window.oz || !window.oz.sync) return
      const btn = document.getElementById('oz-stg-syncNowBtn')
      if (btn) btn.disabled = true
      try {
        const r = await safe(window.oz.sync.pullNow(), 'sync.pullNow')
        if (r && !r.ok) {
          const reason = r.reason || 'unknown'
          this.showError(`Sync now failed: ${reason}`)
        }
      } finally {
        await this.refreshSyncStatus()
      }
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

  // D-3c-3c: format an ISO timestamp into a short relative-ish string.
  // Kept simple — UI tolerates raw fallback if Date parse fails.
  function formatTs(iso) {
    try {
      const t = new Date(iso).getTime()
      if (Number.isNaN(t)) return iso
      const delta = Date.now() - t
      if (delta < 0) return 'just now'
      const sec = Math.floor(delta / 1000)
      if (sec < 60) return `${sec}s ago`
      const min = Math.floor(sec / 60)
      if (min < 60) return `${min}m ago`
      const hr = Math.floor(min / 60)
      if (hr < 24) return `${hr}h ago`
      const days = Math.floor(hr / 24)
      return `${days}d ago`
    } catch (_e) {
      return String(iso)
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.SettingsUI = SettingsUI
})()
