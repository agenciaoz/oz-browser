// OZ Browser — IPC handlers extra (1.10): proxies + fingerprint + settings +
// browsing-data. Extracted from ipc-handlers.js to keep both files under
// 500 LOC (ADR 0005).
//
// Doc: docs/modules/ipc-handlers-extra.md
// ADR: docs/architecture/0005-modular-500-loc-rule.md

const { ipcMain, dialog, BrowserWindow } = require('electron')

function registerExtraIpcHandlers(browser) {
  registerProxyHandlersIPC(browser)
  registerFingerprintHandlersIPC(browser)
  registerSettingsHandlersIPC(browser)
  registerBrowsingDataHandlersIPC(browser)
  registerCommandPaletteHandlersIPC(browser)
  registerBulkOpenerHandlersIPC(browser)
}

// ----- Proxies (1.8a/1.8b/1.8c/1.8d) ---------------------------------------

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

// ----- Fingerprint (1.9) ----------------------------------------------------

function registerFingerprintHandlersIPC(browser) {
  const h = browser.handlers.fingerprint
  ipcMain.handle('oz:fingerprint:get', (_e, identityId) => h.get(identityId))
  ipcMain.handle('oz:fingerprint:regenerate', (_e, identityId, newSeed) =>
    h.regenerate(identityId, newSeed),
  )
  ipcMain.handle('oz:fingerprint:applyGeoSuggestion', (_e, identityId, suggestion) =>
    h.applyGeoSuggestion(identityId, suggestion),
  )
  ipcMain.handle('oz:fingerprint:resolveCountry', (_e, countryCode) =>
    h.resolveCountry(countryCode),
  )
  ipcMain.handle('oz:fingerprint:remove', (_e, identityId) => h.remove(identityId))
}

// ----- Settings (1.10a) -----------------------------------------------------

function registerSettingsHandlersIPC(browser) {
  const h = browser.handlers.settings
  ipcMain.handle('oz:settings:getAll', () => h.getAll())
  ipcMain.handle('oz:settings:get', (_e, section) => h.get(section))
  ipcMain.handle('oz:settings:set', (_e, section, patch) => h.set(section, patch))
  ipcMain.handle('oz:settings:resetSection', (_e, section) => h.resetSection(section))
  ipcMain.handle('oz:settings:resetAll', () => h.resetAll())
}

// ----- Downloads + History (1.10b) ------------------------------------------

function registerBrowsingDataHandlersIPC(browser) {
  const dl = browser.handlers.downloads
  ipcMain.handle('oz:downloads:list', (_e, filter) => dl.list(filter))
  ipcMain.handle('oz:downloads:get', (_e, id) => dl.get(id))
  ipcMain.handle('oz:downloads:remove', (_e, id) => dl.remove(id))
  ipcMain.handle('oz:downloads:clear', (_e, filter) => dl.clear(filter))

  const hist = browser.handlers.history
  ipcMain.handle('oz:history:list', (_e, filter) => hist.list(filter))
  ipcMain.handle('oz:history:remove', (_e, id) => hist.remove(id))
  ipcMain.handle('oz:history:clear', (_e, filter) => hist.clear(filter))
  ipcMain.handle('oz:history:addVisit', (_e, opts) => hist.addVisit(opts))
}

// ----- Command Palette (C-1) ------------------------------------------------

function registerCommandPaletteHandlersIPC(browser) {
  const h = browser.handlers.commands
  ipcMain.handle('oz:commands:list', (event, opts) => {
    // Resolve focused window id from the renderer's webContents so a window
    // that lost focus mid-IPC still gets its own list (not another window's).
    const win = BrowserWindow.fromWebContents(event.sender)
    const focusedWindowId = win ? win.id : opts && opts.focusedWindowId
    return h.list({ focusedWindowId })
  })
}

// ----- Bulk Opener (C-4) ----------------------------------------------------

function registerBulkOpenerHandlersIPC(browser) {
  const h = browser.handlers.bulkOpen
  ipcMain.handle('oz:bulkOpen:fromExisting', (_e, input) => h.fromExisting(input))
  ipcMain.handle('oz:bulkOpen:createNew', (_e, input) => h.createNew(input))
  ipcMain.handle('oz:bulkOpen:previewNames', (_e, input) => h.previewNames(input))
  ipcMain.handle('oz:bulkOpen:previewUrls', (_e, input) => h.previewUrls(input))
  ipcMain.handle('oz:bulkOpen:validate', (_e, input) => h.validate(input))
}

module.exports = { registerExtraIpcHandlers }
