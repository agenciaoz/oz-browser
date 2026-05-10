// OZ Browser — Command Palette handlers (C-1).
//
// Builds the runtime command list shown in the Cmd+K overlay. Reads from the
// managers (identities, workspaces, focused window's tabs) and delegates the
// shape decision to the pure module browser/command-palette.js.
//
// Doc: docs/modules/command-palette.md
// Tests: tests/command-palette.smoketest.js (pure module only — handler is
//        thin glue, validated end-to-end via the MCP/IPC smoke).
//
// Exports: buildCommandPaletteHandlers(browser)
// IPC channels: oz:commands:list

const { buildCommands } = require('./command-palette')

function buildCommandPaletteHandlers(browser) {
  return {
    /**
     * Fetch the commands list for the focused window. Accepts an optional
     * focusedWindowId so the renderer can ask for a specific window's tabs
     * even when focus has shifted by the time the IPC fires.
     */
    list({ focusedWindowId } = {}) {
      const identities = browser.identityManager ? browser.identityManager.list() : []
      const workspaces = browser.workspaceManager ? browser.workspaceManager.list() : []

      // Resolve focused window. If a specific id was passed, honor it;
      // otherwise fall back to whatever's currently focused.
      const win = focusedWindowId
        ? browser.windows.find((w) => w.id === focusedWindowId)
        : browser.getFocusedWindow()

      // Tabs come from the focused window's Tabs container. Each tab might
      // not be materialized (lazy) — toSpec() / props on Tab cover both
      // cases; we read what we can without forcing materialization.
      const tabs = win && win.tabs ? win.tabs.list().map(tabSummary) : []
      const focusedTab = win && win.getFocusedTab ? win.getFocusedTab() : null

      const activeWorkspaceId = win ? win.workspaceId : null

      return buildCommands({
        identities,
        workspaces,
        tabs,
        activeIdentityId: browser.activeIdentityId,
        activeWorkspaceId,
        focusedTabId: focusedTab ? focusedTab.id : null,
      })
    },
  }
}

/**
 * Reduce a Tab instance to the plain shape buildCommands expects.
 * Reading title/url is safe on both materialized and lazy tabs (the lazy
 * variant stores them in pendingTitle/pendingUrl which the Tab class
 * resolves via getters).
 */
function tabSummary(tab) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    pinned: !!tab.pinned,
    locked: !!tab.locked,
  }
}

module.exports = {
  buildCommandPaletteHandlers,
}
