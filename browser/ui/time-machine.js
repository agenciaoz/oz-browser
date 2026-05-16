// OZ Browser — Time Machine modal (1.6c).
//
// Qué hace: overlay modal montado sobre la WebUI para listar/crear/restaurar
// snapshots .ozbackup. Mismo patrón que account-manager.js (1.5f).
//
// Doc: docs/modules/ui-time-machine.md
// Bloque: 1.6c
//
// Vistas:
//   1) locked  — vault bloqueado, botón Unlock (mismo flow que Account Manager)
//   2) list    — toolbar con "Take snapshot now" + "Run retention", lista
//                cronológica con label/reason/when/size + restore/delete por row
//
// Exports: window.OZ.TimeMachine (singleton). API pública: open(), close().
// IPC: window.oz.timemachine.* + window.oz.vault.*

;(function () {
  const { safe } = window.OZ.utils
  // v1.5.7: i18n — lazy lookup via window.OZ.i18n.t() so locale switches
  // pick up automatically. Falls back to the key if i18n hasn't loaded
  // yet (webui.html loads time-machine.js before i18n.js, but the catalog
  // fetch is async — by the time any user-triggered code path runs, i18n
  // is ready).
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  function fmtDate(iso) {
    try {
      const d = new Date(iso)
      // 2026-05-10 14:35
      return `${d.toLocaleDateString()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    } catch (_) {
      return iso || ''
    }
  }

  function fmtSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  const REASON_ICON = {
    manual: '📌',
    'pre-quit': '🚪',
    'pre-overwrite-total': '⚠️',
    'pre-restore': '↩',
    'daily-3am': '🌙',
  }

  // v1.5.7: map snapshot reason strings (kebab-case from backend) to
  // their i18n catalog leaf key. Unknown reasons fall through to
  // `timeMachine.reasons.unknown` which is the generic "snapshot" label.
  const REASON_I18N_KEY = {
    manual: 'manual',
    'pre-quit': 'preQuit',
    'pre-overwrite-total': 'preOverwriteTotal',
    'pre-restore': 'preRestore',
    'daily-3am': 'daily3am',
  }
  function reasonLabel(reason) {
    const sub = REASON_I18N_KEY[reason] || 'unknown'
    return t(`timeMachine.reasons.${sub}`)
  }

  class TimeMachine {
    constructor() {
      this.$modal = document.getElementById('oz-tm-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/time-machine', 'modal markup missing')
        }
        return
      }
      this.$openBtn = document.getElementById('oz-tm-button')
      this.$count = document.getElementById('oz-tm-count')
      this.$err = document.getElementById('oz-tm-error')
      this.$viewLocked = document.getElementById('oz-tm-locked-view')
      this.$viewList = document.getElementById('oz-tm-list-view')
      this.$btnUnlock = document.getElementById('oz-tm-unlock-btn')
      this.$btnSnapshotNow = document.getElementById('oz-tm-snapshot-now')
      this.$btnRetention = document.getElementById('oz-tm-retention-btn')
      this.$btnCloud = document.getElementById('oz-tm-cloud-btn')
      this.$list = document.getElementById('oz-tm-list')
      this.$empty = document.getElementById('oz-tm-empty')
      this.$summary = document.getElementById('oz-tm-summary')

      this.snapshots = []
      this._wire()
      this._refreshCountBadge()

      // Background listener to keep the badge fresh + auto-refresh modal if open.
      if (window.oz?.timemachine?.onChanged) {
        window.oz.timemachine.onChanged(() => {
          this._refreshCountBadge()
          if (!this.$modal.hidden) this._reloadAndRender()
        })
      }
      if (window.oz?.vault?.onChanged) {
        window.oz.vault.onChanged(() => {
          if (!this.$modal.hidden) this._refreshAndShow()
        })
      }
      // Restore-completed event → big alert because identities/workspaces
      // need an app restart to reload from disk.
      if (window.oz?.timemachine?.onRestoreCompleted) {
        window.oz.timemachine.onRestoreCompleted((payload) => {
          window.alert(
            t('timeMachine.restoreCompletedAlert', {
              preRestoreId: payload.preRestoreId,
            }),
          )
        })
      }

      // v1.5.7: re-render dynamic content on locale switch. translatePage()
      // covers static markup (title, locked-view, column headers, empty
      // message, shortcut hint), but row content (reason badge label, files
      // sub-text), the summary, and the button labels we toggle dynamically
      // (Unlocking… / Snapshotting…) live in JS-set textContent.
      if (window.OZ?.i18n?.onChange) {
        window.OZ.i18n.onChange(() => {
          if (this.$modal.hidden) return
          // Re-render the list (rebuilds rows + summary). Skip if we are
          // currently in the locked view — its markup is fully static.
          if (!this.$viewList.hidden) this._renderList()
        })
      }
    }

    _wire() {
      if (this.$openBtn) this.$openBtn.addEventListener('click', () => this.open())
      this.$modal.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', () => this.close())
      })
      document.addEventListener('keydown', (e) => {
        if (!this.$modal.hidden && e.key === 'Escape') this.close()
      })
      this.$btnUnlock.addEventListener('click', () => this._doUnlock())
      this.$btnSnapshotNow.addEventListener('click', () => this._doSnapshotNow())
      this.$btnRetention.addEventListener('click', () => this._doRetention())
      if (this.$btnCloud) {
        this.$btnCloud.addEventListener('click', () => {
          // Open the cloud-backup modal over (or instead of) the TM modal.
          // Keep TM modal open underneath — cloud-backup is a sub-flow.
          if (window.OZ?.CloudBackup?.open) {
            window.OZ.CloudBackup.open()
          }
        })
      }
    }

    async open() {
      this._clearError()
      this.$modal.hidden = false
      if (window.oz?.ui) window.oz.ui.setContentVisible(false).catch(() => {})
      await this._refreshAndShow()
    }

    close() {
      this.$modal.hidden = true
      if (window.oz?.ui) window.oz.ui.setContentVisible(true).catch(() => {})
    }

    async _refreshAndShow() {
      const status = await safe(window.oz.vault.status(), 'vault.status')
      if (!status || status.__error) {
        this._showError(t('timeMachine.errorVaultStatus'))
        return
      }
      if (!status.isUnlocked) {
        this._showView('locked')
        return
      }
      await this._reloadAndRender()
    }

    async _reloadAndRender() {
      const list = await safe(window.oz.timemachine.list(), 'timemachine.list')
      if (!list || list.__error) {
        this._showError(t('timeMachine.errorLoadSnapshots'))
        return
      }
      this.snapshots = Array.isArray(list) ? list : []
      this._showView('list')
      this._renderList()
      this._refreshCountBadge()
    }

    async _refreshCountBadge() {
      // Cheap read for the sidebar badge — only call if vault unlocked.
      try {
        const status = await window.oz.vault.status()
        if (!status?.isUnlocked) {
          if (this.$count) this.$count.textContent = ''
          return
        }
        const list = await window.oz.timemachine.list()
        const n = Array.isArray(list) ? list.length : 0
        if (this.$count) this.$count.textContent = n > 0 ? `(${n})` : ''
      } catch (_) {
        // ignore
      }
    }

    _showView(name) {
      this.$viewLocked.hidden = name !== 'locked'
      this.$viewList.hidden = name !== 'list'
      this._clearError()
    }
    _clearError() {
      this.$err.hidden = true
      this.$err.textContent = ''
    }
    _showError(msg) {
      this.$err.textContent = msg
      this.$err.hidden = false
    }

    async _doUnlock() {
      this.$btnUnlock.disabled = true
      this.$btnUnlock.textContent = t('timeMachine.locked.unlocking')
      const r = await safe(window.oz.vault.unlock(), 'vault.unlock')
      this.$btnUnlock.disabled = false
      this.$btnUnlock.textContent = t('timeMachine.locked.unlockBtn')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('timeMachine.errorUnlockFailed'))
        return
      }
      await this._reloadAndRender()
    }

    async _doSnapshotNow() {
      this._clearError()
      this.$btnSnapshotNow.disabled = true
      this.$btnSnapshotNow.textContent = t('timeMachine.snapshotting')
      const r = await safe(
        window.oz.timemachine.create({ reason: 'manual' }),
        'timemachine.create',
      )
      this.$btnSnapshotNow.disabled = false
      this.$btnSnapshotNow.textContent = t('timeMachine.snapshotNow')
      if (!r || r.__error) {
        this._showError(r?.__error?.message || t('timeMachine.errorSnapshotFailed'))
        return
      }
      await this._reloadAndRender()
    }

    async _doRetention() {
      this._clearError()
      const r = await safe(
        window.oz.timemachine.applyRetention(),
        'timemachine.applyRetention',
      )
      if (!r || r.__error) {
        this._showError(r?.__error?.message || t('timeMachine.errorRetentionFailed'))
        return
      }
      window.alert(t('timeMachine.retentionApplied', { n: r.deletedCount }))
      await this._reloadAndRender()
    }

    async _doRestore(snapshot) {
      const ok = window.confirm(
        t('timeMachine.confirmRestore', {
          label: snapshot.label,
          when: fmtDate(snapshot.createdAt),
        }),
      )
      if (!ok) return
      this._clearError()
      const r = await safe(
        window.oz.timemachine.restore(snapshot.id),
        'timemachine.restore',
      )
      if (!r || r.__error) {
        const msg = r?.__error?.message || t('timeMachine.errorRestoreFailed')
        const preId = r?.__error?.preRestoreId
        this._showError(
          preId ? t('timeMachine.errorRestoreWithPreId', { msg, preId }) : msg,
        )
        return
      }
      // Success message comes via onRestoreCompleted listener.
    }

    async _doDelete(snapshot) {
      const ok = window.confirm(
        t('timeMachine.confirmDelete', {
          label: snapshot.label,
          when: fmtDate(snapshot.createdAt),
        }),
      )
      if (!ok) return
      const r = await safe(
        window.oz.timemachine.remove(snapshot.id),
        'timemachine.remove',
      )
      if (!r || r.__error) {
        this._showError(r?.__error?.message || t('timeMachine.errorDeleteFailed'))
      }
    }

    _renderList() {
      this.$list.innerHTML = ''
      if (this.snapshots.length === 0) {
        this.$empty.hidden = false
        this.$summary.textContent = t('timeMachine.summaryZero')
        return
      }
      this.$empty.hidden = true
      const totalBytes = this.snapshots.reduce((acc, s) => acc + (s.sizeBytes || 0), 0)
      const size = fmtSize(totalBytes)
      this.$summary.textContent =
        this.snapshots.length === 1
          ? t('timeMachine.summarySingular', { size })
          : t('timeMachine.summaryPlural', { n: this.snapshots.length, size })
      for (const s of this.snapshots) this.$list.appendChild(this._renderRow(s))
    }

    _renderRow(s) {
      const row = document.createElement('div')
      row.className = 'tm-row'
      row.dataset.id = s.id

      const icon = document.createElement('div')
      icon.className = 'tm-icon'
      icon.textContent = REASON_ICON[s.reason] || '🗂'
      row.appendChild(icon)

      const labelCell = document.createElement('div')
      labelCell.className = 'tm-label'
      labelCell.textContent = s.label || s.id
      const sub = document.createElement('small')
      sub.textContent = t('timeMachine.rowFiles', { n: s.fileCount || 0 })
      labelCell.appendChild(sub)
      row.appendChild(labelCell)

      const reason = document.createElement('div')
      const badge = document.createElement('span')
      badge.className = `tm-reason ${s.reason || ''}`
      badge.textContent = reasonLabel(s.reason)
      reason.appendChild(badge)
      row.appendChild(reason)

      const when = document.createElement('div')
      when.className = 'tm-when'
      when.textContent = fmtDate(s.createdAt)
      row.appendChild(when)

      const size = document.createElement('div')
      size.className = 'tm-size'
      size.textContent = fmtSize(s.sizeBytes)
      row.appendChild(size)

      const actions = document.createElement('div')
      actions.className = 'tm-actions'
      const restoreBtn = document.createElement('button')
      restoreBtn.type = 'button'
      restoreBtn.title = t('timeMachine.actions.restore')
      restoreBtn.textContent = '↩'
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._doRestore(s)
      })
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'danger'
      delBtn.title = t('timeMachine.actions.delete')
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._doDelete(s)
      })
      actions.appendChild(restoreBtn)
      actions.appendChild(delBtn)
      row.appendChild(actions)

      return row
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.TimeMachine = new TimeMachine()
})()
