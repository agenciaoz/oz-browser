// OZ Browser — MCP tool catalog: network intercept (v3-A, scraping).
//
// Closes V3-A page-control: block/capture requests per identity. Self-contained
// (builds ONE buildNetworkHandlers instance so per-identity rule state persists
// across tool calls). Spread into the main catalog by mcp-tools.js.
//
// Names sanitize dots→underscores and stay ≤21 (oz_network_captured = 19).
// ADR: 0036 · 0012.

'use strict'

const { buildNetworkHandlers } = require('./network-handlers')

const idProp = {
  identityId: { type: 'string', description: 'Identity whose session to intercept' },
}

function buildNetworkTools(browser) {
  const h = buildNetworkHandlers(browser)
  return [
    {
      name: 'oz.network.block',
      description:
        'Block requests on an identity session whose URL matches any pattern (glob with * or plain substring). Empty array disables blocking. Great for dropping ads/trackers/heavy assets while scraping.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idProp,
          patterns: { type: 'array', items: { type: 'string' } },
        },
        required: ['identityId', 'patterns'],
        additionalProperties: false,
      },
      call: (a) => h.block(a),
    },
    {
      name: 'oz.network.capture',
      description:
        'Toggle request capture for an identity. on=true logs matching requests (patterns optional, default all). Read them with oz.network.captured.',
      inputSchema: {
        type: 'object',
        properties: {
          ...idProp,
          on: { type: 'boolean' },
          patterns: { type: 'array', items: { type: 'string' } },
        },
        required: ['identityId', 'on'],
        additionalProperties: false,
      },
      call: (a) => h.capture(a),
    },
    {
      name: 'oz.network.captured',
      description:
        'Return the captured request log for an identity: {count, items:[{url,method,resourceType,ts}]} (most recent `limit`, default 100, max 500).',
      inputSchema: {
        type: 'object',
        properties: { ...idProp, limit: { type: 'number' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: (a) => h.captured(a),
    },
    {
      name: 'oz.network.clear',
      description:
        'Reset block patterns + capture toggle + captured log for an identity.',
      inputSchema: {
        type: 'object',
        properties: { ...idProp },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: (a) => h.clear(a),
    },
  ]
}

module.exports = { buildNetworkTools }
