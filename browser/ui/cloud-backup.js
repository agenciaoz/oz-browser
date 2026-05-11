// OZ Browser — Cloud Backup modal (Bloque D-1.6).
//
// Doc: docs/modules/ui-cloud-backup.md
// Bloque: D-1.6
//
// Mismo patrón que time-machine.js (1.6c) / account-manager.js (1.5f).
// Capas (mismo modal, distintas vistas):
//   1) disconnected — banner + botón "Connect Dropbox"
//   2) connected    — account info + auto-upload toggle + lista de devices
//                     con sus snapshots expandibles
//
// Exports: window.OZ.CloudBackup (singleton). API pública: open(), close().
// IPC: window.oz.cloudBackup.*

;(function () {
  const { safe } = window.OZ.utils

  function fmtDate(iso) {
    try {
      const d = new Date(iso)
      return `${d.toLocaleDateString()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    } catch (_) {
      return iso || '—'
    }
  }
  function fmtSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  class CloudBackup {
    constructor() {
      this.$modal = document.getElementById('oz-cb-modal')
      if (!this.$modal) {
        window.oz?.log?.warn('webui/cloud-backup', 'modal markup missing')
        return
      }
      this.$err = document.getElementById('oz-cb-error')
      this.$viewDisc = document.getElementById('oz-cb-disconnected-view')
      this.$viewConn = document.getElementById('oz-cb-connected-view')
      this.$btnConnect = document.getElementById('oz-cb-connect-btn')
      this.$btnDisconnect = document.getElementById('oz-cb-disconnect-btn')
      this.$accountEmail = document.getElementById('oz-cb-account-email')
      this.$deviceFolder = document.getElementById('oz-cb-device-folder')
      this.$autoToggle = document.getElementById('oz-cb-auto-toggle')
      this.$lastUpload = document.getElementById('oz-cb-last-upload')
      this.$devicesList = document.getElementById('oz-cb-devices')
      this.$devicesEmpty = document.getElementById('oz-cb-devices-empty')
      this.$refreshBtn = document.getElementById('oz-cb-refresh-btn')

      this.status = null
      this.devices = []
      this.expandedDevice = null
      this.expandedSnapshots = []

      this._wire()
      if (window.oz?.cloudBackup?.onChanged) {
        window.oz.cloudBackup.onChanged(() => {
          if (!this.$modal.hidden) this._refreshAll()
        })
      }
    }

    _wire() {
      this.$modal.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', () => this.close())
      })
      document.addEventListener('keydown', (e) => {
        if (!this.$modal.hidden && e.key === 'Escape') this.close()
      })
      this.$btnConnect?.addEventListener('click', () => this._doConnect())
      this.$btnDisconnect?.addEventListener('click', () => this._doDisconnect())
      this.$autoToggle?.addEventListener('change', () => this._doToggleAuto())
      this.$refreshBtn?.addEventListener('click', () => this._refreshAll())
    }

    async open() {
      this._clearError()
      this.$modal.hidden = false
      if (window.oz?.ui) window.oz.ui.setContentVisible(false).catch(() => {})
      await this._refreshAll()
    }
    close() {
      this.$modal.hidden = true
      if (window.oz?.ui) window.oz.ui.setContentVisible(true).catch(() => {})
    }

    async _refreshAll() {
      const status = await safe(window.oz.cloudBackup.status(), 'cloudBackup.status')
      if (!status || status.__error) {
        this._showError('Failed to load cloud backup status.')
        return
      }
      this.status = status
      if (!status.connected) {
        this._showView('disconnected')
        if (this.$deviceFolder) {
          this.$deviceFolder.textContent = status.deviceFolder || '—'
        }
        return
      }
      this._showView('connected')
      if (this.$accountEmail)
        this.$accountEmail.textContent = (status.account && status.account.email) || '—'
      if (this.$deviceFolder) this.$deviceFolder.textContent = status.deviceFolder || '—'
      if (this.$autoToggle) this.$autoToggle.checked = !!status.autoUpload
      if (this.$lastUpload) {
        if (status.lastUploadError) {
          this.$lastUpload.textContent = `⚠ Last upload failed: ${status.lastUploadError}`
          this.$lastUpload.className = 'cb-last-upload error'
        } else if (status.lastUploadAt) {
          this.$lastUpload.textContent = `✓ Last upload: ${fmtDate(status.lastUploadAt)}`
          this.$lastUpload.className = 'cb-last-upload ok'
        } else {
          this.$lastUpload.textContent = 'No uploads yet.'
          this.$lastUpload.className = 'cb-last-upload'
        }
      }
      await this._reloadDevices()
    }

    async _reloadDevices() {
      const list = await safe(
        window.oz.cloudBackup.listDevices(),
        'cloudBackup.listDevices',
      )
      if (!list || list.__error) {
        this._showError('Failed to list devices.')
        return
      }
      this.devices = Array.isArray(list) ? list : []
      if (this.devices.length === 0) {
        if (this.$devicesEmpty) this.$devicesEmpty.hidden = false
        if (this.$devicesList) this.$devicesList.innerHTML = ''
        return
      }
      if (this.$devicesEmpty) this.$devicesEmpty.hidden = true
      this._renderDevices()
    }

    _showView(name) {
      this.$viewDisc.hidden = name !== 'disconnected'
      this.$viewConn.hidden = name !== 'connected'
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

    async _doConnect() {
      this._clearError()
      this.$btnConnect.disabled = true
      this.$btnConnect.textContent = 'Opening browser…'
      const r = await safe(window.oz.cloudBackup.connect(), 'cloudBackup.connect')
      this.$btnConnect.disabled = false
      this.$btnConnect.textContent = 'Connect Dropbox'
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Connect failed.')
        return
      }
      // The OAuth flow continues in the user's default browser. When the
      // redirect lands, the protocol handler will trigger an oz:cloud-backup:
      // changed broadcast and we'll re-render. Show a hint meanwhile.
      this._showInfo(
        'A browser tab opened for Dropbox authorization. Approve there, then come back.',
      )
    }

    _showInfo(msg) {
      this.$err.textContent = msg
      this.$err.className = 'oz-modal-error info'
      this.$err.hidden = false
    }

    async _doDisconnect() {
      if (
        !window.confirm(
          'Disconnect Dropbox? Local snapshots stay safe; cloud copies will no longer be uploaded.',
        )
      )
        return
      const r = await safe(window.oz.cloudBackup.disconnect(), 'cloudBackup.disconnect')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Disconnect failed.')
        return
      }
      await this._refreshAll()
    }

    async _doToggleAuto() {
      const next = !!this.$autoToggle.checked
      const r = await safe(
        window.oz.cloudBackup.setAutoUpload(next),
        'cloudBackup.setAutoUpload',
      )
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Toggle failed.')
        this.$autoToggle.checked = !next
      }
    }

    _renderDevices() {
      this.$devicesList.innerHTML = ''
      for (const d of this.devices) {
        this.$devicesList.appendChild(this._renderDeviceCard(d))
      }
    }

    _renderDeviceCard(d) {
      const card = document.createElement('div')
      card.className = 'cb-device' + (d.isCurrentDevice ? ' current' : '')
      card.dataset.deviceFolder = d.deviceFolder

      const head = document.createElement('div')
      head.className = 'cb-device-head'
      const name = document.createElement('div')
      name.className = 'cb-device-name'
      name.textContent =
        (d.isCurrentDevice ? '🖥 ' : '💻 ') +
        d.deviceFolder +
        (d.isCurrentDevice ? ' (this device)' : '')
      head.appendChild(name)
      const meta = document.createElement('div')
      meta.className = 'cb-device-meta'
      meta.textContent =
        `${d.snapshotCount} snapshot${d.snapshotCount === 1 ? '' : 's'} · ${fmtSize(d.totalSizeBytes)}` +
        (d.latestSnapshotAt ? ` · latest ${fmtDate(d.latestSnapshotAt)}` : '')
      head.appendChild(meta)
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'cb-device-toggle'
      toggle.textContent =
        this.expandedDevice === d.deviceFolder ? 'Hide snapshots ▲' : 'Browse snapshots ▼'
      toggle.disabled = d.snapshotCount === 0
      toggle.addEventListener('click', () => this._toggleDevice(d.deviceFolder))
      head.appendChild(toggle)
      card.appendChild(head)

      if (this.expandedDevice === d.deviceFolder) {
        const list = document.createElement('div')
        list.className = 'cb-snapshots'
        if (this.expandedSnapshots.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'cb-snapshots-empty'
          empty.textContent = 'No remote snapshots in this device folder.'
          list.appendChild(empty)
        } else {
          for (const s of this.expandedSnapshots) {
            list.appendChild(this._renderSnapshotRow(s, d.deviceFolder))
          }
        }
        card.appendChild(list)
      }
      return card
    }

    async _toggleDevice(deviceFolder) {
      if (this.expandedDevice === deviceFolder) {
        this.expandedDevice = null
        this.expandedSnapshots = []
        this._renderDevices()
        return
      }
      const items = await safe(
        window.oz.cloudBackup.listRemoteSnapshots(deviceFolder),
        'cloudBackup.listRemoteSnapshots',
      )
      if (!items || items.__error) {
        this._showError('Failed to list remote snapshots.')
        return
      }
      this.expandedDevice = deviceFolder
      this.expandedSnapshots = Array.isArray(items) ? items : []
      this._renderDevices()
    }

    _renderSnapshotRow(s, deviceFolder) {
      const row = document.createElement('div')
      row.className = 'cb-snap-row'
      const id = document.createElement('div')
      id.className = 'cb-snap-id'
      id.textContent = s.id
      row.appendChild(id)
      const size = document.createElement('div')
      size.className = 'cb-snap-size'
      size.textContent = fmtSize(s.sizeBytes)
      row.appendChild(size)
      const when = document.createElement('div')
      when.className = 'cb-snap-when'
      when.textContent = fmtDate(s.serverModified)
      row.appendChild(when)
      const actions = document.createElement('div')
      actions.className = 'cb-snap-actions'
      const restoreBtn = document.createElement('button')
      restoreBtn.type = 'button'
      restoreBtn.title = 'Download + restore'
      restoreBtn.textContent = '↩ Restore'
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._doRestore(s, deviceFolder)
      })
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'danger'
      delBtn.title = 'Delete remote'
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._doDelete(s, deviceFolder)
      })
      actions.appendChild(restoreBtn)
      actions.appendChild(delBtn)
      row.appendChild(actions)
      return row
    }

    async _doRestore(s, deviceFolder) {
      const isOther = deviceFolder !== this.status?.deviceFolder
      const sourceLabel = isOther
        ? `another device (${deviceFolder})`
        : 'this device (cloud copy)'
      const ok = window.confirm(
        `Restore snapshot "${s.id}" from ${sourceLabel}?\n\n` +
          `This REPLACES your current accounts, identities, workspaces and browser sessions.\n\n` +
          `A safety snapshot of your CURRENT state will be created automatically. ` +
          `After restore you must restart OZ Browser. Continue?`,
      )
      if (!ok) return
      this._clearError()
      const r = await safe(
        window.oz.cloudBackup.downloadAndRestore({
          snapshotId: s.id,
          deviceFolder,
        }),
        'cloudBackup.downloadAndRestore',
      )
      if (!r || r.__error) {
        const msg = (r && r.__error?.message) || 'Restore failed.'
        const preId = r && r.__error?.preRestoreId
        this._showError(
          preId
            ? `${msg}\nA pre-restore snapshot was saved as ${preId} — your data is intact.`
            : msg,
        )
        return
      }
      window.alert(
        `✓ Snapshot restored from ${sourceLabel}.\n\n` +
          `Pre-restore safety snapshot: ${r.preRestoreId}\n\n` +
          `Restart OZ Browser now so identities, workspaces and vault load fresh from disk.`,
      )
    }

    async _doDelete(s, deviceFolder) {
      if (!window.confirm(`Delete remote snapshot "${s.id}"?\n\nThis cannot be undone.`))
        return
      const r = await safe(
        window.oz.cloudBackup.deleteRemote({ snapshotId: s.id, deviceFolder }),
        'cloudBackup.deleteRemote',
      )
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Delete failed.')
        return
      }
      // Refresh snapshots in expanded device
      if (this.expandedDevice === deviceFolder) {
        const items = await safe(
          window.oz.cloudBackup.listRemoteSnapshots(deviceFolder),
          'cloudBackup.listRemoteSnapshots',
        )
        this.expandedSnapshots = Array.isArray(items) ? items : []
        this._renderDevices()
      }
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.CloudBackup = new CloudBackup()
})()
