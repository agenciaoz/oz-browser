// OZ Browser — Identity editor modal.
//
// Qué hace: overlay modal en webui.html para editar Identity (name, color,
//   custom User-Agent). Triggered desde el context menu del sidebar
//   (handler: window.OZ.IdentityEditor.open(identity)).
// Doc: docs/modules/ui-identity-editor.md
// ADR: docs/architecture/0010-per-identity-user-agent.md
//
// Exports: window.OZ.IdentityEditor (singleton)
// IPC: usa window.oz.identities.update via preload
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const { safe } = window.OZ.utils

// Same palette as identity-manager.js DEFAULT_COLORS — keep in sync if changed.
const COLOR_PALETTE = [
  '#5b8def', '#ff7a45', '#36b37e', '#ffab00', '#9c5cf2',
  '#e85a8c', '#00b8d9', '#f15a5a', '#ff5630', '#8a8a8a',
]

class IdentityEditor {
  constructor() {
    this.$modal = document.getElementById('oz-identity-modal')
    this.$form = document.getElementById('oz-identity-form')
    this.$err = document.getElementById('oz-identity-modal-error')
    this.$swatches = document.getElementById('oz-identity-swatches')
    this.$uaDefault = document.getElementById('oz-identity-ua-default')
    this.$uaHint = document.getElementById('oz-identity-ua-hint')
    this.$title = document.getElementById('oz-identity-modal-title')
    this.current = null
    this.selectedColor = COLOR_PALETTE[0]

    if (!this.$modal) {
      // webui.html missing the modal markup — bail silently in production but
      // log in dev so we catch it.
      if (window.oz && window.oz.log) {
        window.oz.log.warn('webui/identity-editor', 'modal markup not found')
      }
      return
    }

    this._wire()
    this._renderSwatches()
  }

  _wire() {
    // Close on backdrop / close button / cancel.
    this.$modal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', () => this.close()),
    )
    document.addEventListener('keydown', (e) => {
      if (!this.$modal.hidden && e.key === 'Escape') this.close()
    })

    this.$uaDefault.addEventListener('click', () => {
      this.$form.elements.userAgent.value = ''
      this.$form.elements.userAgent.focus()
    })

    this.$form.addEventListener('submit', (e) => {
      e.preventDefault()
      this._submit()
    })
  }

  _renderSwatches() {
    this.$swatches.innerHTML = ''
    for (const color of COLOR_PALETTE) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.style.background = color
      btn.dataset.color = color
      btn.addEventListener('click', () => this._selectColor(color))
      this.$swatches.appendChild(btn)
    }
  }

  _selectColor(color) {
    this.selectedColor = color
    this.$swatches.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('selected', b.dataset.color === color)
    })
  }

  /**
   * Open the modal seeded with an identity. Caller passes a snapshot,
   * not a reference — we don't mutate it.
   */
  open(identity) {
    if (!identity) return
    this.current = identity
    this.$err.hidden = true
    this.$err.textContent = ''
    this.$title.textContent = `Edit Identity — ${identity.name}`

    this.$form.elements.name.value = identity.name || ''
    this.$form.elements.userAgent.value = identity.userAgent || ''

    // Default identity disables UA editing per ADR 0010.
    const isDefault = !!identity.isDefault
    this.$form.elements.userAgent.disabled = isDefault
    this.$uaDefault.disabled = isDefault
    this.$uaHint.style.opacity = isDefault ? '0.5' : '1'
    if (isDefault) {
      this.$uaHint.dataset.originalText =
        this.$uaHint.dataset.originalText || this.$uaHint.innerHTML
      this.$uaHint.textContent =
        'Default Identity uses the shared session — UA cannot be customized here. ' +
        'Use a custom Identity instead.'
    } else if (this.$uaHint.dataset.originalText) {
      this.$uaHint.innerHTML = this.$uaHint.dataset.originalText
    }

    // Pick the swatch closest to current color (or first).
    const colorMatch = COLOR_PALETTE.includes(identity.color)
      ? identity.color
      : COLOR_PALETTE[0]
    this._selectColor(colorMatch)

    this.$modal.hidden = false
    // Hide the active tab's WebContentsView so the modal isn't covered by it
    // (native views always render on top of HTML chrome — see ipc-handlers
    // oz:ui:setContentVisible).
    console.log('[oz/identity-editor] open() — calling setContentVisible(false)', {
      hasOzUi: !!(window.oz && window.oz.ui),
      identity: identity.name,
    })
    if (window.oz && window.oz.ui) {
      window.oz.ui.setContentVisible(false)
        .then((r) => console.log('[oz/identity-editor] setContentVisible(false) returned:', r))
        .catch((e) => console.error('[oz/identity-editor] setContentVisible(false) error:', e))
    } else {
      console.warn('[oz/identity-editor] window.oz.ui MISSING — preload didn\'t load it')
    }
    setTimeout(() => this.$form.elements.name.focus(), 50)
  }

  close() {
    this.$modal.hidden = true
    this.current = null
    if (window.oz && window.oz.ui) {
      window.oz.ui.setContentVisible(true).catch(() => {})
    }
  }

  async _submit() {
    if (!this.current) return
    const name = this.$form.elements.name.value.trim()
    if (!name) {
      this.$err.textContent = 'Name is required.'
      this.$err.hidden = false
      return
    }
    const ua = this.$form.elements.userAgent.value.trim()
    const patch = {
      name,
      color: this.selectedColor,
    }
    if (!this.current.isDefault) {
      patch.userAgent = ua // empty string → null (default) in IdentityManager.update.
    }

    const result = await safe(
      window.oz.identities.update(this.current.id, patch),
      'identities.update',
    )
    if (!result || result.__error) {
      this.$err.textContent =
        (result && result.__error && result.__error.message) ||
        'Failed to save. Check the log.'
      this.$err.hidden = false
      return
    }
    this.close()
  }
}

  window.OZ = window.OZ || {}
  window.OZ.IdentityEditor = new IdentityEditor()
})()
