// OZ Browser — preload bindings for the Settings domain.
//
// Split from preload.js per ADR 0005 (500-LOC budget). Same build pattern as
// preload-proxy.js / preload-mcp.js — returns an object the main preload
// spreads into window.oz.

'use strict'

function buildSettingsBindings(ipcRenderer) {
  return {
    settings: {
      getAll: () => ipcRenderer.invoke('oz:settings:getAll'),
      get: (section) => ipcRenderer.invoke('oz:settings:get', section),
      set: (section, patch) => ipcRenderer.invoke('oz:settings:set', section, patch),
      resetSection: (section) => ipcRenderer.invoke('oz:settings:resetSection', section),
      resetAll: () => ipcRenderer.invoke('oz:settings:resetAll'),
      onChanged(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:settings:changed', listener)
        return () => ipcRenderer.off('oz:settings:changed', listener)
      },
    },
  }
}

module.exports = { buildSettingsBindings }
