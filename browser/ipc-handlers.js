// OZ Browser — IPC layer.
//
// Qué hace: registra ipcMain.handle('oz:X:Y', fn) consumiendo los maps puros
// que exportan identity-handlers.js y tab-handlers.js. Los maps los consume
// también el MCP server (mcp-server.js) — misma implementación, dos transports.
//
// Doc: docs/modules/ipc-handlers.md
// ADRs: 0009 (logging), 0011 (modals hide content view), 0012 (MCP refactor)
//
// Exports: registerIpcHandlers(browser)
// IPC channels registrados: ver tabla en docs/modules/ipc-handlers.md

const { ipcMain } = require('electron')
const log = require('./logger')
const { showErrorDialog } = require('./error-handler')
const { buildIdentityHandlers } = require('./identity-handlers')
const { buildTabHandlers } = require('./tab-handlers')

function registerIpcHandlers(browser) {
  // Domain handlers — shared with MCP server. Build once per browser instance.
  browser.handlers = {
    identities: buildIdentityHandlers(browser),
    tabs: buildTabHandlers(browser),
  }

  registerLogHandlers(browser)
  registerIdentityHandlersIPC(browser)
  registerTabHandlersIPC(browser)
  registerNavHandlers(browser)
  registerUiHandlers(browser)

  log.info('ipc', 'All IPC handlers registered')
}

// ----- UI overlay control ---------------------------------------------------
// WebContentsViews are native and render ON TOP of the WebUI HTML. To show
// modals/overlays in the WebUI that need to cover the content area, we must
// temporarily hide the active tab's view. ADR 0011.

function registerUiHandlers(browser) {
  ipcMain.handle('oz:ui:setContentVisible', (event, visible) => {
    log.info('ui', 'setContentVisible IPC called', { visible })

    // Resolve the window from the SENDER webContents (which window's WebUI
    // chrome invoked us), NOT from getFocusedWindow(). With multi-window,
    // the OS focus may differ from where the modal lives.
    const senderWC = event.sender
    const win = browser.windows.find((w) => w.window && w.window.webContents === senderWC)
    if (!win) {
      log.warn('ui', 'setContentVisible: sender webContents does not match any window', {
        senderId: senderWC && senderWC.id,
      })
      return false
    }
    const tab = win.tabs && win.tabs.selected
    if (!tab) {
      log.warn('ui', 'setContentVisible: no selected tab', { windowId: win.id })
      return false
    }
    if (!tab.view) {
      log.warn('ui', 'setContentVisible: selected tab has no view (lazy?)', {
        tabId: tab.id,
        materialized: tab.materialized,
      })
      return false
    }
    tab.view.setVisible(!!visible)
    log.info('ui', 'tab.view.setVisible called', {
      visible: !!visible,
      tabId: tab.id,
      windowId: win.id,
    })
    return true
  })
}

// ----- Logging / error reporting from renderer ------------------------------

function registerLogHandlers(_browser) {
  ipcMain.handle('oz:log', (_e, level, source, message, args) => {
    const fn = log[String(level).toLowerCase()] || log.info
    fn(`renderer/${source || 'unknown'}`, message, ...(args || []))
    return true
  })

  ipcMain.handle('oz:report-error', (_e, detail) => {
    log.error('renderer', detail.message || 'Renderer error', detail)
    const title = `Renderer error: ${detail.message || 'unknown'}`
    const body =
      (detail.stack || detail.reason || detail.message || JSON.stringify(detail)) +
      (detail.filename
        ? `\n\nat ${detail.filename}:${detail.lineno}:${detail.colno}`
        : '')
    showErrorDialog(title, body)
    return true
  })
}

// ----- Identity CRUD --------------------------------------------------------
// Wires the identity handlers map (browser.handlers.identities) into ipcMain.
// Each handler keeps its same name & arg order — the IPC layer is pure adapter.

function registerIdentityHandlersIPC(browser) {
  const h = browser.handlers.identities

  ipcMain.handle('oz:identities:list', () => h.list())
  ipcMain.handle('oz:identities:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:identities:getActive', () => h.getActive())
  ipcMain.handle('oz:identities:setActive', (_e, id) => h.setActive(id))
  ipcMain.handle('oz:identities:create', (_e, opts) => h.create(opts))
  ipcMain.handle('oz:identities:rename', (_e, id, name) => h.rename(id, name))
  ipcMain.handle('oz:identities:setColor', (_e, id, color) => h.setColor(id, color))
  ipcMain.handle('oz:identities:update', (_e, id, patch) => h.update(id, patch))
  ipcMain.handle('oz:identities:remove', (_e, id) => h.remove(id))
}

// ----- Tabs ↔ Identity binding & sidebar API --------------------------------

function registerTabHandlersIPC(browser) {
  const h = browser.handlers.tabs

  ipcMain.handle('oz:tabs:list', () => h.list())
  ipcMain.handle('oz:tabs:getIdentity', (_e, tabId) => h.getIdentity(tabId))
  ipcMain.handle('oz:tabs:openInIdentity', (_e, identityId, url) =>
    h.openInIdentity(identityId, url),
  )
  ipcMain.handle('oz:tabs:select', (_e, tabId) => h.select(tabId))
  ipcMain.handle('oz:tabs:close', (_e, tabId) => h.close(tabId))
  ipcMain.handle('oz:tabs:bulkCreateLazy', (_e, count, identityId, urlTemplate) =>
    h.bulkCreateLazy(count, identityId, urlTemplate),
  )
}

// ----- Navigation controls (operate on focused tab) -------------------------
// These don't go through MCP yet — they're chrome shell controls, not data
// primitives. Tab-level navigation (oz.tabs.navigate) entra como tool MCP en
// el Bloque 1.5 cuando el Vault necesite manejar login flows.

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

  ipcMain.handle('oz:nav:loadURL', (_e, url) => {
    const t = focusedTab()
    if (!t) return false
    t.loadURL(url)
    return true
  })
}

module.exports = { registerIpcHandlers }
