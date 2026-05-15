// OZ Browser — Proxy Dashboard export-diagnostic wire (H-2 extras, v1.1.6).
//
// Tiny sibling module that wires the "Export diag" button click handler
// to window.oz.proxyHealth.exportDiagnostic(). Extracted from
// proxy-dashboard.js to keep that file under the 500 LOC budget (ADR 0005).
//
// Pattern matches proxy-dashboard-health.js / proxy-dashboard-leaks.js —
// IIFE attaches to window.OZ_DashboardExport.

;(function () {
  function wire(btn, t) {
    if (!btn) return
    btn.addEventListener('click', async () => {
      const bridge =
        window.oz && window.oz.proxyHealth && window.oz.proxyHealth.exportDiagnostic
      if (!bridge) {
        window.alert(
          t('proxyDashboard.exportDiagUnavailable', 'Export bridge unavailable.'),
        )
        return
      }
      btn.disabled = true
      try {
        const r = await bridge()
        if (r && r.ok) {
          window.alert(
            t('proxyDashboard.exportDiagOk', 'Diagnostic exported to:') + '\n' + r.path,
          )
        } else if (r && r.reason !== 'CANCELED') {
          window.alert(
            t('proxyDashboard.exportDiagFailed', 'Export failed') +
              ': ' +
              (r && (r.reason || r.message)),
          )
        }
      } finally {
        btn.disabled = false
      }
    })
  }

  window.OZ_DashboardExport = { wire }
})()
