// OZ Browser — MCP tool catalog: page control (v3-A, scraping/agent-control).
//
// First v3-A slice: navigate + read DOM + eval, scoped to an identity's tab.
// Self-contained — builds its own page-handlers instance (no browser.handlers
// entry needed; ipc-handlers.js is at the 500 LOC cap). Spread into the main
// catalog by mcp-tools.js.
//
// Tool names sanitize dots→underscores at registration and stay ≤21 chars
// (oz_page_navigate = 16). ADR: 0036 · 0012.

'use strict'

const { buildPageHandlers } = require('./page-handlers')

const idTab = {
  identityId: { type: 'string', description: 'Identity id whose tab to control' },
  tabId: {
    type: 'string',
    description: 'Optional explicit tab id; defaults to the identity first tab',
  },
}

function buildPageTools(browser) {
  const h = buildPageHandlers(browser)
  return [
    {
      name: 'oz.page.navigate',
      description:
        'Navigate an identity tab to a URL (creates a tab in the focused window if the identity has none). Returns {ok,tabId,url,created?} or {__error}.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          url: { type: 'string', description: 'Target URL (scheme optional)' },
        },
        required: ['identityId', 'url'],
        additionalProperties: false,
      },
      call: (a) => h.navigate(a),
    },
    {
      name: 'oz.page.getInfo',
      description: 'Get the current {url,title} of an identity tab.',
      inputSchema: {
        type: 'object',
        properties: { ...idTab },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: (a) => h.getInfo(a),
    },
    {
      name: 'oz.page.getText',
      description:
        'Return textContent of the first element matching a CSS selector (null if none). Returns {ok,result}.',
      inputSchema: {
        type: 'object',
        properties: { ...idTab, selector: { type: 'string' } },
        required: ['identityId', 'selector'],
        additionalProperties: false,
      },
      call: (a) => h.getText(a),
    },
    {
      name: 'oz.page.getAttr',
      description:
        'Return an attribute of the first element matching a CSS selector (null if none).',
      inputSchema: {
        type: 'object',
        properties: { ...idTab, selector: { type: 'string' }, attr: { type: 'string' } },
        required: ['identityId', 'selector', 'attr'],
        additionalProperties: false,
      },
      call: (a) => h.getAttr(a),
    },
    {
      name: 'oz.page.queryAll',
      description:
        'Collect up to `limit` (default 50, max 500) matches of a CSS selector as {count, items:[{text,href}]}.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          selector: { type: 'string' },
          limit: { type: 'number', description: 'Max items (1-500, default 50)' },
        },
        required: ['identityId', 'selector'],
        additionalProperties: false,
      },
      call: (a) => h.queryAll(a),
    },
    {
      name: 'oz.page.eval',
      description:
        'Run arbitrary JavaScript in the page and return its value. Escape hatch for extraction the other tools do not cover. Returns {ok,result} or {__error}.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          code: { type: 'string', description: 'JS expression/IIFE to evaluate' },
        },
        required: ['identityId', 'code'],
        additionalProperties: false,
      },
      call: (a) => h.eval(a),
    },
  ]
}

module.exports = { buildPageTools }
