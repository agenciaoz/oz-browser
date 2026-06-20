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
    {
      name: 'oz.page.click',
      description:
        'Real mouse click on the first element matching a CSS selector (scrolls into view, then native sendInputEvent — not a synthetic .click()). button: left|right|middle (default left).',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          selector: { type: 'string' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          human: {
            type: 'boolean',
            description:
              'Move along a Bézier path with gaussian delays (anti-detect). Default false.',
          },
        },
        required: ['identityId', 'selector'],
        additionalProperties: false,
      },
      call: (a) => h.click(a),
    },
    {
      name: 'oz.page.type',
      description:
        'Focus the first match and type text char-by-char via native key events. delayVarianceMs (0-500) adds a random per-char delay for human-like cadence.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          selector: { type: 'string' },
          text: { type: 'string' },
          delayVarianceMs: { type: 'number' },
          human: {
            type: 'boolean',
            description: 'Gaussian per-char cadence (anti-detect). Default false.',
          },
        },
        required: ['identityId', 'selector', 'text'],
        additionalProperties: false,
      },
      call: (a) => h.type(a),
    },
    {
      name: 'oz.page.scroll',
      description:
        "Scroll the page. `to`: 'top' | 'bottom' | a number of pixels (relative scrollBy). Returns {ok,result:scrollY}.",
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          to: {
            description: "'top' | 'bottom' | number of px",
            oneOf: [{ type: 'string' }, { type: 'number' }],
          },
          human: {
            type: 'boolean',
            description:
              'With a numeric distance, ease into momentum steps. Default false.',
          },
        },
        required: ['identityId', 'to'],
        additionalProperties: false,
      },
      call: (a) => h.scroll(a),
    },
    {
      name: 'oz.page.waitFor',
      description:
        'Wait until a CSS selector appears (polls), or just wait timeoutMs if no selector. timeoutMs default 5000, max 60000. Returns {ok,found} or {__error:TIMEOUT}.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          selector: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: (a) => h.waitFor(a),
    },
    {
      name: 'oz.page.screenshot',
      description: 'Capture the tab viewport as a base64 PNG. Returns {ok,base64,mime}.',
      inputSchema: {
        type: 'object',
        properties: { ...idTab },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: (a) => h.screenshot(a),
    },
    {
      name: 'oz.page.extract',
      description:
        'Declarative extraction: schema maps field→CSS selector (string) or {selector,attr}. Returns {ok,result:{field:value|null}}. The big token-saver for structured scraping.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          schema: {
            type: 'object',
            description: 'field → selector string OR {selector, attr}',
            additionalProperties: true,
          },
        },
        required: ['identityId', 'schema'],
        additionalProperties: false,
      },
      call: (a) => h.extract(a),
    },
    {
      name: 'oz.page.captcha',
      description:
        'Detect a captcha / bot-challenge on the identity tab (reCAPTCHA, hCaptcha, Cloudflare Turnstile/challenge, DataDome, PerimeterX). OZ detects + alerts, never solves. Returns {ok,detected,types,signals,primaryType}. Set alert=false to skip raising an OZ alert.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idTab,
          alert: {
            type: 'boolean',
            description: 'Raise an urgent OZ alert when detected. Default true.',
          },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: (a) => h.detectCaptcha(a),
    },
  ]
}

module.exports = { buildPageTools }
