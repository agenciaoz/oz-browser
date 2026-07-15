// OZ Browser — Publishing plan IPC (E5). Registra oz:publishing:* contra el
// handler map `h` (= browser.handlers.publishing). Verbos cortos para que el
// tool MCP equivalente quepa en ≤21 chars (guard mcp-server).
//
// ADR: 0038 · 0005 · 0012.

'use strict'

function registerPublishingPlanIpc(ipcMain, h) {
  ipcMain.handle('oz:publishing:import', (_e, payload) => h.import(payload))
  // E5/alpha.104: pick an .xlsx and import it in one call (opens dialog if no
  // path). Returns {added, errors} | {canceled:true} | {__error}.
  ipcMain.handle('oz:publishing:importFile', async (event, filePath) => {
    if (!filePath) {
      const { dialog, BrowserWindow } = require('electron')
      const win = BrowserWindow.fromWebContents(event.sender)
      const res = await dialog.showOpenDialog(win, {
        title: 'Import content plan from Excel',
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        properties: ['openFile'],
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true }
      filePath = res.filePaths[0]
    }
    return h.importFile(filePath)
  })
  ipcMain.handle('oz:publishing:list', (_e, status) => h.list(status))
  ipcMain.handle('oz:publishing:get', (_e, id) => h.get(id))
  ipcMain.handle('oz:publishing:status', (_e, id, action) => h.status(id, action))
  ipcMain.handle('oz:publishing:update', (_e, id, patch) => h.update(id, patch))
  ipcMain.handle('oz:publishing:remove', (_e, id) => h.remove(id))
  ipcMain.handle('oz:publishing:publish', (_e, id) => h.publish(id))
  ipcMain.handle('oz:publishing:sched', (_e, id, schedule) => h.schedule(id, schedule))
  ipcMain.handle('oz:publishing:unsched', (_e, id) => h.unschedule(id))
  ipcMain.handle('oz:publishing:export', () => h.export())
  // Dry-run / pre-flight (validate without publishing).
  ipcMain.handle('oz:publishing:dryRun', (_e, id) => h.dryRun(id))
  // History: filtered + hydrated publish runs, and retry of failed items.
  ipcMain.handle('oz:publishing:runs', (_e, limit) => h.runs(limit))
  ipcMain.handle('oz:publishing:retry', (_e, runId) => h.retryRun(runId))
  // Analytics (success by network/identity/hour over the bulk-run history).
  ipcMain.handle('oz:publishing:stats', (_e, opts) => h.analytics(opts))
  // Composer migrated to main: list actions, compose (dry), compose+publish.
  ipcMain.handle('oz:publishing:actions', () => h.actions())
  ipcMain.handle('oz:publishing:compose', (_e, input) => h.compose(input))
  ipcMain.handle('oz:publishing:send', (_e, input) => h.composePublish(input))
  ipcMain.handle('oz:publishing:schedCompose', (_e, input) => h.scheduleCompose(input))
  // Content variation (anti-footprint) — same engine the UI preview uses.
  ipcMain.handle('oz:publishing:preview', (_e, spec, identities) =>
    h.preview(spec, identities),
  )
  ipcMain.handle('oz:publishing:resolve', (_e, spec, opts) => h.resolve(spec, opts))
  ipcMain.handle('oz:publishing:variety', (_e, text) => h.variety(text))
  // Library (templates/hashtags/media).
  ipcMain.handle('oz:publishing:libList', (_e, kind) => h.libList(kind))
  ipcMain.handle('oz:publishing:libSave', (_e, kind, item) => h.libSave(kind, item))
  ipcMain.handle('oz:publishing:libDel', (_e, kind, id) => h.libDel(kind, id))
}

module.exports = { registerPublishingPlanIpc }
