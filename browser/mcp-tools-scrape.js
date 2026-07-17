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
          jobId: {
            type: 'string',
            description:
              'Optional label for this job (shows in the observability report).',
          },
        },
        required: ['identityId', 'urls'],
        additionalProperties: false,
      },
      call: (args) => scrape().run(args),
    },
    {
      name: 'oz.scrape.lastReport',
      description:
        'Observability report for the LAST scrape job run this session (V3-E): { jobId, wallMs, cost:{pages,ok,failed,successRate,bytes,avgPageMs,pagesPerMin}, byWorker[], byDomain[], timeline[] (screenshots), errors[], actionLog[] }. Returns null if no job has run yet. Use to answer "how did the last crawl go / where did it spend time / what failed".',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => scrape().lastReport(),
    },
  ]
}

module.exports = { buildScrapeTools }
