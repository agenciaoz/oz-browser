// OZ Browser — Sync handler map (D-3c-3c).
//
// Mismo patrón que alert-handlers / health-handlers: handler map puro
// consumido por IPC (ipc-handlers-extra.js) y MCP (mcp-tools-sync.js).
//
// Las llamadas delegan al `syncBootstrap` ya instanciado en browser. Si el
// bootstrap no está (early-boot / NOT_CONFIGURED), los handlers devuelven
// un objeto coherente {ok:false, reason:'NOT_CONFIGURED'}.
//
// Doc: docs/modules/sync-handlers.md

'use strict'

function buildSyncHandlers(browser) {
  function _bootstrap() {
    return browser.syncBootstrap || null
  }

  return {
    getStatus() {
      const sb = _bootstrap()
      if (!sb) {
        return {
          configured: false,
          dropboxConnected: false,
          enabled: false,
          running: false,
          queueDepth: 0,
          vaultUnlocked: false,
          needsReauth: false,
          firstEnableAt: null,
          lastPullAt: null,
          lastPushAt: null,
          lastError: null,
        }
      }
      return sb.getStatus()
    },

    setEnabled(enabled) {
      const sb = _bootstrap()
      if (!sb) return { ok: false, reason: 'NOT_CONFIGURED' }
      if (typeof enabled !== 'boolean') {
        return { ok: false, reason: 'BAD_ARG', message: 'enabled must be boolean' }
      }
      return sb.setEnabled(enabled)
    },

    async pullNow() {
      const sb = _bootstrap()
      if (!sb) return { ok: false, reason: 'NOT_CONFIGURED' }
      return sb.pullNow()
    },
  }
}

module.exports = { buildSyncHandlers }
