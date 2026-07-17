// OZ Browser — Navigation IPC handlers (extracted from ipc-handlers.js per
// ADR 0005, 500 LOC — el preconnect de alpha.108 lo empujó sobre el límite).
//
// Canales: oz:nav:back / forward / reload / preconnect / loadURL.
// Todos operan sobre la tab seleccionada de la ventana enfocada.
//
// Doc: docs/architecture/0040-direct-routing-optout-preconnect.md (preconnect)

const { ipcMain } = require('electron')

function registerNavHandlers(browser) {
  const focusedTab = () => {
    const win = browser.getFocusedWindow()
    return win && win.tabs && win.tabs.selected ? win.tabs.selected : null
  }

  ipcMain.handle('oz:nav:back', () => {
    const t = focusedTab()
    if (!t || !t.webContents) return false
    if (t.webContents.navigationHistory.canGoBack()) {
      t.webContents.navigationHistory.goBack()
      return true
    }
    return false
  })

  ipcMain.handle('oz:nav:forward', () => {
    const t = focusedTab()
    if (!t || !t.webContents) return false
    if (t.webContents.navigationHistory.canGoForward()) {
      t.webContents.navigationHistory.goForward()
      return true
    }
    return false
  })

  ipcMain.handle('oz:nav:reload', () => {
    const t = focusedTab()
    if (!t) return false
    t.reload()
    return true
  })

  // alpha.108: warm-up de conexión mientras el user escribe en el omnibox.
  // Con proxy, el CONNECT+TLS al gateway cuesta 600-900ms medidos; hacerlo
  // durante el tipeo lo saca del camino crítico del Enter. Dedupe por origin
  // para no spamear el pool de sockets con cada keystroke.
  let _lastPreconnectOrigin = null
  ipcMain.handle('oz:nav:preconnect', (_e, url) => {
    const t = focusedTab()
    if (!t || !t.webContents) return false
    const { normalizeOmniboxInput } = require('./url-normalize')
    const normalized = normalizeOmniboxInput(url)
    if (!normalized) return false
    let origin
    try {
      origin = new URL(normalized).origin
    } catch (_err) {
      return false
    }
    if (!origin || !origin.startsWith('http') || origin === _lastPreconnectOrigin) {
      return false
    }
    _lastPreconnectOrigin = origin
    try {
      t.webContents.session.preconnect({ url: origin, numSockets: 2 })
      return true
    } catch (_err) {
      return false
    }
  })

  ipcMain.handle('oz:nav:loadURL', (_e, url) => {
    const t = focusedTab()
    if (!t) return false
    // Normalize defensive: aunque tabstrip.js ya normaliza antes de invocar,
    // MCP / programmatic callers pueden pasar URL sin scheme. Sin esto,
    // webContents.loadURL('x.com') falla con ERR_INVALID_ARGUMENT silente.
    const { normalizeOmniboxInput } = require('./url-normalize')
    const normalized = normalizeOmniboxInput(url)
    if (!normalized) return false
    t.loadURL(normalized)
    return true
  })
}

module.exports = { registerNavHandlers }
