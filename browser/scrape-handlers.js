// OZ Browser — Scrape job handlers (V3-D close). Ata todos los primitivos:
// CrawlFrontier + DomainRateLimiter + retry + worker real (page-handlers) y
// corre runScrapeJob. Expuesto como MCP `oz.scrape.run` (agent-driven).
//
// El worker real navega cada URL bajo `identityId` y corre el `recipe`
// opcional (extract/getText/...). Reusa headless-runner vía scrape-worker.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const { buildPageHandlers } = require('./page-handlers')
const { CrawlFrontier } = require('./scrape-frontier')
const { DomainRateLimiter } = require('./scrape-ratelimit-domain')
const { runScrapeJob } = require('./scrape-orchestrator')
const { makeRecipeWorker } = require('./scrape-worker')
const { realClock } = require('./bulk-runner-clock')
const { ScrapeObserver } = require('./scrape-observer')
const log = require('./logger')

function buildScrapeHandlers(browser) {
  return {
    /**
     * Corre un scrape paralelo sobre una identity.
     * @param {object} opts
     * @param {string} opts.identityId
     * @param {string[]} opts.urls          URLs semilla.
     * @param {object} [opts.recipe]        pasos extra tras navegar (extract/getText/...).
     * @param {number} [opts.concurrency=2]
     * @param {number} [opts.maxPages]
     * @param {number} [opts.minIntervalMs=1000]  espaciado por dominio.
     * @param {object} [opts.perDomain]     overrides de intervalo por dominio.
     * @param {boolean} [opts.followLinks=false]
     * @param {string} [opts.linksName]     step cuyo resultado (urls) seguir.
     */
    async run(opts = {}) {
      const {
        identityId,
        urls,
        recipe,
        concurrency,
        maxPages,
        minIntervalMs,
        perDomain,
      } = opts
      if (!identityId)
        return { __error: { code: 'BAD_ARGS', message: 'identityId required' } }
      const list = Array.isArray(urls) ? urls.filter((u) => typeof u === 'string') : []
      if (list.length === 0) {
        return { __error: { code: 'BAD_ARGS', message: 'urls[] (non-empty) required' } }
      }
      try {
        const driver = buildPageHandlers(browser)
        const frontier = new CrawlFrontier()
        frontier.enqueueMany(list)
        const rateLimiter = new DomainRateLimiter({
          minIntervalMs: minIntervalMs || 1000,
          perDomain,
        })
        const worker = makeRecipeWorker({
          driver,
          identityId,
          recipe,
          clock: realClock(),
          linksName: opts.linksName,
          // V3-D+6c: evidencia visual por página → timeline del observer.
          captureEvidence: !!opts.captureEvidence,
        })
        // V3-E (obs): observador del job. Consume onProgress → action log,
        // timeline de screenshots y cost tracker. El reporte va en el summary
        // y queda cacheado en browser._lastScrapeReport (MCP oz.scrape.lastReport).
        const observer = new ScrapeObserver({ jobId: opts.jobId, identityId }).start()
        const summary = await runScrapeJob({
          frontier,
          worker,
          rateLimiter,
          clock: realClock(),
          concurrency: concurrency || 2,
          maxPages: maxPages || undefined,
          followLinks: !!opts.followLinks,
          onProgress: (evt) => {
            try {
              observer.record(evt)
            } catch (_e) {
              /* obs nunca rompe el job */
            }
          },
        })
        observer.finish(summary)
        const report = observer.report()
        browser._lastScrapeReport = report
        log.info('scrape-handlers', 'run done', {
          identityId,
          jobId: report.jobId,
          processed: summary.processed,
          ok: summary.ok,
          failed: summary.failed,
          bytes: report.cost.bytes,
          wallMs: report.wallMs,
        })
        return { ...summary, report }
      } catch (err) {
        log.error('scrape-handlers', 'run crashed', { message: err.message })
        return { __error: { code: 'SCRAPE_CRASH', message: err.message } }
      }
    },

    /**
     * V3-E (obs): devuelve el reporte de observabilidad del último scrape job
     * corrido en esta sesión (action log + timeline + cost tracker), o null si
     * no hubo ninguno todavía.
     */
    lastReport() {
      return browser._lastScrapeReport || null
    },
  }
}

module.exports = { buildScrapeHandlers }
