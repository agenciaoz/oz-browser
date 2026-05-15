// OZ Browser — Proxy Diagnostics setup glue (H-2e, v1.1.3).
//
// Extracted from main.js (ADR 0005, 500 LOC budget). Wirea el scan periódico
// del diagnostics engine. El engine en sí lo crea lazy `ipc-handlers-extra.js`
// la primera vez que el dashboard lo invoca; este módulo sólo se encarga de
// llamarle `scan()` cada 5 min mientras el proceso está vivo, para que las
// alertas firean (y emitan OS notifications) incluso si el dashboard nunca
// se abre.
//
// Uso desde main.js:
//   const { startProxyDiagnosticsScan, stopProxyDiagnosticsScan } =
//     require('./proxy-diagnostics-setup')
//   // post-proxyHealth.startDaemon:
//   this._proxyDiagnosticsTimer = startProxyDiagnosticsScan(this)
//   // en before-quit:
//   stopProxyDiagnosticsScan(this._proxyDiagnosticsTimer)
//
// Intervalo: 5 min. Si el engine aún no fue construido (dashboard nunca abierto
// + nadie llamó IPC), el callback es no-op silencioso.

const log = require('./logger')

const SCAN_INTERVAL_MS = 5 * 60 * 1000

function startProxyDiagnosticsScan(browser) {
  return setInterval(() => {
    try {
      if (browser && browser._proxyDiagnostics) browser._proxyDiagnostics.scan()
    } catch (err) {
      log.warn('proxy-diagnostics-setup', 'scan failed', { message: err.message })
    }
  }, SCAN_INTERVAL_MS)
}

function stopProxyDiagnosticsScan(timer) {
  if (timer) clearInterval(timer)
}

module.exports = {
  startProxyDiagnosticsScan,
  stopProxyDiagnosticsScan,
  SCAN_INTERVAL_MS,
}
