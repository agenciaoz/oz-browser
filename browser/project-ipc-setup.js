// OZ Browser — Project IPC registration (F2). Registra oz:projects:* contra el
// handler map `h` (= browser.handlers.projects). Extraído por el budget de LOC.
//
// ADR: 0005 (modular) · 0012 (oz-mcp-server).

'use strict'

function registerProjectsIpc(ipcMain, h) {
  ipcMain.handle('oz:projects:list', () => h.list())
  ipcMain.handle('oz:projects:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:projects:save', (_e, name, type) => h.save({ name, type }))
  ipcMain.handle('oz:projects:open', (_e, id) => h.open(id))
  ipcMain.handle('oz:projects:rename', (_e, id, name) => h.rename(id, name))
  ipcMain.handle('oz:projects:remove', (_e, id) => h.remove(id))
}

module.exports = { registerProjectsIpc }
