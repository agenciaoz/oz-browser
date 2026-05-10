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

const { ipcMain, dialog, BrowserWindow, Menu } = require('electron')
const log = require('./logger')
const { showErrorDialog } = require('./error-handler')
const { buildIdentityHandlers } = require('./identity-handlers')
const { buildTabHandlers } = require('./tab-handlers')
const { buildTabContextHandlers } = require('./tab-context-handlers')
const { buildTabContextMenu } = require('./tab-context-menu')
const { buildWorkspaceHandlers } = require('./workspace-handlers')
const { buildVaultHandlers, buildAccountHandlers } = require('./account-handlers')
const { buildExcelHandlers } = require('./excel-handlers')
const { buildBackupHandlers } = require('./backup-handlers')
const { buildBookmarkHandlers } = require('./bookmark-handlers')
const { buildCookieHandlers } = require('./cookies-handlers')
const { buildProxyHandlers } = require('./proxy-handlers')

function registerIpcHandlers(browser) {
  // Domain handlers — shared with MCP server. Build once per browser instance.
  // 1.7a: tab handlers split in two files — base CRUD (tab-handlers.js) +
  // context menu actions (tab-context-handlers.js). Spread into one map so
  // both consumers (IPC and MCP) see them under `tabs.<name>`.
  browser.handlers = {
    identities: buildIdentityHandlers(browser),
    tabs: { ...buildTabHandlers(browser), ...buildTabContextHandlers(browser) },
    workspaces: buildWorkspaceHandlers(browser),
    vault: buildVaultHandlers(browser),
    accounts: buildAccountHandlers(browser),
    excel: buildExcelHandlers(browser),
    timemachine: buildBackupHandlers(browser),
    bookmarks: buildBookmarkHandlers(browser),
    cookies: buildCookieHandlers(browser),
    proxies: buildProxyHandlers(browser),
  }

  registerLogHandlers(browser)
  registerIdentityHandlersIPC(browser)
  registerTabHandlersIPC(browser)
  registerWorkspaceHandlersIPC(browser)
  registerVaultHandlersIPC(browser)
  registerAccountHandlersIPC(browser)
  registerExcelHandlersIPC(browser)
  registerBackupHandlersIPC(browser)
  registerBookmarkHandlersIPC(browser)
  registerCookieHandlersIPC(browser)
  registerProxyHandlersIPC(browser)
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
  // 1.7b
  ipcMain.handle('oz:identities:clearBrowsingData', (_e, id, scope) =>
    h.clearBrowsingData(id, scope),
  )
}

// ----- Bookmarks (1.7b) -----------------------------------------------------

function registerBookmarkHandlersIPC(browser) {
  const h = browser.handlers.bookmarks

  ipcMain.handle('oz:bookmarks:list', (_e, filter) => h.list(filter))
  ipcMain.handle('oz:bookmarks:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:bookmarks:add', (_e, opts) => h.add(opts))
  ipcMain.handle('oz:bookmarks:addFromTab', (_e, tabId) => h.addFromTab(tabId))
  ipcMain.handle('oz:bookmarks:remove', (_e, id) => h.remove(id))
}

// ----- Proxies (1.8a/1.8b) --------------------------------------------------

function registerProxyHandlersIPC(browser) {
  const h = browser.handlers.proxies

  ipcMain.handle('oz:proxies:list', () => h.list())
  ipcMain.handle('oz:proxies:listAssignable', () => h.listAssignable())
  ipcMain.handle('oz:proxies:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:proxies:create', (_e, opts) => h.create(opts))
  ipcMain.handle('oz:proxies:update', (_e, id, patch) => h.update(id, patch))
  ipcMain.handle('oz:proxies:remove', (_e, id) => h.remove(id))
  ipcMain.handle('oz:proxies:setActive', (_e, id, isActive) => h.setActive(id, isActive))
  ipcMain.handle('oz:proxies:autoAssign', (_e, strategy) => h.autoAssign(strategy))
  ipcMain.handle('oz:proxies:bulkAdd', (_e, items) => h.bulkAdd(items))

  // Assignment (1.8b)
  ipcMain.handle('oz:proxies:assignToIdentity', (_e, identityId, value) =>
    h.assignToIdentity(identityId, value),
  )
  ipcMain.handle('oz:proxies:assignToWorkspace', (_e, workspaceId, value) =>
    h.assignToWorkspace(workspaceId, value),
  )
  ipcMain.handle('oz:proxies:setDefaultStrategy', (_e, strategy) =>
    h.setDefaultStrategy(strategy),
  )
  ipcMain.handle('oz:proxies:listAssignments', () => h.listAssignments())
  ipcMain.handle('oz:proxies:resolveForIdentity', (_e, identityId, workspaceId) =>
    h.resolveForIdentity(identityId, workspaceId),
  )

  // Health (1.8c)
  ipcMain.handle('oz:proxies:testConnectivity', (_e, proxyId) =>
    h.testConnectivity(proxyId),
  )
  ipcMain.handle('oz:proxies:testAll', (_e, opts) => h.testAll(opts))

  // CSV + Providers (1.8d)
  ipcMain.handle('oz:proxies:importCsvContent', (_e, content) =>
    h.importCsvContent(content),
  )
  ipcMain.handle('oz:proxies:importCsvFromFile', (_e, filePath) =>
    h.importCsvFromFile(filePath),
  )
  ipcMain.handle('oz:proxies:exportCsvContent', () => h.exportCsvContent())
  ipcMain.handle('oz:proxies:exportCsvToFile', (_e, filePath) =>
    h.exportCsvToFile(filePath),
  )
  ipcMain.handle('oz:proxies:listProviders', () => h.listProviders())
  ipcMain.handle('oz:proxies:expandProvider', (_e, providerId, opts) =>
    h.expandProvider(providerId, opts),
  )

  // Native file dialogs for CSV (UI-only — exempted in contract test).
  ipcMain.handle('oz:proxies:pickCsvImportPath', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: 'Import proxies from CSV',
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { canceled: true }
    }
    return { filePath: result.filePaths[0] }
  })

  ipcMain.handle('oz:proxies:pickCsvExportPath', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: 'Export proxies to CSV',
      defaultPath: `oz-proxies-${stamp}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    return { filePath: result.filePath }
  })
}

// ----- Cookies I/O (1.7c) ---------------------------------------------------

function registerCookieHandlersIPC(browser) {
  const h = browser.handlers.cookies
  const FORMAT_LABELS = {
    oz: 'OZ Browser JSON',
    netscape: 'Netscape cookies.txt',
    adspower: 'AdsPower JSON',
    multilogin: 'Multilogin JSON',
  }
  const FORMAT_EXT = {
    oz: 'json',
    netscape: 'txt',
    adspower: 'json',
    multilogin: 'json',
  }

  ipcMain.handle('oz:cookies:exportContent', (_e, identityId, format) =>
    h.exportContent(identityId, format),
  )
  ipcMain.handle('oz:cookies:exportToFile', (_e, identityId, format, filePath) =>
    h.exportToFile(identityId, format, filePath),
  )
  ipcMain.handle('oz:cookies:importContent', (_e, identityId, format, content) =>
    h.importContent(identityId, format, content),
  )
  ipcMain.handle('oz:cookies:importFromFile', (_e, identityId, format, filePath) =>
    h.importFromFile(identityId, format, filePath),
  )

  // Native file dialogs (renderer cannot reach dialog API directly).
  ipcMain.handle('oz:cookies:pickExportPath', async (event, identityId, format) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const stamp = new Date().toISOString().slice(0, 10)
    const ident = browser.identityManager && browser.identityManager.get(identityId)
    const safeName = ((ident && ident.name) || identityId)
      .replace(/[^a-z0-9-_]+/gi, '-')
      .toLowerCase()
    const ext = FORMAT_EXT[format] || 'json'
    const result = await dialog.showSaveDialog(win, {
      title: `Export cookies (${FORMAT_LABELS[format] || format})`,
      defaultPath: `oz-cookies-${safeName}-${format}-${stamp}.${ext}`,
      filters: [{ name: FORMAT_LABELS[format] || format, extensions: [ext] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    return { filePath: result.filePath }
  })

  ipcMain.handle('oz:cookies:pickImportPath', async (event, format) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const ext = FORMAT_EXT[format] || 'json'
    const result = await dialog.showOpenDialog(win, {
      title: `Import cookies (${FORMAT_LABELS[format] || format})`,
      filters: [
        { name: FORMAT_LABELS[format] || format, extensions: [ext] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { canceled: true }
    }
    return { filePath: result.filePaths[0] }
  })
}

// ----- Workspaces -----------------------------------------------------------
// Wires the workspace handlers map (browser.handlers.workspaces) into ipcMain.
// Same map is consumed by the MCP server in 1.4e to expose oz.workspaces.* tools.

function registerWorkspaceHandlersIPC(browser) {
  const h = browser.handlers.workspaces

  ipcMain.handle('oz:workspaces:list', () => h.list())
  ipcMain.handle('oz:workspaces:listActive', () => h.listActive())
  ipcMain.handle('oz:workspaces:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:workspaces:getActive', (_e, windowId) => h.getActive(windowId))
  ipcMain.handle('oz:workspaces:setActive', (_e, workspaceId, windowId) =>
    h.setActive(workspaceId, windowId),
  )
  ipcMain.handle('oz:workspaces:create', (_e, opts) => h.create(opts))
  ipcMain.handle('oz:workspaces:update', (_e, id, patch) => h.update(id, patch))
  ipcMain.handle('oz:workspaces:rename', (_e, id, name) => h.rename(id, name))
  ipcMain.handle('oz:workspaces:setColor', (_e, id, color) => h.setColor(id, color))
  ipcMain.handle('oz:workspaces:duplicate', (_e, id) => h.duplicate(id))
  ipcMain.handle('oz:workspaces:archive', (_e, id) => h.archive(id))
  ipcMain.handle('oz:workspaces:restore', (_e, id) => h.restore(id))
  ipcMain.handle('oz:workspaces:freeze', (_e, id) => h.freeze(id))
  ipcMain.handle('oz:workspaces:unfreeze', (_e, id) => h.unfreeze(id))
  ipcMain.handle('oz:workspaces:remove', (_e, id) => h.remove(id))
}

// ----- Vault (1.5b) ---------------------------------------------------------
// Master key access + lock/unlock control. Account CRUD lives in
// registerAccountHandlersIPC below.

function registerVaultHandlersIPC(browser) {
  const h = browser.handlers.vault

  ipcMain.handle('oz:vault:status', () => h.status())
  ipcMain.handle('oz:vault:unlock', () => h.unlock())
  ipcMain.handle('oz:vault:lock', () => h.lock())
  ipcMain.handle('oz:vault:destroy', () => h.destroy())
}

// ----- Accounts (1.5b) ------------------------------------------------------
// CRUD over the encrypted vault. All handlers return { __error: { code: 'LOCKED' } }
// if the vault is not unlocked — caller must unlock first via oz:vault:unlock.

function registerAccountHandlersIPC(browser) {
  const h = browser.handlers.accounts

  ipcMain.handle('oz:accounts:list', (_e, filter) => h.list(filter))
  ipcMain.handle('oz:accounts:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:accounts:create', (_e, opts) => h.create(opts))
  ipcMain.handle('oz:accounts:update', (_e, id, patch) => h.update(id, patch))
  ipcMain.handle('oz:accounts:remove', (_e, id) => h.remove(id))
  ipcMain.handle('oz:accounts:setAll', (_e, accounts) => h.setAll(accounts))
  // 1.5c: auto-fill / auto-save primitives. The identityId is resolved from
  // event.sender.session (NOT trusted from renderer args) — this prevents a
  // compromised renderer from asking for credentials of another identity.
  ipcMain.handle('oz:accounts:getCredentialsForSite', (event, site, identityIdArg) => {
    const identityId =
      browser.identityManager.identityIdForSession(event.sender.session) || identityIdArg // fall back to arg for WebUI/MCP callers (no isolated session)
    return h.getCredentialsForSite(site, identityId)
  })
  ipcMain.handle('oz:accounts:proposeAutoSave', async (event, opts = {}) => {
    const identityId =
      browser.identityManager.identityIdForSession(event.sender.session) ||
      opts.identityId
    const merged = { ...opts, identityId }
    const proposal = h.proposeAutoSave(merged)
    if (!proposal || proposal.__error) return proposal
    // 1.5f: native confirmation dialog. Replicates 1Password/Bitwarden UX —
    // bloquea hasta que el user decide save/update/discard.
    const action = proposal.action // 'create' | 'update'
    const verb = action === 'update' ? 'Update' : 'Save'
    const win = BrowserWindow.fromWebContents(event.sender) || browser.getFocusedWindow()
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [`${verb} password`, 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'OZ Browser — Save credentials?',
      message: `${verb} the password for "${merged.username}" on ${merged.site}?`,
      detail:
        action === 'update'
          ? 'This will overwrite the existing entry in your vault.'
          : 'A new account will be added to your encrypted vault.',
    })
    if (r.response !== 0) {
      return { ...proposal, userChoice: 'declined' }
    }
    // User confirmed — persist via accounts handler.
    const acctH = browser.handlers.accounts
    if (action === 'update' && proposal.existingAccountId) {
      const upd = await acctH.update(proposal.existingAccountId, {
        password: merged.password,
        lastLoginAt: Date.now(),
        status: 'active',
      })
      return { ...proposal, userChoice: 'updated', accountId: upd && upd.id }
    } else {
      const created = await acctH.create({
        identityId,
        site: merged.site,
        username: merged.username,
        password: merged.password,
        workspaceId: merged.workspaceId || null,
        status: 'active',
        lastLoginAt: Date.now(),
      })
      return {
        ...proposal,
        userChoice: 'created',
        accountId: created && created.id,
      }
    }
  })
}

// ----- Excel I/O (1.5e) -----------------------------------------------------

function registerExcelHandlersIPC(browser) {
  const h = browser.handlers.excel

  ipcMain.handle('oz:excel:exportToFile', (_e, filePath) => h.exportToFile(filePath))
  ipcMain.handle('oz:excel:importFromFile', (_e, filePath, mode) =>
    h.importFromFile(filePath, mode),
  )

  // 1.5f: native file dialog wrappers — renderer cannot use the dialog API
  // directly (security). Returns { filePath } or { canceled: true }.
  ipcMain.handle('oz:excel:pickExportPath', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: 'Export accounts to Excel',
      defaultPath: `oz-accounts-${stamp}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    return { filePath: result.filePath }
  })

  ipcMain.handle('oz:excel:pickImportPath', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: 'Import accounts from Excel',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { canceled: true }
    }
    return { filePath: result.filePaths[0] }
  })
}

// ----- Time Machine (1.6b) --------------------------------------------------

function registerBackupHandlersIPC(browser) {
  const h = browser.handlers.timemachine
  ipcMain.handle('oz:timemachine:create', (_e, opts) => h.create(opts))
  ipcMain.handle('oz:timemachine:list', () => h.list())
  ipcMain.handle('oz:timemachine:restore', (_e, id) => h.restore(id))
  ipcMain.handle('oz:timemachine:remove', (_e, id) => h.remove(id))
  ipcMain.handle('oz:timemachine:applyRetention', (_e, opts) => h.applyRetention(opts))
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
  ipcMain.handle('oz:tabs:moveToWorkspace', (_e, tabId, targetWorkspaceId) =>
    h.moveToWorkspace(tabId, targetWorkspaceId),
  )

  // 1.7a: tab context menu actions ----------------------------------------
  ipcMain.handle('oz:tabs:reload', (_e, tabId) => h.reload(tabId))
  ipcMain.handle('oz:tabs:duplicate', (_e, tabId) => h.duplicate(tabId))
  ipcMain.handle('oz:tabs:duplicateInTemporary', (_e, tabId) =>
    h.duplicateInTemporary(tabId),
  )
  ipcMain.handle('oz:tabs:duplicateInIdentity', (_e, tabId, identityId) =>
    h.duplicateInIdentity(tabId, identityId),
  )
  ipcMain.handle('oz:tabs:duplicateInNewIdentity', (_e, tabId, name) =>
    h.duplicateInNewIdentity(tabId, name),
  )
  ipcMain.handle('oz:tabs:refreshAllInIdentity', (_e, identityId) =>
    h.refreshAllInIdentity(identityId),
  )
  ipcMain.handle('oz:tabs:moveToNewWindow', (_e, tabId) => h.moveToNewWindow(tabId))
  ipcMain.handle('oz:tabs:pin', (_e, tabId) => h.pin(tabId))
  ipcMain.handle('oz:tabs:unpin', (_e, tabId) => h.unpin(tabId))
  ipcMain.handle('oz:tabs:mute', (_e, tabId) => h.mute(tabId))
  ipcMain.handle('oz:tabs:unmute', (_e, tabId) => h.unmute(tabId))
  ipcMain.handle('oz:tabs:closeOthers', (_e, tabId) => h.closeOthers(tabId))
  ipcMain.handle('oz:tabs:closeToRight', (_e, tabId) => h.closeToRight(tabId))

  // 1.7a: context-menu opener — main builds the native template and pops it
  // up at the cursor location for the requesting window. Renderer just sends
  // the tabId; the menu's click handlers run in main, no IPC round-trip per
  // item. x/y are optional (Electron defaults to current cursor position).
  ipcMain.handle('oz:tabs:contextMenu', (event, tabId, opts = {}) => {
    const template = buildTabContextMenu({ browser, tabId })
    if (!template || template.length === 0) return false
    const menu = Menu.buildFromTemplate(template)
    const win = BrowserWindow.fromWebContents(event.sender) || browser.getFocusedWindow()
    if (!win) return false
    const popupOpts = {}
    if (typeof opts.x === 'number' && typeof opts.y === 'number') {
      popupOpts.x = Math.round(opts.x)
      popupOpts.y = Math.round(opts.y)
    }
    menu.popup({ window: win.window || win, ...popupOpts })
    log.info('ipc', 'tab context menu popup', {
      tabId,
      windowId: (win.window || win).id,
      x: popupOpts.x,
      y: popupOpts.y,
    })
    return true
  })
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
