// OZ Browser — preload bindings for the MCP server domain.
//
// Split from preload.js per ADR 0005 (500-LOC budget). Build pattern matches
// preload-proxy.js: a build* fn that returns an object the main preload spreads
// into window.oz. The renderer never imports this file directly.
//
// v1.6.1: surfaces MCP runtime status + Cowork config snippet to the Settings
// panel. The toggle itself stays in oz.settings.set('automation', ...).

'use strict'

function buildMcpBindings(ipcRenderer) {
  return {
    mcp: {
      status: () => ipcRenderer.invoke('oz:mcp:status'),
      getCoworkConfigSnippet: () => ipcRenderer.invoke('oz:mcp:getCoworkConfigSnippet'),
      retry: () => ipcRenderer.invoke('oz:mcp:retry'),
      onStatus(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:mcp:status', listener)
        return () => ipcRenderer.off('oz:mcp:status', listener)
      },
    },
  }
}

module.exports = { buildMcpBindings }
