// OZ Browser — Anti-Detect Health modal UI (E2-C-6).
//
// Modal con 4 rows (uno por vector: IP↔TZ, fingerprint coherence, cookie
// health, proxy reachability), cada uno con status dot, summary y botón
// inline para fix cuando aplica. Triggered by:
//   - Right-click identity in sidebar → "Health check…"
//   - Cmd+K palette → "Anti-Detect Health Check…" (uses active identity)
//   - Sidebar dot click (yellow/red badges)
//   - Programmatic: window.OZ.HealthCheck.open(identityId)
//
// Markup: oz-health-* ids in webui.html.
// Self-instantiating singleton on window.OZ.HealthCheck (parity with
// IdentityClone + AccountManager pattern).
//
// IIFE-wrapped — ver oz-utils.js comment.

;(function () {
  if (!window.OZ) window.OZ = {}
  const { safe } = window.OZ.utils

  const VECTOR_LABELS = {
    ipTimezone: { icon: '🌍', name: 'IP ↔ Timezone' },
    fingerprintCoherence: { icon: '🧬', name: 'Fingerprint coherence' },
    cookieHealth: { icon: '🍪', name: 'Cookie health' },
    proxyReachability: { icon: '🌐', name: 'Proxy reachability' },
  }

  const STATUS_LABEL = {
    green: 'OK',
    yellow: 'Warning',
    red: 'Critical',
    unknown: 'Unknown',
  }

  class HealthCheckUI {
    constructor() {
      this.$modal = document.getElementById('oz-health-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/health-check', 'modal markup missing')
        }
        return
      }
      this.$srcLabel = document.getElementById('oz-health-src-label')
      this.$srcDot = document.getElementById('oz-health-src-dot')
      this.$overall = document.getElementById('oz-health-overall')
      this.$body = document.getElementById('oz-health-body')
      this.$cancel = document.getElementById('oz-health-cancel')
      this.$refresh = document.getElementById('oz-health-refresh')
      this.$error = document.getElementById('oz-health-error')

      this.identityId = null
      this.record = null
      this.isOpen = false
      this._wire()
    }

    _wire() {
      if (window.oz && window.oz.sidebar && window.oz.sidebar.onRequestHealthCheck) {
        window.oz.sidebar.onRequestHealthCheck((payload) => {
          if (payload && payload.id) this.open(payload.id)
        })
      }
      if (window.oz && window.oz.health && window.oz.health.onChanged) {
        window.oz.health.onChanged((payload) => {
          // If the change applies to the open identity, refresh in-place.
          if (
            this.isOpen &&
            this.identityId &&
            payload &&
            payload.identityId === this.identityId
          ) {
            this._fetchAndRender()
          }
        })
      }
      this.$cancel.addEventListener('click', () => this.close())
      if (this.$refresh) {
        this.$refresh.addEventListener('click', () => this._fetchAndRender())
      }
      this.$modal.addEventListener('click', (e) => {
        if (e.target === this.$modal) this.close()
        // Backdrop close
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
     * Open the modal. If identityId is omitted, falls back to the active
     * identity. Performs the initial health fetch + render.
     */
    async open(identityId) {
      if (!identityId) {
        identityId = await safe(window.oz.identities.getActive(), 'identities.getActive')
      }
      if (!identityId) {
        this._showError('No identity selected.')
        return
      }
      this.identityId = identityId
      this._clearError()
      this._show()
      await this._fetchAndRender()
    }

    close() {
      this._hide()
      this.identityId = null
      this.record = null
      this._clearError()
    }

    async _fetchAndRender() {
      if (!this.identityId) return
      const record = await safe(window.oz.health.get(this.identityId), 'health.get')
      if (!record || record.__error) {
        this._showError(
          (record && record.__error && record.__error.message) ||
            'Failed to load health record.',
        )
        return
      }
      this.record = record
      this._render(record)
    }

    _render(record) {
      // Header — identity name + color dot + overall pill.
      this.$srcLabel.textContent = record.identityName || record.identityId
      this.$srcDot.style.background = record.identityColor || '#888'
      this.$overall.textContent = `Overall: ${STATUS_LABEL[record.overall] || record.overall}`
      this.$overall.className = `oz-health-overall oz-health-overall-${record.overall}`

      // Body — 4 vector rows.
      this.$body.innerHTML = ''
      const order = [
        'ipTimezone',
        'fingerprintCoherence',
        'cookieHealth',
        'proxyReachability',
      ]
      for (const key of order) {
        const v = record.vectors[key]
        if (!v) continue
        this.$body.appendChild(this._renderVectorRow(key, v))
      }
    }

    _renderVectorRow(key, vector) {
      const meta = VECTOR_LABELS[key] || { icon: '•', name: key }
      const row = document.createElement('div')
      row.className = `oz-health-vector oz-health-vector-${vector.status}`
      row.dataset.vector = key

      const head = document.createElement('div')
      head.className = 'oz-health-vector-head'

      const dot = document.createElement('span')
      dot.className = `oz-health-vector-dot oz-health-${vector.status}`
      head.appendChild(dot)

      const title = document.createElement('span')
      title.className = 'oz-health-vector-title'
      title.textContent = `${meta.icon} ${meta.name}`
      head.appendChild(title)

      const statusPill = document.createElement('span')
      statusPill.className = `oz-health-vector-status oz-health-status-${vector.status}`
      statusPill.textContent = STATUS_LABEL[vector.status] || vector.status
      head.appendChild(statusPill)

      row.appendChild(head)

      const summary = document.createElement('div')
      summary.className = 'oz-health-vector-summary'
      summary.textContent = vector.summary || '—'
      row.appendChild(summary)

      // Inline fix button — only when the lib offered one.
      if (vector.fix && vector.fix.kind && vector.fix.label) {
        const actions = document.createElement('div')
        actions.className = 'oz-health-vector-actions'
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'oz-btn oz-btn-small'
        btn.textContent = vector.fix.label
        btn.addEventListener('click', () => this._applyFix(key, vector.fix.kind, btn))
        actions.appendChild(btn)
        row.appendChild(actions)
      }

      return row
    }

    async _applyFix(vector, kind, btn) {
      if (!this.identityId) return
      btn.disabled = true
      const originalLabel = btn.textContent
      btn.textContent = 'Working…'
      const result = await safe(
        window.oz.health.applyFix({ identityId: this.identityId, kind, vector }),
        'health.applyFix',
      )
      btn.disabled = false
      btn.textContent = originalLabel
      if (!result || result.ok === false) {
        const reason = (result && result.reason) || 'unknown'
        this._showError(`Fix failed: ${reason}`)
        return
      }
      this._clearError()
      // Refresh — main process broadcasts oz:health:changed which our
      // onChanged listener catches, but we also re-fetch directly to make
      // the UI feel immediate.
      await this._fetchAndRender()
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

  // Self-instantiate singleton (parity with IdentityClone / AccountManager).
  document.addEventListener('DOMContentLoaded', () => {
    window.OZ.HealthCheck = new HealthCheckUI()
  })
})()
