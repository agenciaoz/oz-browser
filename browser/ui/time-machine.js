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
            `✓ Snapshot restored.\n\nA pre-restore safety snapshot was saved as: ${payload.preRestoreId}\n\nRestart OZ Browser now so identities, workspaces and vault load fresh from disk.`,
          )
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
        this._showError('Failed to read vault status.')
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
        this._showError('Could not load snapshots.')
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
      this.$btnUnlock.textContent = 'Unlocking…'
      const r = await safe(window.oz.vault.unlock(), 'vault.unlock')
      this.$btnUnlock.disabled = false
      this.$btnUnlock.textContent = 'Unlock vault'
      if (!r || r.__error) {
        this._showError(
          (r && r.__error?.message) || 'Unlock failed. Check Keychain access.',
        )
        return
      }
      await this._reloadAndRender()
    }

    async _doSnapshotNow() {
      this._clearError()
      this.$btnSnapshotNow.disabled = true
      this.$btnSnapshotNow.textContent = 'Snapshotting…'
      const r = await safe(
        window.oz.timemachine.create({ reason: 'manual' }),
        'timemachine.create',
      )
      this.$btnSnapshotNow.disabled = false
      this.$btnSnapshotNow.textContent = '⏱ Take snapshot now'
      if (!r || r.__error) {
        this._showError(r?.__error?.message || 'Snapshot failed.')
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
        this._showError(r?.__error?.message || 'Retention failed.')
        return
      }
      window.alert(
        `Retention applied: ${r.deletedCount} snapshot(s) deleted (kept last 30 days + 1 per week for older).`,
      )
      await this._reloadAndRender()
    }

    async _doRestore(snapshot) {
      const ok = window.confirm(
        `Restore snapshot "${snapshot.label}"?\n\nThis REPLACES your current accounts, identities, workspaces and browser sessions with the contents from ${fmtDate(snapshot.createdAt)}.\n\nA safety snapshot of your CURRENT state will be created automatically before the restore — you can roll back if needed.\n\nAfter restore you must restart OZ Browser. Continue?`,
      )
      if (!ok) return
      this._clearError()
      const r = await safe(
        window.oz.timemachine.restore(snapshot.id),
        'timemachine.restore',
      )
      if (!r || r.__error) {
        const msg = r?.__error?.message || 'Restore failed.'
        const preId = r?.__error?.preRestoreId
        this._showError(
          preId
            ? `${msg}\nA pre-restore snapshot was saved as ${preId} — your data is intact.`
            : msg,
        )
        return
      }
      // Success message comes via onRestoreCompleted listener.
    }

    async _doDelete(snapshot) {
      const ok = window.confirm(
        `Delete snapshot "${snapshot.label}" (${fmtDate(snapshot.createdAt)})?\n\nThis cannot be undone.`,
      )
      if (!ok) return
      const r = await safe(
        window.oz.timemachine.remove(snapshot.id),
        'timemachine.remove',
      )
      if (!r || r.__error) {
        this._showError(r?.__error?.message || 'Delete failed.')
      }
    }

    _renderList() {
      this.$list.innerHTML = ''
      if (this.snapshots.length === 0) {
        this.$empty.hidden = false
        this.$summary.textContent = '0 snapshots'
        return
      }
      this.$empty.hidden = true
      const totalBytes = this.snapshots.reduce((acc, s) => acc + (s.sizeBytes || 0), 0)
      this.$summary.textContent = `${this.snapshots.length} snapshot${this.snapshots.length === 1 ? '' : 's'} · ${fmtSize(totalBytes)} total`
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
      sub.textContent = `${s.fileCount || 0} files`
      labelCell.appendChild(sub)
      row.appendChild(labelCell)

      const reason = document.createElement('div')
      const badge = document.createElement('span')
      badge.className = `tm-reason ${s.reason || ''}`
      badge.textContent = (s.reason || '').replace(/-/g, ' ')
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
      restoreBtn.title = 'Restore'
      restoreBtn.textContent = '↩'
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._doRestore(s)
      })
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'danger'
      delBtn.title = 'Delete'
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
