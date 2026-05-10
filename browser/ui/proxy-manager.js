// OZ Browser — Proxy Manager modal (1.8d).
//
// Qué hace: overlay modal con CRUD de proxies + import/export CSV + provider
// templates (Oxylabs real, 3 stubs). Tres vistas conmutables:
//   1) list     — tabla con todos los proxies + toolbar (add / import / export
//                 / providers / test all)
//   2) editor   — form para add/edit individual (host, port, protocol, auth)
//   3) providers — cards de los 4 providers; al click expande Oxylabs con form
//
// Doc: docs/modules/ui-proxy-manager.md
// Bloque: 1.8d
//
// Exports: window.OZ.ProxyManagerUI (singleton). open() es la API pública.
// IPC: usa window.oz.proxies.* via preload.
//
// Wrapped in IIFE — same global-lexical-scope reasoning del resto de UI scripts.

;(function () {
  const { safe } = window.OZ.utils

  class ProxyManagerUI {
    constructor() {
      this.$modal = document.getElementById('oz-pm-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/proxy-manager', 'modal markup missing')
        }
        return
      }
      this.$openBtn = document.getElementById('oz-pm-button')
      this.$count = document.getElementById('oz-pm-count')
      this.$err = document.getElementById('oz-pm-error')
      this.$summary = document.getElementById('oz-pm-summary')

      // Views
      this.$viewList = document.getElementById('oz-pm-list-view')
      this.$viewEditor = document.getElementById('oz-pm-editor-view')
      this.$viewProviders = document.getElementById('oz-pm-providers-view')

      // List view
      this.$tbody = document.getElementById('oz-pm-tbody')
      this.$empty = document.getElementById('oz-pm-empty')
      this.$btnAdd = document.getElementById('oz-pm-add-btn')
      this.$btnImport = document.getElementById('oz-pm-import-btn')
      this.$btnExport = document.getElementById('oz-pm-export-btn')
      this.$btnProviders = document.getElementById('oz-pm-providers-btn')
      this.$btnTestAll = document.getElementById('oz-pm-test-all-btn')

      // Editor view
      this.$form = document.getElementById('oz-pm-form')
      this.$formTitle = document.getElementById('oz-pm-editor-title')
      this.$formName = document.getElementById('oz-pm-form-name')
      this.$formProto = document.getElementById('oz-pm-form-protocol')
      this.$formHost = document.getElementById('oz-pm-form-host')
      this.$formPort = document.getElementById('oz-pm-form-port')
      this.$formUser = document.getElementById('oz-pm-form-username')
      this.$formPass = document.getElementById('oz-pm-form-password')
      this.$formCountry = document.getElementById('oz-pm-form-country')
      this.$formCancel = document.getElementById('oz-pm-form-cancel')

      // Providers view
      this.$providers = document.getElementById('oz-pm-providers')
      this.$providerFormWrap = document.getElementById('oz-pm-provider-form-wrap')
      this.$providersBack = document.getElementById('oz-pm-providers-back')

      this.editingId = null
      this.proxies = []

      this._wire()
    }

    _wire() {
      if (this.$openBtn) {
        this.$openBtn.addEventListener('click', () => this.open())
      }
      this.$modal.addEventListener('click', (ev) => {
        if (ev.target.dataset.close !== undefined) this.close()
      })
      this.$btnAdd.addEventListener('click', () => this.openEditor(null))
      this.$btnImport.addEventListener('click', () => this.handleImport())
      this.$btnExport.addEventListener('click', () => this.handleExport())
      this.$btnProviders.addEventListener('click', () => this.openProviders())
      this.$btnTestAll.addEventListener('click', () => this.handleTestAll())
      this.$formCancel.addEventListener('click', () => this.showView('list'))
      this.$form.addEventListener('submit', (ev) => {
        ev.preventDefault()
        this.handleFormSubmit()
      })
      this.$providersBack.addEventListener('click', () => this.showView('list'))

      if (window.oz && window.oz.proxies && window.oz.proxies.onChanged) {
        window.oz.proxies.onChanged(() => this.refresh())
      }
      this.refresh() // initial sidebar count
    }

    async open() {
      this.$modal.hidden = false
      await safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      await this.refresh()
      this.showView('list')
    }

    close() {
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
      this.clearError()
    }

    showView(name) {
      this.$viewList.hidden = name !== 'list'
      this.$viewEditor.hidden = name !== 'editor'
      this.$viewProviders.hidden = name !== 'providers'
    }

    showError(msg) {
      this.$err.textContent = msg
      this.$err.hidden = false
    }
    clearError() {
      this.$err.hidden = true
      this.$err.textContent = ''
    }

    // ---- list ---------------------------------------------------------------

    async refresh() {
      this.proxies = await safe(window.oz.proxies.list(), 'proxies.list')
      if (!Array.isArray(this.proxies)) this.proxies = []
      if (this.$count) {
        this.$count.textContent = this.proxies.length ? `(${this.proxies.length})` : ''
      }
      if (!this.$modal || this.$modal.hidden) return
      this.renderList()
    }

    renderList() {
      this.$tbody.innerHTML = ''
      if (this.proxies.length === 0) {
        this.$empty.style.display = ''
        this.$summary.textContent = '0 proxies'
        return
      }
      this.$empty.style.display = 'none'
      this.$summary.textContent = `${this.proxies.length} proxies`
      for (const p of this.proxies) {
        this.$tbody.appendChild(this.renderRow(p))
      }
    }

    renderRow(p) {
      const tr = document.createElement('tr')
      tr.className = 'pm-row'
      if (p.isDisabled || !p.isActive) tr.classList.add('disabled')
      tr.innerHTML = `
        <td>${escape(p.name || '')}</td>
        <td>${p.protocol}</td>
        <td>${escape(p.host)}:${p.port}</td>
        <td>${escape(p.username || '—')}</td>
        <td>${this.statusBadge(p)}</td>
        <td>${p.lastLatencyMs != null ? p.lastLatencyMs + ' ms' : '—'}</td>
        <td>—</td>
        <td class="pm-actions"></td>
      `
      const actions = tr.querySelector('.pm-actions')
      const test = btn('Test', () => this.handleTestOne(p.id))
      const edit = btn('Edit', () => this.openEditor(p.id))
      const toggle = btn(p.isActive ? 'Disable' : 'Enable', () =>
        this.handleToggleActive(p.id, !p.isActive),
      )
      const del = btn('Delete', () => this.handleDelete(p.id), 'danger')
      actions.appendChild(test)
      actions.appendChild(edit)
      actions.appendChild(toggle)
      actions.appendChild(del)
      return tr
    }

    statusBadge(p) {
      if (p.isDisabled) return `<span class="pm-status disabled">Disabled</span>`
      if (!p.isActive) return `<span class="pm-status untested">Inactive</span>`
      if (p.failureCount > 0)
        return `<span class="pm-status fail">${p.failureCount} fails</span>`
      if (p.lastTestedAt) return `<span class="pm-status ok">OK</span>`
      return `<span class="pm-status untested">Untested</span>`
    }

    // ---- editor -------------------------------------------------------------

    openEditor(proxyId) {
      this.editingId = proxyId
      this.clearError()
      this.$formTitle.textContent = proxyId ? 'Edit proxy' : 'Add proxy'
      if (proxyId) {
        const p = this.proxies.find((x) => x.id === proxyId)
        if (!p) return this.showError('Proxy not found')
        this.$formName.value = p.name || ''
        this.$formProto.value = p.protocol
        this.$formHost.value = p.host
        this.$formPort.value = p.port
        this.$formUser.value = p.username || ''
        this.$formPass.value = p.password || ''
        this.$formCountry.value = p.country || ''
      } else {
        this.$form.reset()
        this.$formProto.value = 'https'
      }
      this.showView('editor')
      setTimeout(() => this.$formHost.focus(), 30)
    }

    async handleFormSubmit() {
      this.clearError()
      const opts = {
        name: this.$formName.value.trim() || null,
        protocol: this.$formProto.value,
        host: this.$formHost.value.trim(),
        port: parseInt(this.$formPort.value, 10),
        username: this.$formUser.value || null,
        password: this.$formPass.value || null,
        country: this.$formCountry.value.trim() || null,
      }
      let r
      if (this.editingId) {
        r = await safe(window.oz.proxies.update(this.editingId, opts), 'proxies.update')
      } else {
        r = await safe(window.oz.proxies.create(opts), 'proxies.create')
      }
      if (r && r.__error) {
        this.showError(r.__error.message)
        return
      }
      this.showView('list')
      await this.refresh()
    }

    async handleDelete(id) {
      if (
        !confirm(
          `Delete this proxy?\n\nAny identity / workspace assignment will be cleared automatically.`,
        )
      )
        return
      await safe(window.oz.proxies.remove(id), 'proxies.remove')
      await this.refresh()
    }

    async handleToggleActive(id, isActive) {
      await safe(window.oz.proxies.setActive(id, isActive), 'proxies.setActive')
      await this.refresh()
    }

    async handleTestOne(id) {
      const r = await safe(
        window.oz.proxies.testConnectivity(id),
        'proxies.testConnectivity',
      )
      if (r && r.ok === false && r.reason) {
        // Don't show alert for routine failures; the table updates with status.
        if (r.autoDisabled) {
          alert(
            `Proxy auto-disabled after 3 failures. Re-enable from the table when fixed.`,
          )
        }
      }
      await this.refresh()
    }

    async handleTestAll() {
      this.$btnTestAll.disabled = true
      this.$btnTestAll.textContent = 'Testing…'
      try {
        await safe(window.oz.proxies.testAll(), 'proxies.testAll')
      } finally {
        this.$btnTestAll.disabled = false
        this.$btnTestAll.textContent = '⚡ Test all'
      }
      await this.refresh()
    }

    // ---- import / export ---------------------------------------------------

    async handleImport() {
      const r = await safe(
        window.oz.proxies.pickCsvImportPath(),
        'proxies.pickCsvImportPath',
      )
      if (!r || r.canceled || !r.filePath) return
      const out = await safe(
        window.oz.proxies.importCsvFromFile(r.filePath),
        'proxies.importCsvFromFile',
      )
      if (out && out.ok) {
        alert(`Imported ${out.addedCount} of ${out.parsedCount} proxies.`)
      } else if (out) {
        this.showError(`Import failed: ${out.message || out.reason}`)
      }
      await this.refresh()
    }

    async handleExport() {
      if (this.proxies.length === 0) {
        return alert('No proxies to export.')
      }
      const r = await safe(
        window.oz.proxies.pickCsvExportPath(),
        'proxies.pickCsvExportPath',
      )
      if (!r || r.canceled || !r.filePath) return
      const out = await safe(
        window.oz.proxies.exportCsvToFile(r.filePath),
        'proxies.exportCsvToFile',
      )
      if (out && out.ok) {
        alert(`Exported ${this.proxies.length} proxies to ${out.filePath}`)
      }
    }

    // ---- providers ----------------------------------------------------------

    async openProviders() {
      this.clearError()
      this.$providers.innerHTML = ''
      this.$providerFormWrap.innerHTML = ''
      const list = await safe(window.oz.proxies.listProviders(), 'proxies.listProviders')
      for (const prov of list || []) {
        const card = document.createElement('div')
        card.className = `pm-provider-card ${prov.status === 'coming-soon' ? 'coming-soon' : ''}`
        card.innerHTML = `
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">${escape(prov.label)}</div>
          <div class="pm-provider-status">${prov.status === 'available' ? '✅ Available' : '🚧 Coming soon'}</div>
        `
        if (prov.status === 'available') {
          card.addEventListener('click', () => this.renderProviderForm(prov))
        }
        this.$providers.appendChild(card)
      }
      this.showView('providers')
    }

    renderProviderForm(prov) {
      this.$providerFormWrap.innerHTML = ''
      const form = document.createElement('form')
      form.className = 'pm-form'
      form.style.marginTop = '14px'
      const title = document.createElement('div')
      title.className = 'pm-section-title'
      title.style.gridColumn = '1 / -1'
      title.textContent = `${prov.label} — generate proxies`
      form.appendChild(title)

      const inputs = {}
      for (const f of prov.fields) {
        const label = document.createElement('label')
        label.textContent = f.label
        label.htmlFor = `oz-pm-prov-${f.id}`
        form.appendChild(label)
        const input = document.createElement('input')
        input.type = f.type || 'text'
        input.id = `oz-pm-prov-${f.id}`
        if (f.placeholder) input.placeholder = f.placeholder
        form.appendChild(input)
        inputs[f.id] = input
      }
      const actions = document.createElement('div')
      actions.className = 'pm-form-actions'
      actions.innerHTML = `<button type="submit">Generate</button>`
      form.appendChild(actions)
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault()
        const opts = {}
        for (const k of Object.keys(inputs)) {
          const v = inputs[k].value.trim()
          if (v) opts[k] = inputs[k].type === 'number' ? Number(v) : v
        }
        const r = await safe(
          window.oz.proxies.expandProvider(prov.id, opts),
          'proxies.expandProvider',
        )
        if (r && r.__error) {
          this.showError(r.__error.message)
          return
        }
        if (r && r.ok) {
          alert(`Added ${r.addedCount} ${prov.label} proxies.`)
          this.showView('list')
          await this.refresh()
        }
      })
      this.$providerFormWrap.appendChild(form)
    }
  }

  function btn(label, onClick, cls = '') {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    if (cls) b.className = cls
    b.addEventListener('click', onClick)
    return b
  }

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  window.OZ = window.OZ || {}
  window.OZ.ProxyManagerUI = ProxyManagerUI
})()
