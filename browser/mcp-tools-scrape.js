// OZ Browser — MCP tool: parallel scrape orchestrator (V3-D close).
//
// Exports: buildScrapeTools({ scrape }) — getter al handler map.
// ADR: 0005 (modular) · 0012 (oz-mcp-server) · 0036 (page-control).

'use strict'

function buildScrapeTools({ scrape }) {
  return [
    {
      name: 'oz.scrape.run',
      description:
        'Run a parallel scrape over an identity. Seeds the crawl frontier with `urls`, spaces requests per-domain (minIntervalMs), runs `concurrency` workers, and for each URL navigates + runs the optional `recipe` steps (extract/getText/...) under `identityId`. Transient failures are retried (frontier requeue); captcha/login are not. Returns { processed, ok, failed, results, stats, aborted }. NOTE: hard anti-bot sites (Cloudflare) may refuse the proxy IP.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          urls: { type: 'array', items: { type: 'string' } },
          recipe: {
            type: 'object',
            description: 'Optional { steps:[{op,...}] } run after navigating each URL.',
          },
          concurrency: { type: 'number' },
          maxPages: { type: 'number' },
          minIntervalMs: { type: 'number' },
          followLinks: { type: 'boolean' },
          linksName: { type: 'string' },
        },
        required: ['identityId', 'urls'],
        additionalProperties: false,
      },
      call: (args) => scrape().run(args),
    },
  ]
}

module.exports = { buildScrapeTools }
