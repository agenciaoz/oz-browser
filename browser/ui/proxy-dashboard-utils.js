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

  window.OZ_DashboardUtils = { fmtAgo, fmtCountry, fmtMs, esc, t }
})()
