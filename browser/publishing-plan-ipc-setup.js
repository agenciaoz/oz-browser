// OZ Browser — Publishing plan IPC (E5). Registra oz:publishing:* contra el
// handler map `h` (= browser.handlers.publishing). Verbos cortos para que el
// tool MCP equivalente quepa en ≤21 chars (guard mcp-server).
//
// ADR: 0038 · 0005 · 0012.

'use strict'

function registerPublishingPlanIpc(ipcMain, h) {
  ipcMain.handle('oz:publishing:import', (_e, payload) => h.import(payload))
  ipcMain.handle('oz:publishing:list', (_e, status) => h.list(status))
  ipcMain.handle('oz:publishing:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:publishing:status', (_e, id, action) => h.status(id, action))
  ipcMain.handle('oz:publishing:update', (_e, id, patch) => h.update(id, patch))
  ipcMain.handle('oz:publishing:remove', (_e, id) => h.remove(id))
  ipcMain.handle('oz:publishing:export', () => h.export())
}

module.exports = { registerPublishingPlanIpc }
