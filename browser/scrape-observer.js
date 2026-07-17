// OZ Browser — Scrape observability (V3-E, alpha.111).
//
// Qué hace: consume los eventos de progreso de runScrapeJob (uno por URL) y
// arma un reporte estructurado del job: action log, timeline de screenshots,
// y un cost tracker (páginas, bytes, duración, desglose por worker y dominio).
// Es lo que faltaba de V3-E (observabilidad "no existe" en el plan).
//
// Pieza PURA (sin Electron): el reloj se inyecta, y solo consume los eventos
// que le pasa el orquestador. Se testea determinista (ADR 0005). El wiring que
// la engancha a un job real vive en scrape-handlers.js (onProgress).
//
// Uso:
//   const obs = new ScrapeObserver({ jobId, now })
//   obs.start()
//   // ... en cada onProgress: obs.record(evt)
//   obs.finish(summary)
//   const report = obs.report()
//
// Doc: docs/modules/scrape-observer.md
// ADR: docs/architecture/0042-scrape-observability.md

'use strict'

const MAX_ACTION_LOG = 5000 // cap defensivo para jobs enormes
const MAX_ERRORS = 200

function domainOf(url) {
  try {
    return new URL(url).hostname || '(unknown)'
  } catch (_e) {
    return '(unknown)'
  }
}

class ScrapeObserver {
  /**
   * @param {object} [opts]
   * @param {string} [opts.jobId]
   * @param {()=>number} [opts.now] — reloj inyectable (default Date.now).
   * @param {string} [opts.identityId]
   */
  constructor(opts = {}) {
    this.jobId = opts.jobId || `scrape-${Date.now().toString(36)}`
    this.identityId = opts.identityId || null
    this._now = opts.now || (() => Date.now())
    this.startedAt = null
    this.endedAt = null
    this.actionLog = [] // [{ ts, url, domain, ok, workerId, durationMs, bytes, screenshot, error }]
    this.timeline = [] // [{ ts, url, screenshot }] — solo eventos con screenshot
    this.errors = [] // [{ ts, url, error }]
    this.byWorker = new Map() // workerId → { pages, ok, failed, bytes, totalMs }
    this.byDomain = new Map() // domain → { pages, ok, failed, bytes, totalMs }
    this.totals = { pages: 0, ok: 0, failed: 0, bytes: 0, totalMs: 0 }
    this._summary = null
  }

  start() {
    if (this.startedAt == null) this.startedAt = this._now()
    return this
  }

  /** Registra un evento de onProgress (una URL procesada). No lanza. */
  record(evt) {
    if (!evt || typeof evt.url !== 'string') return
    if (this.startedAt == null) this.start()
    const ts = Number.isFinite(evt.ts) ? evt.ts : this._now()
    const ok = !!evt.ok
    const workerId = evt.workerId == null ? -1 : evt.workerId
    const durationMs = Number.isFinite(evt.durationMs) ? evt.durationMs : 0
    const bytes = Number.isFinite(evt.bytes) ? evt.bytes : 0
    const domain = domainOf(evt.url)

    if (this.actionLog.length < MAX_ACTION_LOG) {
      this.actionLog.push({
        ts,
        url: evt.url,
        domain,
        ok,
        workerId,
        durationMs,
        bytes,
        screenshot: evt.screenshot || null,
        error: ok ? null : evt.error || null,
        depth: evt.depth || 0,
      })
    }

    if (evt.screenshot) {
      this.timeline.push({ ts, url: evt.url, screenshot: evt.screenshot })
    }
    if (!ok && evt.error && this.errors.length < MAX_ERRORS) {
      this.errors.push({ ts, url: evt.url, error: evt.error })
    }

    this._bump(this.byWorker, workerId, ok, bytes, durationMs)
    this._bump(this.byDomain, domain, ok, bytes, durationMs)

    this.totals.pages++
    this.totals.ok += ok ? 1 : 0
    this.totals.failed += ok ? 0 : 1
    this.totals.bytes += bytes
    this.totals.totalMs += durationMs
  }

  _bump(map, key, ok, bytes, durationMs) {
    let e = map.get(key)
    if (!e) {
      e = { pages: 0, ok: 0, failed: 0, bytes: 0, totalMs: 0 }
      map.set(key, e)
    }
    e.pages++
    e.ok += ok ? 1 : 0
    e.failed += ok ? 0 : 1
    e.bytes += bytes
    e.totalMs += durationMs
  }

  /** Marca el fin del job; guarda el summary del orquestador si se pasa. */
  finish(summary) {
    this.endedAt = this._now()
    if (summary) this._summary = summary
    return this
  }

  /** Reporte estructurado consumible por MCP/UI. */
  report() {
    const endedAt = this.endedAt != null ? this.endedAt : this._now()
    const startedAt = this.startedAt != null ? this.startedAt : endedAt
    const wallMs = Math.max(0, endedAt - startedAt)
    const pages = this.totals.pages
    const avgPageMs = pages > 0 ? Math.round(this.totals.totalMs / pages) : 0
    const mapOut = (m) =>
      Array.from(m.entries())
        .map(([key, v]) => ({
          key: String(key),
          ...v,
          avgMs: v.pages > 0 ? Math.round(v.totalMs / v.pages) : 0,
          successRate: v.pages > 0 ? Number((v.ok / v.pages).toFixed(3)) : 0,
        }))
        .sort((a, b) => b.pages - a.pages)

    return {
      jobId: this.jobId,
      identityId: this.identityId,
      startedAt,
      endedAt,
      wallMs,
      cost: {
        pages,
        ok: this.totals.ok,
        failed: this.totals.failed,
        successRate: pages > 0 ? Number((this.totals.ok / pages).toFixed(3)) : 0,
        bytes: this.totals.bytes,
        avgPageMs,
        // Throughput observado (páginas/min) sobre el wall-clock del job.
        pagesPerMin: wallMs > 0 ? Number(((pages / wallMs) * 60000).toFixed(1)) : 0,
      },
      byWorker: mapOut(this.byWorker),
      byDomain: mapOut(this.byDomain),
      timeline: this.timeline.slice(),
      errors: this.errors.slice(),
      actionLog: this.actionLog.slice(),
      summary: this._summary || null,
    }
  }
}

module.exports = { ScrapeObserver, domainOf }
