// OZ Browser — Publishing Studio IPC (v2 Etapa 1).
//
// Extracted from ipc-handlers-extra.js to keep that file under the 500-LOC
// budget (ADR 0005). Registers oz:publishing:openTab, which opens the
// Publishing Studio as a dedicated tab of the focused window — same routing
// pattern as oz:proxyHealth:openDashboard.
//
// Doc: docs/architecture/0038-publishing-studio.md

const { ipcMain } = require('electron')

function registerPublishingIpc(browser) {
  ipcMain.handle('oz:publishing:openTab', (event) => {
    try {
      const senderWc = event && event.sender
      let target = null
      for (const w of browser.windows || []) {
        if (
          w.window &&
          !w.window.isDestroyed() &&
          (w.window.webContents === senderWc ||
            (w.tabs &&
              w.tabs.tabList &&
              w.tabs.tabList.some((t) => t.webContents === senderWc)))
        ) {
          target = w
          break
        }
      }
      if (!target) {
        target = (browser.windows || []).find((w) => w.window && !w.window.isDestroyed())
      }
      if (!target || !target.tabs) return { ok: false, reason: 'NO_WINDOW' }
      const url = `chrome-extension://${browser.webuiExtensionId}/publishing-studio.html`
      const tab = target.tabs.create({
        url,
        source: 'publishingStudio',
        materialize: true,
      })
      if (typeof target.tabs.select === 'function') target.tabs.select(tab.id)
      return { ok: true, tabId: tab.id }
    } catch (err) {
      return { ok: false, reason: 'OPEN_FAILED', message: err.message }
    }
  })
}

module.exports = { registerPublishingIpc }
