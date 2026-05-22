// OZ Browser — preload bridge para el Bulk Runner (v2 sub-bloque 1).
//
// Extraído de preload.js para mantener ese archivo bajo el límite de
// 500 LOC (ADR 0005). Mismo pattern que preload-autoupdater-api.js.

'use strict'

function buildBulkApi(ipcRenderer) {
  return {
    listActions: () => ipcRenderer.invoke('oz:bulk:listActions'),
    create: (spec) => ipcRenderer.invoke('oz:bulk:create', spec),
    start: (runId) => ipcRenderer.invoke('oz:bulk:start', runId),
    run: (spec) => ipcRenderer.invoke('oz:bulk:run', spec),
    cancel: (runId) => ipcRenderer.invoke('oz:bulk:cancel', runId),
    get: (runId) => ipcRenderer.invoke('oz:bulk:get', runId),
    list: () => ipcRenderer.invoke('oz:bulk:list'),
    onProgress(cb) {
      const listener = (_e, payload) => cb(payload)
      ipcRenderer.on('oz:bulk:progress', listener)
      return () => ipcRenderer.off('oz:bulk:progress', listener)
    },
    onCompleted(cb) {
      const listener = (_e, payload) => cb(payload)
      ipcRenderer.on('oz:bulk:completed', listener)
      return () => ipcRenderer.off('oz:bulk:completed', listener)
    },
    onCreated(cb) {
      const listener = (_e, payload) => cb(payload)
      ipcRenderer.on('oz:bulk:created', listener)
      return () => ipcRenderer.off('oz:bulk:created', listener)
    },
    onStarted(cb) {
      const listener = (_e, payload) => cb(payload)
      ipcRenderer.on('oz:bulk:started', listener)
      return () => ipcRenderer.off('oz:bulk:started', listener)
    },
  }
}

module.exports = { buildBulkApi }
