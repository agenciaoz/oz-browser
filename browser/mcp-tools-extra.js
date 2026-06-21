// OZ Browser — MCP tools aggregator for newer domains (projects, scrape,
// publishing). Consolidado para mantener mcp-tools.js bajo el budget de LOC
// (ADR 0005): un solo spread en vez de N requires + getters + spreads.
//
// ADR: 0005 (modular) · 0012 (oz-mcp-server).

'use strict'

const { buildProjectTools } = require('./mcp-tools-projects')
const { buildScrapeTools } = require('./mcp-tools-scrape')
const { buildPublishingTools } = require('./mcp-tools-publishing')

function buildExtraTools(browser) {
  const get = (k) => () => browser.handlers && browser.handlers[k]
  return [
    ...buildProjectTools({ projects: get('projects') }),
    ...buildScrapeTools({ scrape: get('scrape') }),
    ...buildPublishingTools({ publishing: get('publishing') }),
  ]
}

module.exports = { buildExtraTools }
