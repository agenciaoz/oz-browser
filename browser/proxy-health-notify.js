// OZ Browser — proxy-health notify factory (E2-C-5).
//
// Extracted from main.js to keep it under 500 LOC (ADR 0005). Wraps the
// notify callback passed to ProxyHealth so that:
//   - Every notify() invocation registers an in-app alert (panel-always).
//   - OS notification is shown only when settings.notifications.showOSAlert
//     is true (default true).
//
// Doc: docs/modules/proxy-health-notify.md

const { Notification } = require('electron')
const log = require('./logger')

function buildProxyHealthNotify(browser) {
  return (title, body) => {
    if (browser.alertManager) {
      try {
        browser.alertManager.add({
          type: 'proxy-disabled',
          severity: 'urgent',
          title,
          message: body,
          action: { kind: 'open-modal', payload: { modal: 'proxyManager' } },
        })
      } catch (_e) {
        // best-effort
      }
    }
    const showOS =
      !browser.settingsManager ||
      (browser.settingsManager.get('notifications') || {}).showOSAlert !== false
    if (!showOS) return
    try {
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        new Notification({ title, body }).show()
      }
    } catch (err) {
      log.warn('proxy-health-notify', 'OS notification failed', {
        message: err.message,
      })
    }
  }
}

module.exports = { buildProxyHealthNotify }
