// OZ Browser — MCP Server boot glue.
//
// Extracted from main.js per ADR 0005 (500-LOC budget). Decides whether to
// start the MCP server based on (1) env vars OZ_MCP_ENABLED=1 (or 'true') or
// (2) the user toggle in Settings → Automation → mcpEnabled. Off by default
// per ADR 0012 (the server exposes the full browser API to localhost).
//
// History: H2 wired the settings fallback after HX0 found the toggle wasn't
// honored at boot (settings was being read AFTER createInitialWindow).
//
// Failures never crash the browser — we log + leave browser.mcpServer null.

'use strict'

const log = require('./logger')
const { MCPServer } = require('./mcp-server')

async function setupMcpServer(browser) {
  const fromEnv =
    process.env.OZ_MCP_ENABLED === '1' || process.env.OZ_MCP_ENABLED === 'true'
  const fromSettings = !!browser.settingsManager?.get('automation')?.mcpEnabled
  if (!fromEnv && !fromSettings) return
  try {
    browser.mcpServer = new MCPServer(browser)
    await browser.mcpServer.start()
    log.info('browser', 'MCP server enabled', {
      port: browser.mcpServer.port,
      endpoint: `http://127.0.0.1:${browser.mcpServer.port}/mcp`,
    })
  } catch (err) {
    log.error('browser', 'MCP server failed to start', {
      message: err.message,
      stack: err.stack,
    })
    browser.mcpServer = null
  }
}

module.exports = { setupMcpServer }
