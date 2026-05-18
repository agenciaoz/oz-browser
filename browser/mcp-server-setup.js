// OZ Browser — MCP Server boot glue + runtime reconcile.
//
// Extracted from main.js per ADR 0005 (500-LOC budget). Decides whether to
// start the MCP server based on (1) env vars OZ_MCP_ENABLED=1 (or 'true') or
// (2) the user toggle in Settings → Automation → mcpEnabled. Off by default
// per ADR 0012 (the server exposes the full browser API to localhost).
//
// History: H2 wired the settings fallback after HX0 found the toggle wasn't
// honored at boot (settings was being read AFTER createInitialWindow).
//
// v1.6.1: added reconcileMcpRuntime() so Settings → Automation toggle takes
// effect at runtime without an app restart, plus getMcpStatus() and
// buildCoworkConfigSnippet() so the UI can show a live pill + copy-paste
// config for claude_desktop_config.json.
//
// Failures never crash the browser — we log + leave browser.mcpServer null.

'use strict'

const path = require('path')
const { app } = require('electron')
const log = require('./logger')
const { MCPServer } = require('./mcp-server')

const DEFAULT_PORT = 9223

/**
 * Resolve the desired MCP server config from env + settings.
 * Env wins over settings — OZ_MCP_ENABLED=1 forces on regardless of toggle.
 */
function readDesiredState(browser) {
  const fromEnv =
    process.env.OZ_MCP_ENABLED === '1' || process.env.OZ_MCP_ENABLED === 'true'
  const auto = browser.settingsManager?.get('automation') || {}
  const fromSettings = !!auto.mcpEnabled
  return {
    enabled: fromEnv || fromSettings,
    port: Number(auto.mcpPort) || Number(process.env.OZ_MCP_PORT) || DEFAULT_PORT,
    token: auto.mcpToken || process.env.OZ_MCP_TOKEN || null,
    source: fromEnv ? 'env' : fromSettings ? 'settings' : null,
  }
}

async function setupMcpServer(browser) {
  const desired = readDesiredState(browser)
  if (!desired.enabled) return
  try {
    browser.mcpServer = new MCPServer(browser, {
      port: desired.port,
      token: desired.token,
    })
    browser.mcpServerStartedAt = Date.now()
    await browser.mcpServer.start()
    log.info('browser', 'MCP server enabled', {
      port: browser.mcpServer.port,
      endpoint: `http://127.0.0.1:${browser.mcpServer.port}/mcp`,
      source: desired.source,
    })
  } catch (err) {
    log.error('browser', 'MCP server failed to start', {
      message: err.message,
      stack: err.stack,
    })
    browser.mcpServer = null
    browser.mcpServerLastError = err.message
  }
}

/**
 * Reconcile MCP server runtime state with current settings.
 * Idempotent. Safe to call repeatedly. Diffs desired vs. actual:
 *   - desired off + actual off → noop
 *   - desired off + actual running → stop
 *   - desired on  + actual off → start
 *   - desired on  + actual running, but port/token changed → stop + start
 *   - desired on  + actual running same config → noop
 *
 * Never throws — logs warnings and surfaces the failure via
 * `browser.mcpServerLastError`. Returns the next status snapshot.
 */
async function reconcileMcpRuntime(browser) {
  const desired = readDesiredState(browser)
  const current = browser.mcpServer

  // Clear stale error every reconcile attempt so the UI can show "fixed".
  browser.mcpServerLastError = null

  // Case 1: desired off.
  if (!desired.enabled) {
    if (current) {
      try {
        await current.stop()
      } catch (err) {
        log.warn('browser', 'MCP stop during reconcile failed', { error: err.message })
      }
      browser.mcpServer = null
      browser.mcpServerStartedAt = null
      log.info('browser', 'MCP server stopped via reconcile')
    }
    return getMcpStatus(browser)
  }

  // Case 2: desired on, already running.
  if (current) {
    const sameConfig =
      current.port === desired.port && (current.token || null) === (desired.token || null)
    if (sameConfig) return getMcpStatus(browser)
    // Config mismatch (port or token changed) → stop existing first.
    try {
      await current.stop()
    } catch (err) {
      log.warn('browser', 'MCP stop during reconfigure failed', { error: err.message })
    }
    browser.mcpServer = null
    browser.mcpServerStartedAt = null
  }

  // Case 3: desired on, none running (or just stopped above) → start.
  try {
    browser.mcpServer = new MCPServer(browser, {
      port: desired.port,
      token: desired.token,
    })
    browser.mcpServerStartedAt = Date.now()
    await browser.mcpServer.start()
    log.info('browser', 'MCP server started via reconcile', {
      port: browser.mcpServer.port,
      tokenRequired: !!desired.token,
    })
  } catch (err) {
    log.error('browser', 'MCP server failed to start via reconcile', {
      message: err.message,
    })
    browser.mcpServer = null
    browser.mcpServerStartedAt = null
    browser.mcpServerLastError = err.message
  }
  return getMcpStatus(browser)
}

/**
 * Snapshot of MCP server state for the UI status pill.
 * Always returns a plain object — never throws.
 */
function getMcpStatus(browser) {
  const desired = readDesiredState(browser)
  const srv = browser.mcpServer
  const running = !!(srv && srv.server)
  const startedAt = browser.mcpServerStartedAt || null
  return {
    running,
    enabled: desired.enabled,
    source: desired.source,
    port: running ? srv.port : desired.port,
    host: '127.0.0.1',
    tokenRequired: running ? !!srv.token : !!desired.token,
    toolCount: running && srv.tools ? srv.tools.length : 0,
    uptimeSec: running && startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    lastError: browser.mcpServerLastError || null,
  }
}

/**
 * Build a copy-pasteable Claude Desktop / Cowork mcpServers entry that points
 * at this install's stdio bridge. The path baked in is absolute so the user
 * just pastes the snippet into claude_desktop_config.json with no edits.
 */
function buildCoworkConfigSnippet(browser) {
  const desired = readDesiredState(browser)
  // In packaged apps app.getAppPath() points at app.asar; the bridge lives
  // outside asar under Resources/. In dev, app.getAppPath() is the repo root.
  // Both layouts have tools/mcp-stdio-bridge.js as a sibling of package.json.
  const bridgePath = path.join(app.getAppPath(), 'tools', 'mcp-stdio-bridge.js')
  const env = {
    OZ_MCP_URL: `http://127.0.0.1:${desired.port}`,
  }
  if (desired.token) env.OZ_MCP_TOKEN = desired.token
  return {
    mcpServers: {
      'oz-browser': {
        command: 'node',
        args: [bridgePath],
        env,
      },
    },
  }
}

module.exports = {
  setupMcpServer,
  reconcileMcpRuntime,
  getMcpStatus,
  buildCoworkConfigSnippet,
}
