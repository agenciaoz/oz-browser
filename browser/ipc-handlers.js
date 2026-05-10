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

const { ipcMain, dialog, BrowserWindow } = require('electron')
const log = require('./logger')
const { showErrorDialog } = require('./error-handler')
const { buildIdentityHandlers } = require('./identity-handlers')
const { buildTabHandlers } = require('./tab-handlers')
const { buildWorkspaceHandlers } = require('./workspace-handlers')
const { buildVaultHandlers, buildAccountHandlers } = require('./account-handlers')
const { buildExcelHandlers } = require('./excel-handlers')
const { buildBackupHandlers } = require('./backup-handlers')

function registerIpcHandlers(browser) {
  // Domain handlers — shared with MCP server. Build once per browser instance.
  browser.handlers = {
    identities: buildIdentityHandlers(browser),
    tabs: buildTabHandlers(browser),
    workspaces: buildWorkspaceHandlers(browser),
    vault: buildVaultHandlers(browser),
    accounts: buildAccountHandlers(browser),
    excel: buildExcelHandlers(browser),
    timemachine: buildBackupHandlers(browser),
  }

  registerLogHandlers(browser)
  registerIdentityHandlersIPC(browser)
  registerTabHandlersIPC(browser)
  registerWorkspaceHandlersIPC(browser)
  registerVaultHandlersIPC(browser)
  registerAccountHandlersIPC(browser)
  registerExcelHandlersIPC(browser)
  registerBackupHandlersIPC(browser)
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
