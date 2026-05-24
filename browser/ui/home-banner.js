// OZ Browser — Home banner (v2.0.0-alpha.22).
//
// Top-of-shell yellow banner that surfaces "N identities sin proxy — están
// navegando con tu IP real" when:
//   - identities.filter(i => !i.isDefault && !resolvedProxyId).length > 0
//   - proxyManager has at least 1 enabled proxy in the pool
//   - user hasn't dismissed in the last 24h (localStorage timestamp)
//
// Two CTAs:
//   - "Asignar ahora →" opens the Proxy Health Dashboard tab
//   - "Dismiss" stamps localStorage with now() so we hide for 24h
//
// Re-evaluates on:
//   - DOMContentLoaded
//   - oz:identities:changed broadcasts
//   - oz:proxies:changed broadcasts
//
// All translation goes through window.OZ.i18n.t with fallbacks so the module
// is resilient to load-order glitches (i18n.js loads earlier in webui.html).

;(function () {
  const DISMISS_KEY = 'proxy-warning-banner-dismissed-at'
  const DISMISS_TTL_MS = 24 * 60 * 60 * 1000 // 24h

  let $el = null
  let evaluating = false

  function t(key, params, fallback) {
    if (window.OZ && window.OZ.i18n && typeof window.OZ.i18n.t === 'function') {
      return window.OZ.i18n.t(key, params)
    }
    let s = fallback || key
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.replace('{{' + k + '}}', params[k])
      }
    }
    return s
  }

  function isDismissedRecently() {
    try {
      const raw = localStorage.getItem(DISMISS_KEY)
      if (!raw) return false
      const ts = Number(raw)
      if (!Number.isFinite(ts)) return false
      return Date.now() - ts < DISMISS_TTL_MS
    } catch (_e) {
      return false
    }
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch (_e) {
      /* private browsing or quota — best-effort */
    }
    if ($el) $el.hidden = true
  }

  function ensureEl() {
    if ($el) return $el
    const el = document.createElement('div')
    el.id = 'oz-home-banner'
    el.hidden = true
    el.style.cssText = `
      position: relative;
      padding: 10px 16px;
      background: rgba(255, 191, 0, 0.14);
      border-bottom: 1px solid rgba(255, 191, 0, 0.45);
      color: #ffbf00;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 50;
    `
    el.innerHTML = `
      <span class="oz-home-banner-text" style="flex:1;"></span>
      <button class="oz-home-banner-assign" style="background:rgba(255,191,0,0.18);border:1px solid rgba(255,191,0,0.6);color:#ffbf00;padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer;"></button>
      <button class="oz-home-banner-dismiss" style="background:transparent;border:none;color:#ffbf00;opacity:0.7;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;">×</button>
    `
    // Insert directly after the .topbar so it sits between the chrome and the
    // bottom-half (sidebar + WebContentsView). Falls back to body prepend if
    // the topbar isn't there yet (defensive — webui.html always has it).
    const topbar = document.querySelector('.topbar')
    if (topbar && topbar.parentNode) {
      topbar.parentNode.insertBefore(el, topbar.nextSibling)
    } else {
      document.body.insertBefore(el, document.body.firstChild)
    }
    el.querySelector('.oz-home-banner-assign').addEventListener('click', openDashboard)
    el.querySelector('.oz-home-banner-dismiss').addEventListener('click', dismiss)
    $el = el
    return el
  }

  function openDashboard() {
    // Best-effort: open the proxy-dashboard.html as a new tab. If window.oz
    // exposes a tabs.openInId we use it; else fall back to window.open.
    if (window.oz && window.oz.tabs && typeof window.oz.tabs.openInId === 'function') {
      const url = location.protocol.startsWith('chrome-extension')
        ? location.origin + '/proxy-dashboard.html'
        : './proxy-dashboard.html'
      window.oz.tabs.openInId(null, url).catch(() => window.open(url, '_blank'))
      return
    }
    window.open('./proxy-dashboard.html', '_blank')
  }

  async function evaluate() {
    if (evaluating) return
    evaluating = true
    try {
      if (!window.oz || !window.oz.identities || !window.oz.proxies) return
      if (isDismissedRecently()) {
        if ($el) $el.hidden = true
        return
      }
      const [idents, proxies] = await Promise.all([
        window.oz.identities.list().catch(() => []),
        window.oz.proxies.list().catch(() => []),
      ])
      const enabledProxies = (proxies || []).filter(
        (p) => p && p.isActive && !p.isDisabled,
      )
      if (enabledProxies.length === 0) {
        if ($el) $el.hidden = true
        return
      }
      // Resolve each non-default identity in parallel — empty resolution
      // means the leak alert would fire. We tolerate failures (count as
      // assigned to be conservative — don't nag if the IPC layer is flaky).
      const nonDefault = (idents || []).filter((i) => !i.isDefault)
      const resolutions = await Promise.all(
        nonDefault.map((i) =>
          window.oz.proxies.resolveForIdentity
            ? window.oz.proxies.resolveForIdentity(i.id).catch(() => 'unknown')
            : Promise.resolve('unknown'),
        ),
      )
      const unassignedCount = resolutions.filter((r) => r === null).length
      if (unassignedCount === 0) {
        if ($el) $el.hidden = true
        return
      }
      const el = ensureEl()
      el.querySelector('.oz-home-banner-text').textContent = t(
        'homeBanner.proxyWarning',
        { n: unassignedCount },
        `${unassignedCount} identities without a proxy — they are browsing with your real IP.`,
      )
      el.querySelector('.oz-home-banner-assign').textContent = t(
        'homeBanner.assignNow',
        null,
        'Assign now →',
      )
      el.querySelector('.oz-home-banner-dismiss').setAttribute(
        'aria-label',
        t('homeBanner.dismiss', null, 'Dismiss'),
      )
      el.hidden = false
    } finally {
      evaluating = false
    }
  }

  function subscribe() {
    if (window.oz && window.oz.identities && window.oz.identities.onChanged) {
      window.oz.identities.onChanged(() => evaluate())
    }
    if (window.oz && window.oz.proxies && window.oz.proxies.onChanged) {
      window.oz.proxies.onChanged(() => evaluate())
    }
  }

  function start() {
    subscribe()
    evaluate()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }

  window.OZ_HomeBanner = { evaluate, dismiss }
})()
