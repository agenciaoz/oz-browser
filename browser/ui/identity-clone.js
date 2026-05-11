// OZ Browser — Identity Clone modal UI (E2-C-3 fase 4).
//
// Modal mini con name input + 3 checkboxes (sameFingerprint, sameProxy, sameUA)
// + Cancel/Clone buttons. Triggered by:
//   - Right-click identity in sidebar → "Clone identity…"
//   - Cmd+K palette → "Clone Identity…" (uses active identity)
//   - Programmatic: window.OZ.IdentityClone.open(srcId)
//
// Markup: oz-clone-* ids in webui.html.
// Self-instantiating singleton on window.OZ.IdentityClone (parity with
// AccountManager + TimeMachine pattern). Probed by command-palette modalMap.
//
// IIFE-wrapped — ver oz-utils.js comment.

;(function () {
  if (!window.OZ) window.OZ = {}
  const { safe } = window.OZ.utils

  class IdentityCloneUI {
    constructor() {
      this.$modal = document.getElementById('oz-clone-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/identity-clone', 'modal markup missing')
        }
        return
      }
      this.$srcLabel = document.getElementById('oz-clone-src-label')
      this.$srcDot = document.getElementById('oz-clone-src-dot')
      this.$name = document.getElementById('oz-clone-name')
      this.$cbFingerprint = document.getElementById('oz-clone-cb-fingerprint')
      this.$cbProxy = document.getElementById('oz-clone-cb-proxy')
      this.$cbUA = document.getElementById('oz-clone-cb-ua')
      this.$proxyHint = document.getElementById('oz-clone-proxy-hint')
      this.$uaHint = document.getElementById('oz-clone-ua-hint')
      this.$submit = document.getElementById('oz-clone-submit')
      this.$cancel = document.getElementById('oz-clone-cancel')
      this.$error = document.getElementById('oz-clone-error')

      this.srcId = null
      this.src = null
      this.isOpen = false
      this._wire()
    }

    _wire() {
      if (window.oz?.sidebar?.onRequestCloneIdentity) {
        window.oz.sidebar.onRequestCloneIdentity((payload) => {
          if (payload && payload.id) this.open(payload.id)
        })
      }
      this.$cancel.addEventListener('click', () => this.close())
      this.$submit.addEventListener('click', () => this._submit())
      this.$modal.addEventListener('click', (e) => {
        if (e.target === this.$modal) this.close()
      })
      document.addEventListener('keydown', (e) => {
        if (!this.isOpen) return
        if (e.key === 'Escape') {
          e.preventDefault()
          this.close()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          this._submit()
        }
      })
    }

    /**
     * Open the modal. If srcId is omitted, falls back to the active identity.
     */
    async open(srcId) {
      if (!srcId) {
        srcId = await safe(window.oz.identities.getActive(), 'identities.getActive')
      }
      if (!srcId) {
        this._showError('No identity selected to clone.')
        return
      }
      const src = await safe(window.oz.identities.get(srcId), 'identities.get')
      if (!src) {
        this._showError('Identity not found (it may have been deleted).')
        return
      }
      this.srcId = srcId
      this.src = src

      // Render the source identity preview row.
      this.$srcLabel.textContent = src.name
      this.$srcDot.style.background = src.color || '#888'

      // Pre-fill the name with the auto-generated suggestion via the main
      // process — it knows about all existing names + collision avoidance.
      const previewName = await safe(
        window.oz.identities.previewCloneName(src.name),
        'identities.previewCloneName',
      )
      this.$name.value = previewName || `${src.name} (copy)`

      // Defaults: fresh fingerprint (anti-detect safety), inherit proxy if
      // the source has one assigned, no UA copy.
      this.$cbFingerprint.checked = false
      this.$cbProxy.checked = !!src.userAgent || true // default ON if proxy ever assigned
      this.$cbUA.checked = false

      // Disable + grey out checkboxes for fields the source doesn't have
      // (e.g. no UA override → no point checking sameUA).
      const hasUA = !!src.userAgent
      this.$cbUA.disabled = !hasUA
      this.$uaHint.textContent = hasUA
        ? `(currently: ${shortUA(src.userAgent)})`
        : '(source has no custom UA)'

      // Proxy hint — best-effort fetch of assignment (may not exist).
      this.$proxyHint.textContent = '(if source has a proxy assigned)'

      this._clearError()
      this._show()
      // Focus name input + select-all so user can immediately type.
      setTimeout(() => {
        this.$name.focus()
        this.$name.select()
      }, 50)
    }

    close() {
      this._hide()
      this.srcId = null
      this.src = null
      this._clearError()
    }

    async _submit() {
      const name = this.$name.value.trim()
      if (!name) {
        this._showError('Name cannot be empty.')
        this.$name.focus()
        return
      }
      if (!this.srcId) {
        this._showError('No source identity.')
        return
      }
      this.$submit.disabled = true
      this._clearError()

      const opts = {
        name,
        sameFingerprint: this.$cbFingerprint.checked,
        sameProxy: this.$cbProxy.checked,
        sameUA: this.$cbUA.checked,
      }
      const result = await safe(
        window.oz.identities.clone(this.srcId, opts),
        'identities.clone',
      )
      this.$submit.disabled = false

      if (!result || result.ok === false) {
        const reason = (result && result.reason) || 'unknown'
        if (reason === 'IDENTITY_CAP_REACHED') {
          this._showError(
            'Free tier identity cap reached (max 3). Upgrade to clone more identities.',
          )
        } else {
          this._showError(`Clone failed: ${reason}`)
        }
        return
      }
      // Success — close. The sidebar refreshes automatically via the
      // oz:identities:changed broadcast emitted by the handler.
      this.close()
    }

    _show() {
      this.$modal.removeAttribute('hidden')
      this.isOpen = true
      // Hide active WebContentsView so the modal isn't covered by it.
      safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible(false)')
    }

    _hide() {
      this.$modal.setAttribute('hidden', '')
      this.isOpen = false
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible(true)')
    }

    _showError(msg) {
      this.$error.textContent = msg
      this.$error.removeAttribute('hidden')
    }

    _clearError() {
      this.$error.textContent = ''
      this.$error.setAttribute('hidden', '')
    }
  }

  function shortUA(ua) {
    if (!ua) return ''
    if (ua.length <= 60) return ua
    return ua.slice(0, 57) + '…'
  }

  // Self-instantiate singleton (parity with AccountManager / TimeMachine).
  document.addEventListener('DOMContentLoaded', () => {
    window.OZ.IdentityClone = new IdentityCloneUI()
  })
})()
