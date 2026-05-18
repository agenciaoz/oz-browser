// OZ Browser — MCP domain handlers (v1.6.1).
//
// Surfaces the MCP server runtime state + config-snippet builder to the WebUI
// Settings panel via the same `browser.handlers.<domain>` pattern used by
// every other module. The actual start/stop is driven implicitly by the
// settings change side-effect in settings-handlers.js — these handlers are
// read-mostly: a status snapshot for the pill and a copy-pasteable Cowork
// config for the button.
//
// Doc: docs/modules/mcp-server.md
// ADR: docs/architecture/0012-oz-mcp-server.md

'use strict'

const {
  getMcpStatus,
  buildCoworkConfigSnippet,
  reconcileMcpRuntime,
} = require('./mcp-server-setup')

function buildMcpHandlers(browser) {
  return {
    /** Snapshot of MCP server state for the status pill. */
    status() {
      return getMcpStatus(browser)
    },

    /** JSON object ready to paste into claude_desktop_config.json. */
    getCoworkConfigSnippet() {
      return buildCoworkConfigSnippet(browser)
    },

    /**
     * Force a reconcile cycle. Useful if the user fixed a port conflict and
     * wants to retry without toggling the checkbox off/on.
     */
    async retry() {
      return reconcileMcpRuntime(browser)
    },
  }
}

module.exports = { buildMcpHandlers }
