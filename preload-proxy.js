// OZ Browser — Preload bindings: proxy health + proxy actions (v1.1.2).
//
// Extracted from preload.js to keep main preload under 500 LOC (ADR 0005).
//
// Exports a factory that takes ipcRenderer and returns the two namespaces
// that get merged into window.oz at top-level: proxyHealth + proxyAction.

function buildProxyBindings(ipcRenderer) {
  return {
    proxyHealth: {
      getGlobalStatus: () => ipcRenderer.invoke('oz:proxyHealth:getGlobalStatus'),
      testAllAndStatus: () => ipcRenderer.invoke('oz:proxyHealth:testAllAndStatus'),
      getDashboard: () => ipcRenderer.invoke('oz:proxyHealth:getDashboard'),
      openDashboard: () => ipcRenderer.invoke('oz:proxyHealth:openDashboard'),
    },
    proxyAction: {
      test: (id) => ipcRenderer.invoke('oz:proxyAction:test', id),
      reset: (id) => ipcRenderer.invoke('oz:proxyAction:reset', id),
      setDisabled: (id, disabled) =>
        ipcRenderer.invoke('oz:proxyAction:setDisabled', id, disabled),
      rotateSticky: (id) => ipcRenderer.invoke('oz:proxyAction:rotateSticky', id),
      delete: (id) => ipcRenderer.invoke('oz:proxyAction:delete', id),
      reloadSession: (identityId) =>
        ipcRenderer.invoke('oz:proxyAction:reloadSession', identityId),
      reassign: (identityId, value) =>
        ipcRenderer.invoke('oz:proxyAction:reassign', identityId, value),
    },
    // H-2f (v1.1.3): bulk wrappers — sequential per id.
    proxyActionBulk: {
      test: (ids) => ipcRenderer.invoke('oz:proxyActionBulk:test', ids),
      reset: (ids) => ipcRenderer.invoke('oz:proxyActionBulk:reset', ids),
      setDisabled: (ids, disabled) =>
        ipcRenderer.invoke('oz:proxyActionBulk:setDisabled', ids, disabled),
      delete: (ids) => ipcRenderer.invoke('oz:proxyActionBulk:delete', ids),
      reloadSessions: (identityIds) =>
        ipcRenderer.invoke('oz:proxyActionBulk:reloadSessions', identityIds),
    },
    // H-2e (v1.1.3): diagnostics + alerts engine.
    proxyDiagnostics: {
      scan: () => ipcRenderer.invoke('oz:proxyDiagnostics:scan'),
      getAlerts: () => ipcRenderer.invoke('oz:proxyDiagnostics:getAlerts'),
      dismissAlert: (alertId) =>
        ipcRenderer.invoke('oz:proxyDiagnostics:dismissAlert', alertId),
      dismissAll: () => ipcRenderer.invoke('oz:proxyDiagnostics:dismissAll'),
    },
  }
}

module.exports = { buildProxyBindings }
