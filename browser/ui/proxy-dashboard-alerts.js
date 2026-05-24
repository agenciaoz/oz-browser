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
        // v2.0.0-alpha.22: inline "Assign proxy →" button for leak-risk
        // (identity-unassigned) alerts. The alert's targetId is the
        // identityId; we surface it as data-identity-id so the delegated
        // click handler can read it without re-parsing the alert object.
        const assignBtn =
          a.kind === 'identity-unassigned' && a.targetId
            ? `<button class="alert-assign" data-act="assign-proxy" data-identity-id="${esc(a.targetId)}" data-alert-id="${esc(a.id)}">${esc(
                t('proxyDashboard.alerts.assignProxy', 'Assign proxy →'),
              )}</button>`
            : ''
        return `<li class="alert" data-severity="${esc(a.severity || 'warning')}">
          <span class="alert-icon">${icon}</span>
          <div class="alert-body">
            <div class="alert-title">${esc(a.title || '')}</div>
            <div class="alert-message">${esc(a.message || '')}</div>
            <div class="alert-meta">${esc(meta)}</div>
          </div>
          ${assignBtn}
          <button class="alert-dismiss" data-act="dismiss-alert" data-id="${esc(a.id)}">
            ${t('proxyDashboard.alerts.dismiss', 'Dismiss')}
          </button>
        </li>`
      })
      .join('')
    injectAssignStylesOnce()
  }

  // v2.0.0-alpha.22: inline styles for the assign-proxy button + chooser.
  // Lazy injection — only runs the first time render() actually paints an
  // alert (cheap idempotency guard via element id).
  function injectAssignStylesOnce() {
    if (document.getElementById('oz-alerts-assign-styles')) return
    const style = document.createElement('style')
    style.id = 'oz-alerts-assign-styles'
    style.textContent = `
      .alert .alert-assign {
        background: rgba(124, 95, 191, 0.18);
        border: 1px solid var(--accent, #7c5fbf);
        color: var(--accent, #7c5fbf);
        padding: 3px 9px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        white-space: nowrap;
        flex: 0 0 auto;
        margin-right: 6px;
      }
      .alert .alert-assign:hover { background: rgba(124, 95, 191, 0.28); }
      .alert .alert-assign-row {
        display: flex; flex-direction: row; gap: 6px; align-items: center;
        margin-top: 6px;
      }
      .alert .alert-assign-row select {
        background: var(--bg, #1a1a1a); color: var(--text, #e8e8e8);
        border: 1px solid var(--border, #2e2e2e); border-radius: 4px;
        padding: 3px 6px; font-size: 11px;
      }
    `
    document.head.appendChild(style)
  }

  // ---------------- handleAssignProxy ----------------
  // Resolves the proxy pool, then either auto-assigns (1 proxy), opens an
  // inline picker (>1), or surfaces a "import first" hint (0).
  async function handleAssignProxy(identityId, alertEl, deps) {
    const { t, refresh } = deps
    if (!window.oz || !window.oz.proxies) return { ok: false, reason: 'NO_OZ' }
    const list =
      (await window.oz.proxies.listAssignable().catch(() => null)) ||
      (await window.oz.proxies.list().catch(() => null)) ||
      []
    const enabled = list.filter((p) => p && p.isActive && !p.isDisabled)
    if (enabled.length === 0) {
      if (alertEl) {
        const row = document.createElement('div')
        row.className = 'alert-assign-row'
        row.textContent = t(
          'proxyDashboard.alerts.noProxiesInPool',
          'No proxies in pool — import first',
        )
        alertEl.querySelector('.alert-body').appendChild(row)
      }
      return { ok: false, reason: 'EMPTY_POOL' }
    }
    if (enabled.length === 1) {
      const r = await window.oz.proxies.assignToIdentity(identityId, enabled[0].id)
      if (r && r.ok) await refresh()
      return r
    }
    // >1: inline <select> chooser
    if (!alertEl) return { ok: false, reason: 'NO_DOM' }
    if (alertEl.querySelector('.alert-assign-row')) return { ok: false, reason: 'OPEN' }
    const row = document.createElement('div')
    row.className = 'alert-assign-row'
    const opts = enabled
      .map(
        (p) =>
          `<option value="${p.id}">${(p.name || p.host).replace(/&/g, '&amp;').replace(/</g, '&lt;')}${p.country ? ' (' + p.country + ')' : ''}</option>`,
      )
      .join('')
    row.innerHTML = `
      <select class="oz-alert-proxy-pick" data-identity-id="${identityId}">
        <option value="">${t('proxyDashboard.alerts.assignChoose', 'Choose proxy…')}</option>
        ${opts}
      </select>
      <button class="alert-assign" data-act="assign-proxy-confirm" data-identity-id="${identityId}">
        ${t('proxyDashboard.alerts.assignConfirm', 'Confirm')}
      </button>
    `
    alertEl.querySelector('.alert-body').appendChild(row)
    return { ok: false, reason: 'CHOOSING' }
  }

  async function confirmAssignProxy(identityId, alertEl, deps) {
    const { refresh } = deps
    if (!alertEl) return { ok: false, reason: 'NO_DOM' }
    const sel = alertEl.querySelector('.oz-alert-proxy-pick')
    if (!sel || !sel.value) return { ok: false, reason: 'NO_SELECTION' }
    const r = await window.oz.proxies.assignToIdentity(identityId, sel.value)
    if (r && r.ok) await refresh()
    return r
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
  api.handleAssignProxy = handleAssignProxy
  api.confirmAssignProxy = confirmAssignProxy

  window.OZ_DashboardAlerts = api
})()
