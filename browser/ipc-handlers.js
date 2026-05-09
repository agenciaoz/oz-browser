// OZ Browser — All ipcMain.handle registrations live here, organized by domain.
// Receives the Browser instance to access state (identityManager, windows, etc.).

const { ipcMain } = require('electron')
const log = require('./logger')
const { showErrorDialog } = require('./error-handler')

function registerIpcHandlers(browser) {
  registerLogHandlers(browser)
  registerIdentityHandlers(browser)
  registerTabHandlers(browser)
  registerNavHandlers(browser)
  log.info('ipc', 'All IPC handlers registered')
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
      (detail.filename ? `\n\nat ${detail.filename}:${detail.lineno}:${detail.colno}` : '')
    showErrorDialog(title, body)
    return true
  })
}

// ----- Identity CRUD --------------------------------------------------------

function registerIdentityHandlers(browser) {
  const im = () => browser.identityManager

  ipcMain.handle('oz:identities:list', () => im().list())
  ipcMain.handle('oz:identities:get', (_e, id) => im().get(id))
  ipcMain.handle('oz:identities:getActive', () => browser.activeIdentityId)

  ipcMain.handle('oz:identities:setActive', (_e, id) => {
    const ident = im().get(id)
    if (!ident) return false
    browser.activeIdentityId = id
    browser.broadcastToWebUI('oz:identities:active-changed', id)
    return true
  })

  ipcMain.handle('oz:identities:create', (_e, opts) => {
    const ident = im().create(opts || {})
    browser.broadcastToWebUI('oz:identities:changed')
    return ident
  })

  ipcMain.handle('oz:identities:rename', (_e, id, name) => {
    const ident = im().rename(id, name)
    if (ident) browser.broadcastToWebUI('oz:identities:changed')
    return ident
  })

  ipcMain.handle('oz:identities:setColor', (_e, id, color) => {
    const ident = im().setColor(id, color)
    if (ident) browser.broadcastToWebUI('oz:identities:changed')
    return ident
  })

  ipcMain.handle('oz:identities:remove', (_e, id) => {
    if (browser.activeIdentityId === id) {
      browser.activeIdentityId = im().getDefault().id
      browser.broadcastToWebUI('oz:identities:active-changed', browser.activeIdentityId)
    }
    const ok = im().remove(id)
    if (ok) browser.broadcastToWebUI('oz:identities:changed')
    return ok
  })
}

// ----- Tabs ↔ Identity binding & sidebar API --------------------------------

function registerTabHandlers(browser) {
  ipcMain.handle('oz:tabs:list', () => {
    const result = []
    for (const win of browser.windows) {
      for (const t of win.tabs.tabList) {
        result.push({ ...t.serialize(), windowId: win.id })
      }
    }
    return result
  })

  ipcMain.handle('oz:tabs:getIdentity', (_e, tabId) => {
    for (const win of browser.windows) {
      const tab = win.tabs.get(tabId)
      if (tab) return tab.identityId
    }
    return null
  })

  ipcMain.handle('oz:tabs:openInIdentity', (_e, identityId, url) => {
    const win = browser.getFocusedWindow()
    if (!win) return null
    const tab = win.tabs.create({ identityId, url })
    browser.broadcastToWebUI('oz:tabs:updated', {
      kind: 'created',
      tab: { ...tab.serialize(), windowId: win.id },
    })
    return tab.id
  })

  ipcMain.handle('oz:tabs:select', (_e, tabId) => {
    for (const win of browser.windows) {
      if (win.tabs.get(tabId)) {
        win.tabs.select(tabId)
        return true
      }
    }
    return false
  })

  ipcMain.handle('oz:tabs:close', (_e, tabId) => {
    for (const win of browser.windows) {
      if (win.tabs.get(tabId)) {
        win.tabs.remove(tabId)
        browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId })
        return true
      }
    }
    return false
  })

  ipcMain.handle('oz:tabs:bulkCreateLazy', (_e, count, identityId, urlTemplate) => {
    const win = browser.getFocusedWindow()
    if (!win) return 0
    for (let i = 0; i < count; i++) {
      const url = urlTemplate ? urlTemplate.replace('{i}', String(i)) : 'about:blank'
      win.tabs.create({ identityId, url })
    }
    browser.broadcastToWebUI('oz:tabs:updated', { kind: 'bulk-created', count })
    return count
  })
}

// ----- Navigation controls (operate on focused tab) -------------------------

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
