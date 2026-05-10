// OZ Browser — Account Manager modal (1.5f).
//
// Qué hace: overlay modal que cubre la app entera para gestionar el vault de
// accounts. Cuatro vistas:
//   1) lock     — vault locked, botón Unlock (Keychain prompt) + Reset
//   2) list     — search + filter (identity/workspace/status) + edit/delete + Export/Import
//   3) editor   — form crear/editar account
//   4) import   — picker de modo (PERMANENT_MERGE / EPHEMERAL / NEW_WORKSPACE / OVERWRITE)
//
// Doc: docs/modules/ui-account-manager.md
// Bloque: 1.5f
//
// Exports: window.OZ.AccountManager (singleton). open() es la API pública.
// IPC: usa window.oz.vault.* / accounts.* / excel.* via preload.
//
// Wrapped in IIFE — same global-lexical-scope reasoning del resto de UI scripts.

;(function () {
  const { safe } = window.OZ.utils

  class AccountManager {
    constructor() {
      this.$modal = document.getElementById('oz-am-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/account-manager', 'modal markup missing')
        }
        return
      }
      this.$openBtn = document.getElementById('oz-accounts-button')
      this.$err = document.getElementById('oz-am-error')

      // View roots
      this.$viewLock = document.getElementById('oz-am-lock')
      this.$viewList = document.getElementById('oz-am-list-view')
      this.$viewEditor = document.getElementById('oz-am-editor-view')
      this.$viewImport = document.getElementById('oz-am-import-view')

      // Lock view
      this.$btnUnlock = document.getElementById('oz-am-unlock-btn')
      this.$btnDestroy = document.getElementById('oz-am-destroy-btn')
      this.$lockTitle = document.getElementById('oz-am-lock-title')
      this.$lockDesc = document.getElementById('oz-am-lock-desc')

      // List view
      this.$search = document.getElementById('oz-am-search')
      this.$filterIdentity = document.getElementById('oz-am-filter-identity')
      this.$filterWorkspace = document.getElementById('oz-am-filter-workspace')
      this.$filterStatus = document.getElementById('oz-am-filter-status')
      this.$btnExport = document.getElementById('oz-am-export-btn')
      this.$btnImport = document.getElementById('oz-am-import-btn')
      this.$btnNew = document.getElementById('oz-am-new-btn')
      this.$btnLock = document.getElementById('oz-am-lock-btn')
      this.$list = document.getElementById('oz-am-list')
      this.$empty = document.getElementById('oz-am-empty')
      this.$counts = document.getElementById('oz-am-counts')

      // Editor view
      this.$form = document.getElementById('oz-am-form')
      this.$btnEditorCancel = document.getElementById('oz-am-editor-cancel')
      this.$btnEditorSave = document.getElementById('oz-am-editor-save')

      // Import view
      this.$importFilename = document.getElementById('oz-am-import-filename')
      this.$btnImportCancel = document.getElementById('oz-am-import-cancel')
      this.$btnImportConfirm = document.getElementById('oz-am-import-confirm')

      this.state = {
        accounts: [],
        identities: [],
        workspaces: [],
        editingId: null, // null = new account
        importPendingPath: null,
      }

      this._wire()
      this._wireBackgroundListeners()
    }

    // ---------- wiring ----------

    _wire() {
      // Open button
      if (this.$openBtn) {
        this.$openBtn.addEventListener('click', () => this.open())
        // Reflect vault status in the button dot at boot.
        this._refreshOpenButton()
      }

      // Generic close (backdrop / X)
      this.$modal.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', () => this.close())
      })
      document.addEventListener('keydown', (e) => {
        if (!this.$modal.hidden && e.key === 'Escape') this.close()
      })

      // Lock view
      this.$btnUnlock.addEventListener('click', () => this._doUnlock())
      this.$btnDestroy.addEventListener('click', () => this._doDestroy())

      // List view actions
      this.$btnNew.addEventListener('click', () => this._openEditor(null))
      this.$btnLock.addEventListener('click', () => this._doLock())
      this.$btnExport.addEventListener('click', () => this._doExport())
      this.$btnImport.addEventListener('click', () => this._doImportPick())

      // Filters / search — re-render list on input change
      ;[
        this.$search,
        this.$filterIdentity,
        this.$filterWorkspace,
        this.$filterStatus,
      ].forEach((el) => el.addEventListener('input', () => this._renderList()))

      // Editor save / cancel
      this.$btnEditorCancel.addEventListener('click', () => this._showView('list'))
      this.$btnEditorSave.addEventListener('click', () => this._submitEditor())
      this.$form.addEventListener('submit', (e) => {
        e.preventDefault()
        this._submitEditor()
      })

      // Import confirm / cancel
      this.$btnImportCancel.addEventListener('click', () => this._showView('list'))
      this.$btnImportConfirm.addEventListener('click', () => this._doImportConfirm())
    }

    _wireBackgroundListeners() {
      // Refresh open-button dot when vault state changes from elsewhere.
      if (window.oz && window.oz.vault && window.oz.vault.onChanged) {
        window.oz.vault.onChanged(() => this._refreshOpenButton())
      }
      // Re-render list when accounts/identities/workspaces change.
      if (window.oz && window.oz.accounts && window.oz.accounts.onChanged) {
        window.oz.accounts.onChanged(() => {
          if (!this.$modal.hidden) this._reloadAndRender()
        })
      }
      if (window.oz && window.oz.identities && window.oz.identities.onChanged) {
        window.oz.identities.onChanged(() => {
          if (!this.$modal.hidden) this._reloadAndRender()
        })
      }
      if (window.oz && window.oz.workspaces && window.oz.workspaces.onChanged) {
        window.oz.workspaces.onChanged(() => {
          if (!this.$modal.hidden) this._reloadAndRender()
        })
      }
    }

    // ---------- open / close ----------

    async open() {
      this._clearError()
      this.$modal.hidden = false
      // Hide WebContentsView so the modal isn't covered (ADR 0011 pattern).
      if (window.oz && window.oz.ui) {
        window.oz.ui.setContentVisible(false).catch(() => {})
      }
      await this._refreshAndShow()
    }

    close() {
      this.$modal.hidden = true
      if (window.oz && window.oz.ui) {
        window.oz.ui.setContentVisible(true).catch(() => {})
      }
    }

    async _refreshAndShow() {
      const status = await safe(window.oz.vault.status(), 'vault.status')
      if (!status || status.__error) {
        this._showError('Failed to read vault status. Check the log.')
        return
      }
      this._updateOpenBtnDot(status.isUnlocked)
      if (!status.isUnlocked) {
        this._showView('lock')
        if (!status.exists) {
          this.$lockTitle.textContent = 'Set up your vault'
          this.$lockDesc.textContent =
            'On first unlock, OZ generates a 256-bit master key, stores it in your macOS Keychain, and creates an empty vault. Click Unlock to begin — you may see a Keychain prompt.'
          this.$btnDestroy.hidden = true
        } else {
          this.$lockTitle.textContent = 'Vault is locked'
          this.$lockDesc.textContent =
            'Unlock the vault to access your saved accounts. The master key is stored in your macOS Keychain — you may be prompted to allow access.'
          this.$btnDestroy.hidden = false
        }
        return
      }
      // Unlocked → load and show list
      await this._reloadAndRender()
    }

    async _reloadAndRender() {
      const [accounts, identities, workspaces] = await Promise.all([
        safe(window.oz.accounts.list(), 'accounts.list'),
        safe(window.oz.identities.list(), 'identities.list'),
        safe(window.oz.workspaces.list(), 'workspaces.list'),
      ])
      if (!accounts || accounts.__error) {
        this._showError('Could not load accounts.')
        return
      }
      this.state.accounts = Array.isArray(accounts) ? accounts : []
      this.state.identities = Array.isArray(identities) ? identities : []
      this.state.workspaces = Array.isArray(workspaces) ? workspaces : []
      this._populateFilters()
      this._showView('list')
      this._renderList()
    }

    // ---------- view management ----------

    _showView(name) {
      this.$viewLock.hidden = name !== 'lock'
      this.$viewList.hidden = name !== 'list'
      this.$viewEditor.hidden = name !== 'editor'
      this.$viewImport.hidden = name !== 'import'
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

    _refreshOpenButton() {
      if (!this.$openBtn || !window.oz || !window.oz.vault) return
      window.oz.vault
        .status()
        .then((s) => this._updateOpenBtnDot(s && s.isUnlocked))
        .catch(() => {})
    }

    _updateOpenBtnDot(isUnlocked) {
      if (!this.$openBtn) return
      this.$openBtn.dataset.vault = isUnlocked ? 'unlocked' : 'locked'
    }

    // ---------- vault actions ----------

    async _doUnlock() {
      this._clearError()
      this.$btnUnlock.disabled = true
      this.$btnUnlock.textContent = 'Unlocking…'
      const r = await safe(window.oz.vault.unlock(), 'vault.unlock')
      this.$btnUnlock.disabled = false
      this.$btnUnlock.textContent = 'Unlock vault'
      if (!r || r.__error) {
        this._showError(
          (r && r.__error && r.__error.message) ||
            'Unlock failed. Check Keychain access.',
        )
        return
      }
      await this._reloadAndRender()
    }

    async _doLock() {
      const r = await safe(window.oz.vault.lock(), 'vault.lock')
      if (!r || r.__error) {
        this._showError('Failed to lock vault.')
        return
      }
      await this._refreshAndShow()
    }

    async _doDestroy() {
      const ok = window.confirm(
        'DESTROY the vault?\n\nThis deletes the encrypted file AND removes the master key from Keychain. Old accounts become unrecoverable. The next unlock will start a fresh, empty vault.\n\nThis cannot be undone.',
      )
      if (!ok) return
      const r = await safe(window.oz.vault.destroy(), 'vault.destroy')
      if (!r || r.__error) {
        this._showError('Failed to destroy vault.')
        return
      }
      await this._refreshAndShow()
    }

    // ---------- list rendering ----------

    _populateFilters() {
      const R = window.OZ.AccountManagerRender
      R.populateSelect(
        this.$filterIdentity,
        this.state.identities.map((i) => ({ value: i.id, label: i.name })),
        null,
        'All identities',
      )
      R.populateSelect(
        this.$filterWorkspace,
        this.state.workspaces.map((w) => ({ value: w.id, label: w.name })),
        null,
        'All workspaces',
      )
    }

    _renderList() {
      const R = window.OZ.AccountManagerRender
      // Wipe rows except the header (first child).
      while (this.$list.children.length > 1) {
        this.$list.removeChild(this.$list.lastChild)
      }
      const filtered = R.applyFilters(this.state.accounts, {
        query: this.$search.value,
        identityId: this.$filterIdentity.value,
        workspaceId: this.$filterWorkspace.value,
        status: this.$filterStatus.value,
      })
      const totalLbl = `${filtered.length} of ${this.state.accounts.length} account${this.state.accounts.length === 1 ? '' : 's'}`
      this.$counts.textContent = totalLbl
      if (filtered.length === 0) {
        this.$empty.hidden = false
        return
      }
      this.$empty.hidden = true
      const idMap = Object.fromEntries(this.state.identities.map((i) => [i.id, i]))
      const wsMap = Object.fromEntries(this.state.workspaces.map((w) => [w.id, w]))
      const callbacks = {
        onEdit: (a) => this._openEditor(a),
        onClick: (a) => this._openEditor(a),
        onDelete: (a) => this._confirmDelete(a),
      }
      for (const a of filtered) {
        this.$list.appendChild(R.renderRow(a, idMap, wsMap, callbacks))
      }
    }

    async _confirmDelete(account) {
      const ok = window.confirm(
        `Delete account "${account.username}" on ${account.site}?\n\nThis cannot be undone.`,
      )
      if (!ok) return
      const r = await safe(window.oz.accounts.remove(account.id), 'accounts.remove')
      if (r === false || (r && r.__error)) {
        this._showError('Failed to delete account.')
      }
    }

    // ---------- editor ----------

    _openEditor(accountOrNull) {
      this._clearError()
      this.state.editingId = accountOrNull ? accountOrNull.id : null
      this._populateEditorSelects()
      const f = this.$form.elements
      if (accountOrNull) {
        f.site.value = accountOrNull.site || ''
        f.username.value = accountOrNull.username || ''
        f.password.value = accountOrNull.password || ''
        f.identityId.value = accountOrNull.identityId || ''
        f.workspaceId.value = accountOrNull.workspaceId || ''
        f.totpSecret.value = accountOrNull.totpSecret || ''
        f.status.value = accountOrNull.status || 'active'
        f.notes.value = accountOrNull.notes || ''
      } else {
        this.$form.reset()
        // Sensible defaults for new account
        const defaultIdent =
          this.state.identities.find((i) => i.isDefault) || this.state.identities[0]
        if (defaultIdent) f.identityId.value = defaultIdent.id
        f.status.value = 'active'
      }
      this._showView('editor')
      setTimeout(() => f.site.focus(), 50)
    }

    _populateEditorSelects() {
      const R = window.OZ.AccountManagerRender
      const f = this.$form.elements
      R.populateSelect(
        f.identityId,
        this.state.identities.map((i) => ({ value: i.id, label: i.name })),
      )
      R.populateSelect(
        f.workspaceId,
        this.state.workspaces.map((w) => ({ value: w.id, label: w.name })),
        null,
        '— None —',
      )
    }

    async _submitEditor() {
      this._clearError()
      const f = this.$form.elements
      const payload = {
        site: f.site.value.trim(),
        username: f.username.value.trim(),
        password: f.password.value,
        identityId: f.identityId.value,
        workspaceId: f.workspaceId.value || null,
        totpSecret: f.totpSecret.value.trim() || null,
        status: f.status.value,
        notes: f.notes.value,
      }
      if (
        !payload.site ||
        !payload.username ||
        !payload.password ||
        !payload.identityId
      ) {
        this._showError('Site, username, password and identity are required.')
        return
      }
      let r
      if (this.state.editingId) {
        r = await safe(
          window.oz.accounts.update(this.state.editingId, payload),
          'accounts.update',
        )
      } else {
        r = await safe(window.oz.accounts.create(payload), 'accounts.create')
      }
      if (!r || r.__error) {
        this._showError(
          (r && r.__error && r.__error.message) || 'Failed to save account.',
        )
        return
      }
      this._showView('list')
    }

    // ---------- export / import ----------

    async _doExport() {
      this._clearError()
      const pick = await safe(window.oz.excel.pickExportPath(), 'excel.pickExportPath')
      if (!pick || pick.__error || pick.canceled) return
      const r = await safe(
        window.oz.excel.exportToFile(pick.filePath),
        'excel.exportToFile',
      )
      if (!r || r.__error) {
        this._showError(
          (r && r.__error && r.__error.message) || 'Export failed. Check the log.',
        )
        return
      }
      window.alert(
        `✓ Exported ${r.rows} account${r.rows === 1 ? '' : 's'} to:\n${r.filePath}\n\n⚠ This file contains plaintext passwords and 2FA secrets. Treat as sensitive material.`,
      )
    }

    async _doImportPick() {
      this._clearError()
      const pick = await safe(window.oz.excel.pickImportPath(), 'excel.pickImportPath')
      if (!pick || pick.__error || pick.canceled) return
      this.state.importPendingPath = pick.filePath
      this.$importFilename.textContent = pick.filePath.split('/').pop()
      this._showView('import')
    }

    async _doImportConfirm() {
      const mode = this.$modal.querySelector('input[name="import-mode"]:checked').value
      const path = this.state.importPendingPath
      if (!path) {
        this._showError('No file selected.')
        this._showView('list')
        return
      }
      if (mode === 'OVERWRITE_TOTAL') {
        const ok = window.confirm(
          '⚠ OVERWRITE TOTAL\n\nThis REPLACES the entire vault with the contents of the Excel file. Existing accounts will be permanently lost unless you have a backup.\n\nMake sure Time Machine has a recent snapshot. Proceed?',
        )
        if (!ok) return
      }
      this.$btnImportConfirm.disabled = true
      this.$btnImportConfirm.textContent = 'Importing…'
      const r = await safe(
        window.oz.excel.importFromFile(path, mode),
        'excel.importFromFile',
      )
      this.$btnImportConfirm.disabled = false
      this.$btnImportConfirm.textContent = 'Import'
      if (!r || r.__error) {
        this._showError(
          (r && r.__error && r.__error.message) || 'Import failed. Check the log.',
        )
        return
      }
      this.state.importPendingPath = null
      const summary = []
      summary.push(`✓ ${r.mode}: ${r.importedCount} account(s) imported.`)
      if (r.identitiesCreated && r.identitiesCreated.length) {
        summary.push(`↳ Identities auto-created: ${r.identitiesCreated.join(', ')}`)
      }
      if (r.workspacesCreated && r.workspacesCreated.length) {
        summary.push(`↳ Workspaces auto-created: ${r.workspacesCreated.join(', ')}`)
      }
      window.alert(summary.join('\n'))
      this._showView('list')
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.AccountManager = new AccountManager()
})()
