// OZ Browser — preload bridge para Proyectos (F2). Extraído de preload.js para
// mantenerlo bajo el límite de 500 LOC (ADR 0005). Mismo patrón que
// preload-bulk-api.js.

'use strict'

function buildProjectsApi(ipcRenderer) {
  return {
    list: () => ipcRenderer.invoke('oz:projects:list'),
    get: (id) => ipcRenderer.invoke('oz:projects:get', id),
    save: (name, type) => ipcRenderer.invoke('oz:projects:save', name, type),
    open: (id) => ipcRenderer.invoke('oz:projects:open', id),
    rename: (id, name) => ipcRenderer.invoke('oz:projects:rename', id, name),
    remove: (id) => ipcRenderer.invoke('oz:projects:remove', id),
  }
}

module.exports = { buildProjectsApi }
