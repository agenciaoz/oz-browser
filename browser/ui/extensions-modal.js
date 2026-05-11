// OZ Browser — Extensions per-identity modal UI (E2-C-7).
//
// Modal con dropdown de identity + tabla de Default-installed extensions
// con checkbox "enabled for this identity" cada una. Triggered by:
//   - Right-click identity in sidebar → "Manage extensions…"
//   - Cmd+K palette → "Manage extensions for identity…" (uses active identity)
//   - Programmatic: window.OZ.ExtensionsManager.open(identityId?)
//
// Markup: oz-ext-* ids in webui.html.
// Self-instantiating singleton on window.OZ.ExtensionsManager.
//
// IIFE-wrapped — ver oz-utils.js comment.

;(function () {
  if (!window.OZ) window.OZ = {}
  const { safe } = window.OZ.utils

  class ExtensionsManagerUI {
    constructor() {
      this.$modal = document.getElementById('oz-ext-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/extensions-modal', 'modal markup missing')
        }
        return
      }
      this.$identitySelect = document.getElementById('oz-ext-identity-select')
      this.$body = document.getElementById('oz-ext-body')
      this.$cancel = document.getElementById('oz-ext-cancel')
      this.$error = document.getElementById('oz-ext-error')
      this.$empty = document.getElementById('oz-ext-empty')

      this.identityId = null
      this.identities = []
      this.isOpen = false
      this._wire()
    }

    _wire() {
      if (window.oz && window.oz.sidebar && window.oz.sidebar.onRequestManageExt) {
        window.oz.sidebar.onRequestManageExt((payload) => {
          if (payload && payload.id) this.open(payload.id)
        })
      }
      if (window.oz && window.oz.extensions && window.oz.extensions.onChanged) {
        window.oz.extensions.onChanged((payload) => {
          if (this.isOpen && payload && payload.identityId === this.identityId) {
            this._renderTable()
          }
        })
      }
      this.$cancel.addEventListener('click', () => this.close())
      this.$identitySelect.addEventListener('change', (e) => {
        this.identityId = e.target.value
        this._renderTable()
      })
      this.$modal.addEventListener('click', (e) => {
        if (e.target === this.$modal) this.close()
        if (e.target.classList && e.target.classList.contains('oz-modal-backdrop')) {
          this.close()
        }
      })
      document.addEventListener('keydown', (e) => {
        if (!this.isOpen) return
        if (e.key === 'Escape') {
          e.preventDefault()
          this.close()
        }
      })
    }

    /**
     * Open the modal preset to the given identity (or active identity if
     * omitted). Loads identities list + extension report.
     */
    async open(identityId) {
      this.identities = await safe(window.oz.identities.list(), 'identities.list')
      if (!identityId) {
        identityId = await safe(window.oz.identities.getActive(), 'identities.getActive')
      }
      this.identityId = identityId || (this.identities[0] && this.identities[0].id)
      if (!this.identityId) {
        this._showError('No identities available.')
        return
      }
      this._renderIdentitySelect()
      this._clearError()
      this._show()
      await this._renderTable()
    }

    close() {
      this._hide()
      this.identityId = null
      this._clearError()
    }

    _renderIdentitySelect() {
      this.$identitySelect.innerHTML = ''
      for (const ident of this.identities || []) {
        const opt = document.createElement('option')
        opt.value = ident.id
        opt.textContent = ident.isDefault ? `${ident.name} (Default)` : ident.name
        if (ident.id === this.identityId) opt.selected = true
        this.$identitySelect.appendChild(opt)
      }
    }

    async _renderTable() {
      if (!this.identityId) return
      this.$body.innerHTML = ''
      this.$empty.setAttribute('hidden', '')
      const report = await safe(
        window.oz.extensions.report(this.identityId),
        'extensions.report',
      )
      if (!report || report.length === 0) {
        this.$empty.removeAttribute('hidden')
        return
      }
      const isDefault = report[0] && report[0].isDefault
      for (const ext of report) {
        this.$body.appendChild(this._renderRow(ext, isDefault))
      }
    }

    _renderRow(ext, isDefault) {
      const row = document.createElement('div')
      row.className = 'oz-ext-row'
      row.dataset.extId = ext.id

      const info = document.createElement('div')
      info.className = 'oz-ext-info'
      const name = document.createElement('div')
      name.className = 'oz-ext-name'
      name.textContent = ext.name
      info.appendChild(name)
      const meta = document.createElement('div')
      meta.className = 'oz-ext-meta'
      meta.textContent = `v${ext.version}${ext.description ? ' — ' + ext.description : ''}`
      info.appendChild(meta)
      row.appendChild(info)

      const action = document.createElement('div')
      action.className = 'oz-ext-action'
      if (isDefault) {
        const tag = document.createElement('span')
        tag.className = 'oz-ext-tag'
        tag.textContent = 'Always enabled'
        action.appendChild(tag)
      } else {
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = !!ext.enabledForIdentity
        checkbox.id = `oz-ext-cb-${ext.id}`
        checkbox.addEventListener('change', () => this._toggle(ext, checkbox))
        const label = document.createElement('label')
        label.htmlFor = checkbox.id
        label.className = 'oz-ext-cb-label'
        label.textContent = checkbox.checked ? 'Enabled' : 'Disabled'
        action.appendChild(checkbox)
        action.appendChild(label)
      }
      row.appendChild(action)
      return row
    }

    async _toggle(ext, checkbox) {
      checkbox.disabled = true
      const want = checkbox.checked
      const fn = want ? window.oz.extensions.enable : window.oz.extensions.disable
      const result = await safe(fn(this.identityId, ext.id), 'extensions.toggle')
      checkbox.disabled = false
      if (!result || result.ok === false) {
        const reason = (result && result.reason) || 'unknown'
        checkbox.checked = !want
        this._showError(`Toggle failed: ${reason}`)
        return
      }
      this._clearError()
      const label = checkbox.parentElement.querySelector('.oz-ext-cb-label')
      if (label) label.textContent = want ? 'Enabled' : 'Disabled'
    }

    _show() {
      this.$modal.removeAttribute('hidden')
      this.isOpen = true
      safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible(false)')
    }

    _hide() {
      this.$modal.setAttribute('hidden', '')
      this.isOpen = false
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible(true)')
    }

    _showError(msg) {
      if (!this.$error) return
      this.$error.textContent = msg
      this.$error.removeAttribute('hidden')
    }

    _clearError() {
      if (!this.$error) return
      this.$error.textContent = ''
      this.$error.setAttribute('hidden', '')
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.OZ.ExtensionsManager = new ExtensionsManagerUI()
  })
})()
