// OZ Browser — Page-control handlers (v3-A, scraping/agent-control).
//
// Lets an agent (Claude/Cursor via MCP) drive a page inside a specific
// identity's tab: navigate + read DOM + eval. Resolves identity→tab→webContents
// and runs JS via executeJavaScript. Input-event tools (click/type/scroll with
// sendInputEvent) + waitFor/screenshot/extract land in later v3-A sub-blocks.
//
// Pure snippet builders live in page-utils.js. This module is the DOM/Electron
// boundary. MCP catalog: mcp-tools-page.js.
//
// ADR: 0036 (page-control layer) · 0012 (MCP server) · 0005 (modular 500 LOC)

'use strict'

const log = require('./logger')
const { normalizeOmniboxInput } = require('./url-normalize')
const PU = require('./page-utils')

function buildPageHandlers(browser) {
  // Find a tab by explicit id (any window), else the first tab of the identity.
  function resolveTab(identityId, tabId) {
    if (tabId) {
      for (const win of browser.windows) {
        const t = win.tabs.get(tabId)
        if (t) return t
      }
      return null
    }
    for (const win of browser.windows) {
      for (const t of win.tabs.tabList) {
        if (t.identityId === identityId) return t
      }
    }
    return null
  }

  function err(code, message) {
    return { __error: { code, message: message || code } }
  }

  async function runJS(identityId, tabId, code) {
    const tab = resolveTab(identityId, tabId)
    if (!tab) return err('TAB_NOT_FOUND', 'No tab for the given identity/tabId')
    if (!tab.materialized) tab.materialize()
    const wc = tab.webContents
    if (!wc || wc.isDestroyed())
      return err('NO_WEBCONTENTS', 'Tab has no live webContents')
    try {
      const result = await wc.executeJavaScript(code, true)
      return { ok: true, result }
    } catch (e) {
      return err('EVAL_FAILED', e && e.message)
    }
  }

  return {
    /** Navigate the identity's tab to url (creates a tab if none + a focused window). */
    navigate({ identityId, tabId, url }) {
      const norm = url ? normalizeOmniboxInput(url) || url : null
      if (!norm) return err('BAD_URL', 'Missing or invalid url')
      const tab = resolveTab(identityId, tabId)
      if (!tab) {
        const win = browser.getFocusedWindow()
        if (!win || !identityId)
          return err('TAB_NOT_FOUND', 'No tab and no window to create one')
        const nt = win.tabs.create({ identityId, url: norm, source: 'page.navigate' })
        browser.broadcastToWebUI('oz:tabs:updated', {
          kind: 'created',
          tab: { ...nt.serialize(), windowId: win.id },
        })
        log.info('page-handlers', 'navigate created tab', { tabId: nt.id, identityId })
        return { ok: true, tabId: nt.id, url: norm, created: true }
      }
      if (!tab.materialized) tab.materialize()
      tab.loadURL(norm)
      log.info('page-handlers', 'navigate ok', { tabId: tab.id, url: norm })
      return { ok: true, tabId: tab.id, url: norm }
    },

    /** Current url + title of the tab. */
    getInfo({ identityId, tabId }) {
      const tab = resolveTab(identityId, tabId)
      if (!tab) return err('TAB_NOT_FOUND')
      const s = tab.serialize()
      return { ok: true, tabId: tab.id, url: s.url, title: s.title }
    },

    getText({ identityId, tabId, selector }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      return runJS(identityId, tabId, PU.getTextScript(selector))
    },

    getAttr({ identityId, tabId, selector, attr }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      if (!attr) return err('BAD_ATTR')
      return runJS(identityId, tabId, PU.getAttrScript(selector, attr))
    },

    queryAll({ identityId, tabId, selector, limit }) {
      if (!PU.isValidSelector(selector)) return err('BAD_SELECTOR')
      return runJS(identityId, tabId, PU.queryAllScript(selector, limit))
    },

    /** Run arbitrary JS in the page and return its value (agent escape hatch). */
    eval({ identityId, tabId, code }) {
      if (typeof code !== 'string' || !code.trim()) return err('BAD_CODE')
      return runJS(identityId, tabId, code)
    },
  }
}

module.exports = { buildPageHandlers }
