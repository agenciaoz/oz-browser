// OZ Browser — MCP tools: system diagnostics (alpha.112).
//
// Da al agente una vista COMPLETA del navegador de una sola llamada, incluida
// captura visual. MCP-first (regla Jose): estado en MAIN + tool oz.diag.*.
//
// Nombres registrados (guard ≤21 chars): oz_diag_snapshot(16),
// oz_diag_logs(12), oz_diag_selfCheck(17), oz_diag_screenshot(18).
//
// ADR: 0005 (modular) · 0012 (oz-mcp-server) · 0043 (system-diagnostics).

'use strict'

function buildDiagTools({ diag }) {
  const h = () => diag && diag()
  return [
    {
      name: 'oz.diag.snapshot',
      description:
        'Full structured health snapshot of the running browser in ONE call: runtime (version/uptime/memory), enforceProxy flag, identities, proxy health summary (active/disabled/failing/avgLatency), cached sessions, tabs per window, workspaces, sync status, key settings toggles, last scrape report, a self-check of the diagnostics subsystem, and (by default) the recent WARN/ERROR log tail. Use this to review the whole app state without asking the user. Opts: {includeLog, logLevel, logLimit}.',
      inputSchema: {
        type: 'object',
        properties: {
          includeLog: { type: 'boolean' },
          logLevel: { type: 'string', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] },
          logLimit: { type: 'number' },
        },
        additionalProperties: false,
      },
      call: (args) => h().snapshot(args || {}),
    },
    {
      name: 'oz.diag.logs',
      description:
        'Recent log lines from the OZ log file, filtered by minimum level (default WARN). Returns { lines[], counts:{DEBUG,INFO,WARN,ERROR}, logPath }. Use to inspect recent errors/warnings. Opts: {level, limit}.',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      call: (args) => h().logs(args || {}),
    },
    {
      name: 'oz.diag.selfCheck',
      description:
        'Self-verification of the diagnostics subsystem and its dependencies (managers/handlers present). Returns { ok, failed, checks:[{name,ok,detail}] }. Use to confirm the app can actually be fully inspected, or to diagnose the diagnostics itself.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => h().selfCheck(),
    },
    {
      name: 'oz.diag.screenshot',
      description:
        "Capture a PNG of the browser and save it to disk; returns { ok, path, target, bytes, width, height, url }. The agent can then read the file at `path` to visually analyze it. target: 'content' (active tab page, default), 'chrome' (the OZ WebUI chrome/sidebar/tabstrip), 'tab' (+tabId), or 'identity' (+identityId, first materialized tab). Use to SEE the current UI or a page, not just its state.",
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['content', 'chrome', 'tab', 'identity'] },
          tabId: { type: 'string' },
          identityId: { type: 'string' },
        },
        additionalProperties: false,
      },
      call: (args) => h().screenshot(args || {}),
    },
  ]
}

module.exports = { buildDiagTools }
