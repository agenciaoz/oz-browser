// OZ Browser — Proxy Health Badge UI (H-2a, v1.1.1).
//
// Toolbar dot rojo/amarillo/verde/gris que refleja el estado agregado de
// proxies del navigator. Polls cada 30s + on-demand al click.
//
// Click → por ahora abre el panel proxy-manager existente (modal). En H-2b
// el click pasa a abrir el dashboard tab full-screen — ese cambio es
// localized aquí en _onClick.
//
// Polling intencional simple (no event-driven aún): la fuente de verdad es
// el ProxyHealth daemon que tickea cada 30 min y los lifecycle hooks
// (proxyManager + proxyAssignment) no emiten EventEmitter events todavía
// (TODO post-v1). 30s de poll en renderer no impacta perf.

;(function () {
  const POLL_INTERVAL_MS = 30 * 1000

  class ProxyHealthBadge {
    constructor() {
      this.$btn = document.getElementById('oz-proxy-health-badge')
      if (!this.$btn) return
      this._timer = null
      this._status = null
      this._wire()
      this.refresh()
      this._startPoll()
    }

    _wire() {
      this.$btn.addEventListener('click', () => this._onClick())
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this._stopPoll()
        else {
          this.refresh()
          this._startPoll()
        }
      })
    }

    _startPoll() {
      if (this._timer) return
      this._timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS)
    }

    _stopPoll() {
      if (!this._timer) return
      clearInterval(this._timer)
      this._timer = null
    }

    async refresh() {
      if (!window.oz || !window.oz.proxyHealth) return
      try {
        const s = await window.oz.proxyHealth.getGlobalStatus()
        this._apply(s)
      } catch (_err) {
        this._apply({ status: 'gray', hint: 'Status unavailable', counts: {} })
      }
    }

    _apply(status) {
      this._status = status || {}
      const s = (this._status && this._status.status) || 'gray'
      this.$btn.dataset.status = s
      const cap = s.charAt(0).toUpperCase() + s.slice(1)
      const key = `proxyHealth.badge.tooltip${cap}`
      const t = window.OZ && window.OZ.t ? window.OZ.t : (_k) => null
      const i18nHint = t(key)
      const hint =
        this._status.hint ||
        (i18nHint && i18nHint !== key ? i18nHint : null) ||
        'Proxy health: ' + s
      this.$btn.title = hint
      this.$btn.setAttribute('aria-label', hint)
    }

    _onClick() {
      const oz = window.oz || {}
      const openModal = () => {
        const btn = document.getElementById('oz-pm-button')
        if (btn) btn.click()
      }
      // H-2b will provide oz.proxyHealth.openDashboard(). Fallback to modal.
      if (oz.proxyHealth && typeof oz.proxyHealth.openDashboard === 'function') {
        oz.proxyHealth.openDashboard().catch(() => openModal())
      } else {
        openModal()
      }
    }
  }

  function init() {
    window.OZ = window.OZ || {}
    if (window.OZ.proxyHealthBadge) return
    window.OZ.proxyHealthBadge = new ProxyHealthBadge()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
