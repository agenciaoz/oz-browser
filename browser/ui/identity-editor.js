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
  // v1.5.5: i18n — read t() lazily via helper so we always pick up the current
  // locale (window.OZ.i18n.t() also walks fallback to en if a key is missing).
  // We deliberately do NOT cache the function reference; locale switch via
  // setLocale() reassigns the catalog inside the same instance, but using the
  // global accessor keeps this resilient to test stubs.
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  // Same palette as identity-manager.js DEFAULT_COLORS — keep in sync if changed.
  const COLOR_PALETTE = [
    '#5b8def',
    '#ff7a45',
    '#36b37e',
    '#ffab00',
    '#9c5cf2',
    '#e85a8c',
    '#00b8d9',
    '#f15a5a',
    '#ff5630',
    '#8a8a8a',
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
      // v2.0.0-alpha.22: yellow "no proxy assigned" warning. Created lazily
      // on first open() so we don't depend on extra HTML markup in webui.html.
      this.$noProxyWarn = null
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
      this._applyUaHint()
      // v1.5.5: re-render dynamic strings on locale switch. translatePage()
      // handles plain data-i18n nodes, but our title (interpolated with the
      // identity name) and the UA hint (innerHTML with <strong>/<code>) need
      // manual refresh.
      if (window.OZ && window.OZ.i18n && typeof window.OZ.i18n.onChange === 'function') {
        window.OZ.i18n.onChange(() => {
          this._applyUaHint()
          if (this.current && !this.$modal.hidden) {
            this.$title.textContent = t('identityEditor.titleWithName', {
              name: this.current.name,
            })
          }
        })
      }
    }

    /**
     * Render the User-Agent hint <small> from the i18n catalog. Two states:
     *  - default identity: plain textContent (no UA editing allowed)
     *  - custom identity: innerHTML with <strong>/<code> formatting
     *
     * v1.5.5: replaces the dataset.originalText snapshot pattern — the source
     * of truth is now the catalog (identityEditor.uaHintHtml +
     * identityEditor.uaHintDefaultIdentity).
     */
    _applyUaHint() {
      if (!this.$uaHint) return
      const isDefault = !!(this.current && this.current.isDefault)
      if (isDefault) {
        this.$uaHint.textContent = t('identityEditor.uaHintDefaultIdentity')
      } else {
        this.$uaHint.innerHTML = t('identityEditor.uaHintHtml')
      }
    }

    _wire() {
      // Close on backdrop / close button / cancel.
      this.$modal
        .querySelectorAll('[data-close]')
        .forEach((el) => el.addEventListener('click', () => this.close()))
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
      this.$title.textContent = t('identityEditor.titleWithName', { name: identity.name })

      this.$form.elements.name.value = identity.name || ''
      this.$form.elements.userAgent.value = identity.userAgent || ''
      // v2.0.0-alpha.22: surface a yellow inline warning when this identity
      // is going to navigate with the real IP. Fire-and-forget — failures
      // (e.g. preload not loaded) just leave the warning hidden.
      this._refreshNoProxyWarning(identity).catch(() => {})

      // Default identity disables UA editing per ADR 0010.
      const isDefault = !!identity.isDefault
      this.$form.elements.userAgent.disabled = isDefault
      this.$uaDefault.disabled = isDefault
      this.$uaHint.style.opacity = isDefault ? '0.5' : '1'
      this._applyUaHint()

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
        window.oz.ui
          .setContentVisible(false)
          .then((r) =>
            console.log('[oz/identity-editor] setContentVisible(false) returned:', r),
          )
          .catch((e) =>
            console.error('[oz/identity-editor] setContentVisible(false) error:', e),
          )
      } else {
        console.warn("[oz/identity-editor] window.oz.ui MISSING — preload didn't load it")
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

    /**
     * v2.0.0-alpha.22 — show/hide an inline yellow warning when this
     * identity has no proxy assigned AND there ARE proxies in the pool
     * (otherwise the warning would just be noise — user has nothing to
     * fix). The default identity is exempt (ADR 0010: it uses the shared
     * session intentionally).
     */
    async _ensureNoProxyWarningEl() {
      if (this.$noProxyWarn) return this.$noProxyWarn
      const el = document.createElement('div')
      el.id = 'oz-identity-no-proxy-warn'
      el.style.cssText = `
        padding: 8px 12px;
        margin: 0 0 10px;
        background: rgba(255, 191, 0, 0.12);
        border: 1px solid rgba(255, 191, 0, 0.5);
        border-radius: 6px;
        font-size: 12px;
        color: #ffbf00;
      `
      el.hidden = true
      // Insert before the form so it's visually right under the header/error.
      this.$form.parentNode.insertBefore(el, this.$form)
      this.$noProxyWarn = el
      return el
    }

    async _refreshNoProxyWarning(identity) {
      const el = await this._ensureNoProxyWarningEl()
      if (!identity || identity.isDefault) {
        el.hidden = true
        return
      }
      let proxies = []
      try {
        proxies = window.oz && window.oz.proxies ? await window.oz.proxies.list() : []
      } catch (_e) {
        proxies = []
      }
      const enabled = (proxies || []).filter((p) => p && p.isActive && !p.isDisabled)
      let assigned = null
      try {
        assigned =
          window.oz && window.oz.proxies && window.oz.proxies.resolveForIdentity
            ? await window.oz.proxies.resolveForIdentity(identity.id)
            : null
      } catch (_e) {
        assigned = null
      }
      const noProxy = !assigned
      const poolHas = enabled.length > 0
      el.textContent = t('identityEditor.noProxyWarning')
      el.hidden = !(noProxy && poolHas)
    }

    async _submit() {
      if (!this.current) return
      const name = this.$form.elements.name.value.trim()
      if (!name) {
        this.$err.textContent = t('identityEditor.errorNameRequired')
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
          t('identityEditor.errorSaveFailed')
        this.$err.hidden = false
        return
      }
      this.close()
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.IdentityEditor = new IdentityEditor()
})()
