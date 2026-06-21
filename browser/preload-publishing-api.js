// OZ Browser — preload bridge for the Publishing Studio (v2 Etapa 1).
//
// Extracted from preload.js to keep that file under the 500-LOC budget
// (ADR 0005). Same pattern as preload-bulk-api.js / preload-proxy.js.
//
// openTab() opens the dedicated studio tab; onOpen() fires when the menu /
// palette asks the focused window to open it.

'use strict'

function buildPublishingApi(ipcRenderer) {
  return {
    openTab: () => ipcRenderer.invoke('oz:publishing:openTab'),
    onOpen(cb) {
      const listener = () => cb()
      ipcRenderer.on('oz:publishing:open', listener)
      return () => ipcRenderer.off('oz:publishing:open', listener)
    },
    // E5: content plan (main-process store, MCP-first; UI reads via these).
    importPlan: (payload) => ipcRenderer.invoke('oz:publishing:import', payload),
    listPlan: (status) => ipcRenderer.invoke('oz:publishing:list', status),
    getPlan: (id) => ipcRenderer.invoke('oz:publishing:get', id),
    setPlanStatus: (id, action) => ipcRenderer.invoke('oz:publishing:status', id, action),
    updatePlan: (id, patch) => ipcRenderer.invoke('oz:publishing:update', id, patch),
    removePlan: (id) => ipcRenderer.invoke('oz:publishing:remove', id),
    publishPlan: (id) => ipcRenderer.invoke('oz:publishing:publish', id),
    exportPlan: () => ipcRenderer.invoke('oz:publishing:export'),
    libList: (kind) => ipcRenderer.invoke('oz:publishing:libList', kind),
    libSave: (kind, item) => ipcRenderer.invoke('oz:publishing:libSave', kind, item),
    libDel: (kind, id) => ipcRenderer.invoke('oz:publishing:libDel', kind, id),
  }
}

module.exports = { buildPublishingApi }
