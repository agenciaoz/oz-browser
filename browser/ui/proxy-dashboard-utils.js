// OZ Browser — Proxy Dashboard shared utils (extracted for LOC budget — H-2i+j, v1.1.4).
//
// Helpers shared across the proxy dashboard modules: time formatting, HTML
// escape, i18n bridge. Lives here (instead of inlined in proxy-dashboard.js)
// because the dashboard controller exceeded the 500 LOC budget once H-2i/j
// integrations were added. Sibling modules (proxy-dashboard-health.js,
// proxy-dashboard-leaks.js, etc) get their `t` / `esc` injected by the
// caller, so moving these out keeps them stable.
//
// Pattern matches the other proxy-dashboard-*.js sibling modules: IIFE
// that attaches to window.OZ_DashboardUtils.
//
// Doc: docs/modules/proxy-dashboard-utils.md (TBD)

;(function () {
  function fmtAgo(ts) {
    if (!ts) return '—'
    const d = Date.now() - ts
    if (d < 60 * 1000) return Math.round(d / 1000) + 's ago'
    if (d < 60 * 60 * 1000) return Math.round(d / 60000) + 'm ago'
    if (d < 24 * 60 * 60 * 1000) return Math.round(d / 3600000) + 'h ago'
    return Math.round(d / 86400000) + 'd ago'
  }

  function fmtCountry(c) {
    if (!c) return '—'
    return String(c).toUpperCase()
  }

  function fmtMs(ms) {
    if (ms == null) return '—'
    return Math.round(ms) + 'ms'
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function t(key, fallback) {
    const tt = window.OZ && window.OZ.t
    if (!tt) return fallback || key
    const v = tt(key)
    if (!v || v === key) return fallback || key
    return v
  }

  // alpha.108: identity-row cell builders (extraídos de proxy-dashboard.js
  // por presupuesto LOC — ADR 0005). Devuelve {proxyCell, reassignOpts}.
  function buildIdentityRowBits(i, proxyOptions) {
    const isDirect = i.routingMode === 'direct'
    const proxyCell = i.proxy
      ? `${esc(i.proxy.name || '?')} <span class="small">${esc(
          i.proxy.host,
        )}:${esc(i.proxy.port)}</span>`
      : isDirect
        ? `<span class="small">${t('proxyDashboard.directCell', 'Direct (no proxy)')}</span>`
        : `<span class="leak-flag">${t('proxyDashboard.noProxy', 'No proxy — leak risk')}</span>`
    const reassignOpts = [
      `<option value="(none)">${t('proxyDashboard.actions.none', 'None')}</option>`,
      `<option value="direct"${isDirect ? ' selected' : ''}>${t('proxyDashboard.actions.direct', 'Direct (no proxy — fast)')}</option>`,
      `<option value="auto-random">${t('proxyDashboard.actions.autoRandom', 'auto-random')}</option>`,
      `<option value="auto-round-robin">${t('proxyDashboard.actions.autoRoundRobin', 'auto-round-robin')}</option>`,
      ...(proxyOptions || []).map(
        (p) =>
          `<option value="${esc(p.id)}"${
            i.proxy && i.proxy.id === p.id ? ' selected' : ''
          }>${esc(p.name)} (${esc(p.country || '—')})</option>`,
      ),
    ].join('')
    return { proxyCell, reassignOpts }
  }

  window.OZ_DashboardUtils = { fmtAgo, fmtCountry, fmtMs, esc, t, buildIdentityRowBits }
})()
