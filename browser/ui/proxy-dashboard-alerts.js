// OZ Browser — Proxy Dashboard alerts section controller (H-2e, v1.1.3).
//
// Extracted from proxy-dashboard.js to keep that file under 500 LOC (ADR 0005).
// Exposes window.OZ_DashboardAlerts with state + fetch/render/wire helpers.
// The host dashboard.js calls into these from its main render loop and event
// wire, passing shared helpers (esc, fmtAgo, t) so we don't duplicate them.

;(function () {
  const api = {
    state: { alerts: [] },
  }

  // ---------------- fetch ----------------
  async function fetch() {
    if (!window.oz || !window.oz.proxyDiagnostics) {
      api.state.alerts = []
      return api.state.alerts
    }
    try {
      await window.oz.proxyDiagnostics.scan()
      const list = await window.oz.proxyDiagnostics.getAlerts()
      api.state.alerts = Array.isArray(list) ? list : []
    } catch (_e) {
      api.state.alerts = []
    }
    return api.state.alerts
  }

  // ---------------- render ----------------
  function render(deps) {
    const { esc, fmtAgo, t } = deps
    const list = document.getElementById('alerts-list')
    const empty = document.getElementById('alerts-empty')
    const countEl = document.getElementById('alerts-count')
    const dismissAllBtn = document.getElementById('alerts-dismiss-all')
    const alerts = api.state.alerts || []
    countEl.textContent = String(alerts.length)
    if (alerts.length === 0) {
      list.hidden = true
      list.innerHTML = ''
      empty.hidden = false
      dismissAllBtn.disabled = true
      return
    }
    list.hidden = false
    empty.hidden = true
    dismissAllBtn.disabled = false
    list.innerHTML = alerts
      .map((a) => {
        const icon = a.severity === 'urgent' ? '⚠' : 'ⓘ'
        const ago = fmtAgo(a.createdAt)
        const meta = `${(a.severity || '').toUpperCase()} · ${ago}`
        return `<li class="alert" data-severity="${esc(a.severity || 'warning')}">
          <span class="alert-icon">${icon}</span>
          <div class="alert-body">
            <div class="alert-title">${esc(a.title || '')}</div>
            <div class="alert-message">${esc(a.message || '')}</div>
            <div class="alert-meta">${esc(meta)}</div>
          </div>
          <button class="alert-dismiss" data-act="dismiss-alert" data-id="${esc(a.id)}">
            ${t('proxyDashboard.alerts.dismiss', 'Dismiss')}
          </button>
        </li>`
      })
      .join('')
  }

  // ---------------- dismiss-all wire ----------------
  function wireDismissAll(deps) {
    const { t, refresh } = deps
    const btn = document.getElementById('alerts-dismiss-all')
    if (!btn) return
    btn.addEventListener('click', async () => {
      const pd = window.oz && window.oz.proxyDiagnostics
      if (!pd) return
      const msg = t(
        'proxyDashboard.alerts.dismissAllConfirm',
        'Dismiss all active alerts? They will re-fire automatically if the underlying condition persists.',
      )
      if (!window.confirm(msg)) return
      try {
        await pd.dismissAll()
      } catch (_e) {
        /* ignore */
      }
      await refresh()
    })
  }

  // ---------------- single dismiss handler ----------------
  async function handleDismissAlert(id, deps) {
    const { refresh } = deps
    const pd = window.oz && window.oz.proxyDiagnostics
    if (!pd) return { ok: false, reason: 'NO_DIAG' }
    let r
    try {
      r = await pd.dismissAlert(id)
    } catch (err) {
      r = { ok: false, reason: 'IPC_ERROR', message: err.message }
    }
    await refresh()
    return r
  }

  api.fetch = fetch
  api.render = render
  api.wireDismissAll = wireDismissAll
  api.handleDismissAlert = handleDismissAlert

  window.OZ_DashboardAlerts = api
})()
