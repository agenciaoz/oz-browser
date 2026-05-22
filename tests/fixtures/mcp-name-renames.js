// Fixture for the MCP server contract test (tests/mcp-server.smoketest.js).
//
// Maps IPC channel names (oz:domain:action) to their corresponding MCP tool
// names (oz_domain_action, sanitized) for the cases where the MCP name
// diverges from the IPC name because of the v1.9.4 ≤21-char rename.
//
// IPC channels stay verbose for renderer/preload ergonomics; MCP tool names
// are shortened to fit Claude Desktop's `mcp__<uuid-36>__<name>` prefix.
//
// See ADR 0012 "Update 2026-05-21".

// Domain rename: applies to every action under these domains.
const DOMAIN_RENAME_FOR_MCP = {
  identities: 'ids',
  workspaces: 'ws',
  fingerprint: 'fp',
  timemachine: 'tm',
  extensions: 'ext',
}

// Action rename: keyed by full IPC channel. Use when the verbose action
// overflows 21 chars even after the domain is shortened (or when the domain
// stays verbose but the action got renamed for clarity).
const ACTION_RENAME_FOR_MCP = {
  'oz:identities:clearBrowsingData': 'wipeData',
  'oz:identities:previewCloneName': 'previewName',
  'oz:identities:listByWorkspace': 'byWorkspace',
  'oz:identities:moveToWorkspace': 'moveToWs',
  'oz:tabs:duplicateInTemporary': 'dupTemp',
  'oz:tabs:duplicateInIdentity': 'dupInId',
  'oz:tabs:duplicateInNewIdentity': 'dupNewId',
  'oz:tabs:refreshAllInIdentity': 'refreshId',
  'oz:tabs:moveToNewWindow': 'moveNew',
  'oz:tabs:openInIdentity': 'openInId',
  'oz:tabs:moveToWorkspace': 'moveToWs',
  'oz:bookmarks:addFromTab': 'addTab',
  'oz:cookies:exportContent': 'exportStr',
  'oz:cookies:exportToFile': 'exportFile',
  'oz:cookies:importContent': 'importStr',
  'oz:cookies:importFromFile': 'importFile',
  'oz:proxies:listAssignable': 'assignable',
  'oz:proxies:assignToIdentity': 'assignId',
  'oz:proxies:assignToWorkspace': 'assignWs',
  'oz:proxies:setDefaultStrategy': 'setDefault',
  'oz:proxies:listAssignments': 'assigns',
  'oz:proxies:resolveForIdentity': 'resolveId',
  'oz:proxies:testConnectivity': 'testConn',
  'oz:proxies:importCsvContent': 'importStr',
  'oz:proxies:importCsvFromFile': 'importFile',
  'oz:proxies:exportCsvContent': 'exportStr',
  'oz:proxies:exportCsvToFile': 'exportFile',
  'oz:proxies:listProviders': 'providers',
  'oz:proxies:expandProvider': 'expand',
  'oz:accounts:getCredentialsForSite': 'getCreds',
  'oz:accounts:proposeAutoSave': 'autoSave',
  'oz:excel:exportToFile': 'exportFile',
  'oz:excel:importFromFile': 'importFile',
  'oz:fingerprint:applyGeoSuggestion': 'applyGeo',
  // v2 sub-bloque 1 — bulk runner action rename:
  'oz:bulk:listActions': 'actions',
}

// Resolve an IPC channel to its expected MCP tool name (sanitized form).
function ipcToMcpToolName(channel) {
  const parts = channel.split(':') // ["oz", domain, action]
  const mcpDomain = DOMAIN_RENAME_FOR_MCP[parts[1]] || parts[1]
  const mcpAction = ACTION_RENAME_FOR_MCP[channel] || parts[2]
  return `oz_${mcpDomain}_${mcpAction}`
}

module.exports = { DOMAIN_RENAME_FOR_MCP, ACTION_RENAME_FOR_MCP, ipcToMcpToolName }
