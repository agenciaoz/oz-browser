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
  // v1.5.8: i18n — lazy lookup via window.OZ.i18n.t() so locale switches
  // pick up automatically. Falls back to the key if i18n hasn't loaded yet
  // (webui.html loads cloud-backup.js BEFORE i18n.js but the t() helper
  // here only runs on user-triggered async paths or after the catalog
  // fetch completes, never at constructor time).
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

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

      // v1.5.8: re-render dynamic content on locale switch. translatePage()
      // covers static markup (title, banner, labels, toggle text), but the
      // last-upload pill, device cards (incl. their meta + toggle button
      // label), and any expanded snapshot rows live in JS-set textContent.
      if (window.OZ?.i18n?.onChange) {
        window.OZ.i18n.onChange(() => {
          if (this.$modal.hidden) return
          this._refreshAll().catch(() => {
            // swallow — locale switch must never throw out of i18n callback
          })
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
        this._showError(t('cloudBackup.errorLoadStatus'))
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
          this.$lastUpload.textContent = t('cloudBackup.lastUploadError', {
            error: status.lastUploadError,
          })
          this.$lastUpload.className = 'cb-last-upload error'
        } else if (status.lastUploadAt) {
          this.$lastUpload.textContent = t('cloudBackup.lastUploadOk', {
            when: fmtDate(status.lastUploadAt),
          })
          this.$lastUpload.className = 'cb-last-upload ok'
        } else {
          this.$lastUpload.textContent = t('cloudBackup.noUploadsYet')
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
        this._showError(t('cloudBackup.errorListDevices'))
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
      this.$btnConnect.textContent = t('cloudBackup.connectingBtn')
      const r = await safe(window.oz.cloudBackup.connect(), 'cloudBackup.connect')
      this.$btnConnect.disabled = false
      this.$btnConnect.textContent = t('cloudBackup.connectBtn')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('cloudBackup.errorConnect'))
        return
      }
      // The OAuth flow continues in the user's default browser. When the
      // redirect lands, the protocol handler will trigger an oz:cloud-backup:
      // changed broadcast and we'll re-render. Show a hint meanwhile.
      this._showInfo(t('cloudBackup.connectInfo'))
    }

    _showInfo(msg) {
      this.$err.textContent = msg
      this.$err.className = 'oz-modal-error info'
      this.$err.hidden = false
    }

    async _doDisconnect() {
      if (!window.confirm(t('cloudBackup.confirmDisconnect'))) return
      const r = await safe(window.oz.cloudBackup.disconnect(), 'cloudBackup.disconnect')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('cloudBackup.errorDisconnect'))
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
        this._showError((r && r.__error?.message) || t('cloudBackup.errorToggle'))
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
      // Suffix " (this device)" is localized; emoji prefix stays universal.
      name.textContent =
        (d.isCurrentDevice ? '🖥 ' : '💻 ') +
        d.deviceFolder +
        (d.isCurrentDevice ? t('cloudBackup.thisDeviceSuffix') : '')
      head.appendChild(name)
      const meta = document.createElement('div')
      meta.className = 'cb-device-meta'
      // Build "{N} snapshots · {size}" + optional " · latest {when}".
      const snapsLabel =
        d.snapshotCount === 1
          ? t('cloudBackup.snapshotsSingular')
          : t('cloudBackup.snapshotsPlural', { n: d.snapshotCount })
      const latestPart = d.latestSnapshotAt
        ? t('cloudBackup.latestSuffix', { when: fmtDate(d.latestSnapshotAt) })
        : ''
      meta.textContent = `${snapsLabel} · ${fmtSize(d.totalSizeBytes)}${latestPart}`
      head.appendChild(meta)
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'cb-device-toggle'
      toggle.textContent =
        this.expandedDevice === d.deviceFolder
          ? t('cloudBackup.hideSnapshots')
          : t('cloudBackup.browseSnapshots')
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
          empty.textContent = t('cloudBackup.noRemoteSnapshots')
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
        this._showError(t('cloudBackup.errorListRemoteSnapshots'))
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
      restoreBtn.title = t('cloudBackup.actions.restoreTitle')
      restoreBtn.textContent = t('cloudBackup.actions.restoreText')
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._doRestore(s, deviceFolder)
      })
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'danger'
      delBtn.title = t('cloudBackup.actions.deleteTitle')
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
      const source = isOther
        ? t('cloudBackup.sourceLabelOther', { folder: deviceFolder })
        : t('cloudBackup.sourceLabelSelf')
      const ok = window.confirm(t('cloudBackup.confirmRestore', { id: s.id, source }))
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
        const msg = (r && r.__error?.message) || t('cloudBackup.errorRestoreFailed')
        const preId = r && r.__error?.preRestoreId
        this._showError(
          preId ? t('cloudBackup.errorRestoreWithPreId', { msg, preId }) : msg,
        )
        return
      }
      window.alert(t('cloudBackup.restoreSuccess', { source, preId: r.preRestoreId }))
    }

    async _doDelete(s, deviceFolder) {
      if (!window.confirm(t('cloudBackup.confirmDelete', { id: s.id }))) return
      const r = await safe(
        window.oz.cloudBackup.deleteRemote({ snapshotId: s.id, deviceFolder }),
        'cloudBackup.deleteRemote',
      )
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('cloudBackup.errorDeleteFailed'))
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
