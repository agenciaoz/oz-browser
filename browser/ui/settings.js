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
        // v1.1.0: i18n locale dropdown. Auto resolves to system locale at boot.
        // Change here triggers i18n.setLocale() which persists + re-renders.
        {
          id: 'oz-stg-locale',
          section: 'general',
          key: 'locale',
          type: 'string',
          localeSpecial: true,
        },
        {
          id: 'oz-stg-autoClearOnQuit',
          section: 'privacy',
          key: 'autoClearOnQuit',
          type: 'bool',
        },
        {
          id: 'oz-stg-autoAssignProxyOnCreate',
          section: 'privacy',
          key: 'autoAssignProxyOnCreate',
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
      // v1.6.1: MCP runtime status pill + Cowork snippet copy button.
      this._mcpStatus = null
      this._mcpUnsubscribe = null
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
      // I-2 (v1.6.0): auto-updater controls in About panel
      this._setupAutoUpdaterPane()
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
      // v1.6.1: MCP status pill + Cowork copy button. Same subscription
      // pattern as sync — main pushes oz:mcp:status after reconcileMcpRuntime.
      const copyBtn = document.getElementById('oz-stg-mcpCopyCowork')
      if (copyBtn) {
        copyBtn.addEventListener('click', () => this.handleCopyCoworkSnippet(copyBtn))
      }
      if (window.oz && window.oz.mcp && typeof window.oz.mcp.onStatus === 'function') {
        this._mcpUnsubscribe = window.oz.mcp.onStatus((status) => {
          this._mcpStatus = status
          if (!this.$modal.hidden) this.renderMcpStatusPill()
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
      // v1.6.1: MCP runtime status (also computed live).
      await this.refreshMcpStatus()
    }

    // v1.6.1: MCP pane logic lives in settings-mcp-pane.js (ADR 0005). These
    // wrappers stay so existing call sites in this class keep working.
    async refreshMcpStatus() {
      const pane = window.OZ && window.OZ.settingsMcpPane
      if (!pane) return
      this._mcpStatus = await pane.refresh()
    }
    renderMcpStatusPill() {
      const pane = window.OZ && window.OZ.settingsMcpPane
      if (pane && this._mcpStatus) pane.render(this._mcpStatus)
    }
    async handleCopyCoworkSnippet(btn) {
      const pane = window.OZ && window.OZ.settingsMcpPane
      if (pane) await pane.copy(btn, (msg) => this.showError(msg))
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
      // v1.1.0: locale change → i18n.setLocale persists + re-renders. Skip
      // the generic save path (i18n module already calls oz.settings.set).
      if (binding.localeSpecial) {
        if (window.OZ && window.OZ.i18n) {
          window.OZ.i18n.setLocale(value)
        }
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

    // I-2 (v1.6.0): Auto-updater pane inside About section.
    // Wires the toggle (settings.autoUpdate.enabled), the Check / Install
    // buttons, and the live status text driven by main-process events.
    _setupAutoUpdaterPane() {
      const $toggle = document.getElementById('oz-stg-auto-update-toggle')
      const $check = document.getElementById('oz-stg-check-update-btn')
      const $install = document.getElementById('oz-stg-install-update-btn')
      const $status = document.getElementById('oz-stg-update-status')
      if (!$toggle || !$check || !$install || !$status) return // markup missing

      const t = (key, params) =>
        window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

      // Initial status text — assumes "up to date" until a check tells us
      // otherwise. The label is locale-aware via t().
      const setIdle = () => {
        $status.textContent = t('settings.about.statusIdle')
        $install.hidden = true
      }
      setIdle()

      // Toggle wiring — persist to settings.autoUpdate.enabled. The
      // periodic poll respects this; manual Check button ignores it.
      const refreshToggle = async () => {
        try {
          const s =
            (await (window.oz?.settings?.get
              ? window.oz.settings.get('autoUpdate')
              : Promise.resolve(null))) || {}
          $toggle.checked = s.enabled !== false
        } catch (_e) {
          $toggle.checked = true // default true
        }
      }
      refreshToggle()
      $toggle.addEventListener('change', async () => {
        try {
          await window.oz.settings.set('autoUpdate', { enabled: $toggle.checked })
        } catch (_e) {
          // best-effort
        }
      })

      // Manual buttons.
      $check.addEventListener('click', async () => {
        if (window.oz?.autoUpdater?.checkNow) await window.oz.autoUpdater.checkNow()
      })
      $install.addEventListener('click', async () => {
        if (window.oz?.autoUpdater?.installNow) await window.oz.autoUpdater.installNow()
      })

      // Subscribe to main-process events.
      let _lastDownloadedVersion = null
      if (window.oz?.autoUpdater?.onEvent) {
        window.oz.autoUpdater.onEvent(({ event, payload }) => {
          switch (event) {
            case 'checking':
              $status.textContent = t('settings.about.statusChecking')
              $install.hidden = true
              break
            case 'available':
              $status.textContent = t('settings.about.statusAvailable', {
                version: (payload && payload.version) || '?',
              })
              $install.hidden = true
              break
            case 'not-available':
              $status.textContent = t('settings.about.statusNotAvailable')
              $install.hidden = true
              break
            case 'download-progress': {
              const pct = Math.max(
                0,
                Math.min(100, Math.round((payload && payload.percent) || 0)),
              )
              $status.textContent = t('settings.about.statusDownloading', {
                percent: pct,
              })
              $install.hidden = true
              break
            }
            case 'downloaded':
              _lastDownloadedVersion = (payload && payload.version) || '?'
              $status.textContent = t('settings.about.statusReady', {
                version: _lastDownloadedVersion,
              })
              $install.hidden = false
              break
            case 'error':
              $status.textContent = t('settings.about.statusError', {
                message: (payload && payload.message) || 'unknown',
              })
              break
          }
        })
      }

      // Re-render status text on locale switch (covers in-progress messages
      // like "Downloading…" that JS owns). Idle/downloaded sticky values
      // also re-render based on _lastDownloadedVersion state.
      if (window.OZ?.i18n?.onChange) {
        window.OZ.i18n.onChange(() => {
          if (!$install.hidden && _lastDownloadedVersion) {
            $status.textContent = t('settings.about.statusReady', {
              version: _lastDownloadedVersion,
            })
          } else if ($status.textContent === t('settings.about.statusIdle')) {
            // already idle, refresh anyway
            setIdle()
          }
          // mid-flight states (checking / downloading / error) get re-rendered
          // by the next event from main, so no special handling here.
        })
      }
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
