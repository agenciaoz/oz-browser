// OZ Browser — Extra proxy-provider button wireups for the dashboard
// (v2.0.0-alpha.22).
//
// proxy-dashboard.js sits at exactly 500 LOC (ADR 0005 budget). Rather than
// inflate it to wire the "+ Bright Data" button, we attach the listener here.
// Mirrors the "+ Oxylabs" wireup that already lives in proxy-dashboard.js —
// same shape, same deps, same refresh strategy.
//
// Loaded AFTER both `brightdata-builder.js` and `proxy-dashboard.js` from
// proxy-dashboard.html so window.OZ_BrightDataBuilder + the button DOM are
// guaranteed present.

;(function () {
  function t(key, fallback) {
    if (window.OZ && window.OZ.i18n && typeof window.OZ.i18n.t === 'function') {
      return window.OZ.i18n.t(key, fallback)
    }
    return fallback || key
  }

  function start() {
    const btn = document.getElementById('btn-brightdata')
    if (!btn || !window.OZ_BrightDataBuilder) return
    btn.addEventListener('click', () =>
      window.OZ_BrightDataBuilder.open({
        t,
        refreshDashboard: async () => {
          // The dashboard subscribes to oz:proxies:changed broadcasts itself
          // (handled inside expandProvider on the main side). The post-insert
          // alert() in the modal blocks until user acks; by the time refresh
          // is called the broadcast has already kicked the dashboard.
          if (
            window.oz &&
            window.oz.proxyHealth &&
            typeof window.oz.proxyHealth.getDashboard === 'function'
          ) {
            try {
              await window.oz.proxyHealth.getDashboard()
            } catch (_e) {
              // best-effort
            }
          }
        },
      }),
    )
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
