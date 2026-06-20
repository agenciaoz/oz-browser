// OZ Browser — Tab IPC registration (extraído de ipc-handlers.js por el budget
// de LOC, ADR 0005). Registra los canales `oz:tabs:*` simples (1 línea c/u)
// contra el mapa de handlers `h` (= browser.handlers.tabs). El contextMenu y
// otros canales con dependencias pesadas (Menu/BrowserWindow) quedan en
// ipc-handlers.js.
//
// ADR: 0012 (oz-mcp-server) · 0005 (modular).

'use strict'

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {Record<string, Function>} h  browser.handlers.tabs
 */
function registerTabsIpc(ipcMain, h) {
  ipcMain.handle('oz:tabs:list', () => h.list())
  ipcMain.handle('oz:tabs:getIdentity', (_e, tabId) => h.getIdentity(tabId))
  ipcMain.handle('oz:tabs:openInIdentity', (_e, identityId, url) =>
    h.openInIdentity(identityId, url),
  )
  ipcMain.handle('oz:tabs:select', (_e, tabId) => h.select(tabId))
  // Drag-and-drop reorder (alpha.65).
  ipcMain.handle('oz:tabs:reorder', (_e, tabId, toIndex) => h.reorder(tabId, toIndex))
  ipcMain.handle('oz:tabs:close', (_e, tabId) => h.close(tabId))
  // H1 — Cmd+Shift+T equivalent.
  ipcMain.handle('oz:tabs:reopenClosed', () => h.reopenClosed())
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
  ipcMain.handle('oz:tabs:lock', (_e, tabId) => h.lock(tabId))
  ipcMain.handle('oz:tabs:unlock', (_e, tabId) => h.unlock(tabId))
  ipcMain.handle('oz:tabs:mute', (_e, tabId) => h.mute(tabId))
  ipcMain.handle('oz:tabs:unmute', (_e, tabId) => h.unmute(tabId))
  ipcMain.handle('oz:tabs:closeOthers', (_e, tabId) => h.closeOthers(tabId))
  ipcMain.handle('oz:tabs:closeToRight', (_e, tabId) => h.closeToRight(tabId))
}

module.exports = { registerTabsIpc }
