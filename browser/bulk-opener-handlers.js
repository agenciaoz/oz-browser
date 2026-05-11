// OZ Browser — Bulk multi-account opener handlers (C-4).
//
// Thin glue between the pure bulk-opener module and the Electron managers.
// Hands the live managers (IdentityManager / WorkspaceManager / tab-handlers)
// to the orchestrator and broadcasts UI refresh events on completion.
//
// Doc: docs/modules/bulk-opener.md
// Pure logic tests: tests/bulk-opener.smoketest.js
// Exports: buildBulkOpenerHandlers(browser)

const {
  bulkOpenFromExisting,
  bulkCreateNew,
  resolveUrlPattern,
  resolveNamePattern,
  validateInput,
} = require('./bulk-opener')
const log = require('./logger')

function buildBulkOpenerHandlers(browser) {
  return {
    fromExisting(input) {
      const deps = makeDeps(browser)
      const result = bulkOpenFromExisting(input, deps)
      if (result.ok && (result.opened.length > 0 || result.workspaceCreated)) {
        broadcastRefresh(browser)
      }
      return result
    },

    createNew(input) {
      const deps = makeDeps(browser)
      const result = bulkCreateNew(input, deps)
      if (result.ok && (result.created.length > 0 || result.workspaceCreated)) {
        broadcastRefresh(browser)
      }
      return result
    },

    // Preview helpers — UI uses these to render the live preview list while
    // the user types in the URL / name pattern inputs. Pure functions, no
    // side effects.
    previewNames({ namePattern, count }) {
      const n = Math.min(Math.max(Number(count) || 0, 0), 50)
      const out = []
      for (let i = 1; i <= n; i++) out.push(resolveNamePattern(namePattern || '', i))
      return out
    },

    previewUrls({ urlPattern, count }) {
      const n = Math.min(Math.max(Number(count) || 0, 0), 50)
      const out = []
      for (let i = 1; i <= n; i++) out.push(resolveUrlPattern(urlPattern || '', i))
      return out
    },

    // Validation surfaced as its own handler so the UI can do form-level
    // checks without round-tripping through the actual mutation.
    validate(input) {
      return validateInput(input || {})
    },
  }
}

function makeDeps(browser) {
  return {
    identityManager: browser.identityManager,
    workspaceManager: browser.workspaceManager,
    // Use the existing tab-handlers.openInIdentity so URL normalization and
    // broadcasts stay consistent (per C-1 BugCrawl fix).
    tabsHandlers: browser.handlers && browser.handlers.tabs,
    log,
  }
}

function broadcastRefresh(browser) {
  // Bulk operations touch identities + workspaces + tabs. Fire the standard
  // changed events so every sidebar / modal re-renders in one cycle.
  browser.broadcastToWebUI('oz:identities:changed')
  browser.broadcastToWebUI('oz:workspaces:changed')
  // Tabs.updated is granular (per-tab); a list-style 'changed' broadcast
  // isn't part of the IPC contract, but openInIdentity emits one per tab
  // already via tab-handlers, so we don't need to re-broadcast here.
}

module.exports = { buildBulkOpenerHandlers }
