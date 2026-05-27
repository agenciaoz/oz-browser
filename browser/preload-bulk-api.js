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
    rlStats: (opts) => ipcRenderer.invoke('oz:bulk:rlStats', opts),
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
    // alpha.20: open the Bulk Runner modal. Fired by the main process when
    // the user invokes the "Bulk Run…" menu item (⇧⌘B) or, eventually, the
    // Cmd+K palette entry. Same pattern as commands.onOpen / bulkOpen.onOpen.
    onOpen(cb) {
      const listener = () => cb()
      ipcRenderer.on('oz:bulk-runner:open', listener)
      return () => ipcRenderer.off('oz:bulk-runner:open', listener)
    },
    // v2 Etapa 4.1: open the Bulk Run History dashboard. Fired by menu.js
    // when the user invokes the "Bulk Run History…" menu item.
    onOpenHistory(cb) {
      const listener = () => cb()
      ipcRenderer.on('oz:bulk-history:open', listener)
      return () => ipcRenderer.off('oz:bulk-history:open', listener)
    },
    // v2 Etapa 4.2: open the Bulk Run History dashboard directly at the
    // detail view of a specific run. Fired by bulk-notifications.js when
    // the user clicks a completion toast.
    onOpenHistoryAtRun(cb) {
      const listener = (_e, payload) => cb(payload || {})
      ipcRenderer.on('oz:bulk-history:open-at-run', listener)
      return () => ipcRenderer.off('oz:bulk-history:open-at-run', listener)
    },
    // v2 Etapa 4.4: open the dashboard pre-filtered to a single identity.
    // Fired by the command palette ("Activity for {identity}…") so the
    // operator can drill into an identity's recent activity in one click.
    onOpenHistoryForIdentity(cb) {
      const listener = (_e, payload) => cb(payload || {})
      ipcRenderer.on('oz:bulk-history:open-for-identity', listener)
      return () => ipcRenderer.off('oz:bulk-history:open-for-identity', listener)
    },
  }
}

module.exports = { buildBulkApi }
