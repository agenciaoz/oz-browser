// OZ Browser — Parallel scrape orchestrator (V3-D, scraping/agent-control).
//
// Ata las piezas de V3-D para correr un crawl/scrape con N workers en paralelo:
//   - CrawlFrontier   → de dónde salen las URLs (dedupe + visited + reintentos)
//   - DomainRateLimiter → espacia requests al MISMO dominio entre todos los workers
//   - worker(task, ctx) → QUÉ se hace en cada URL (inyectado). En runtime es un
//     adapter sobre page-handlers bajo una identity; en tests es un fake.
//
// Diseño: `concurrency` loops corriendo a la vez. Cada loop saca una tarea del
// frontier, espera el slot del dominio (rate-limit), corre el worker, y según
// el resultado hace markDone (+ encola links descubiertos) o markFailed
// (re-encola si retryable y quedan intentos). Termina cuando el frontier se
// vacía y no hay workers en vuelo, o al llegar a `maxPages`, o si `signal`
// aborta.
//
// Pieza testeable sin Electron: worker + clock + frontier + rateLimiter se
// inyectan. El adapter Electron (worker real con identity+page-handlers) es un
// glue aparte y requiere smoke en vivo.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const DEFAULT_CONCURRENCY = 3

/**
 * Corre un job de scraping en paralelo. No lanza: agrega los errores de cada
 * URL al frontier (failed) y devuelve un resumen.
 *
 * @param {object} args
 * @param {object} args.frontier        CrawlFrontier-like: next(), markDone(url),
 *   markFailed(url,{retryable,attempts,error,depth}), enqueueMany(urls,{depth}), stats().
 * @param {(task:object, ctx:object)=>Promise<{ok:boolean, links?:string[], retryable?:boolean, data?:any, error?:any}>} args.worker
 * @param {object} [args.rateLimiter]   DomainRateLimiter-like: reserve(url)->{waitMs}.
 * @param {number} [args.concurrency=3]
 * @param {{sleep:(ms:number,signal?:any)=>Promise<void>}} [args.clock]
 * @param {{aborted:boolean}} [args.signal]
 * @param {number} [args.maxPages=Infinity]  corta tras N tareas tomadas.
 * @param {boolean} [args.followLinks=true]  encolar res.links como depth+1.
 * @param {(p:{url:string, ok:boolean, workerId:number, stats:object})=>void} [args.onProgress]
 * @returns {Promise<{processed:number, ok:number, failed:number, results:Array, stats:object, aborted:boolean}>}
 */
async function runScrapeJob(args) {
  const {
    frontier,
    worker,
    rateLimiter = null,
    clock = null,
    signal = null,
    onProgress = null,
  } = args || {}
  if (!frontier || typeof frontier.next !== 'function') {
    throw new Error('runScrapeJob: frontier with next() required')
  }
  if (typeof worker !== 'function') {
    throw new Error('runScrapeJob: worker function required')
  }
  const concurrency = Math.max(1, _intOr(args.concurrency, DEFAULT_CONCURRENCY))
  const maxPages = _numOr(args.maxPages, Infinity)
  const followLinks = args.followLinks !== false

  const state = { processed: 0, active: 0, results: [], stopped: false }

  const loops = []
  for (let w = 0; w < concurrency; w++) {
    loops.push(
      _workerLoop(w, state, {
        frontier,
        worker,
        rateLimiter,
        clock,
        signal,
        maxPages,
        followLinks,
        onProgress,
      }),
    )
  }
  await Promise.all(loops)

  const ok = state.results.filter((r) => r.ok).length
  return {
    processed: state.processed,
    ok,
    failed: state.results.length - ok,
    results: state.results,
    stats: frontier.stats ? frontier.stats() : {},
    aborted: !!(signal && signal.aborted),
  }
}

async function _workerLoop(workerId, state, deps) {
  const {
    frontier,
    worker,
    rateLimiter,
    clock,
    signal,
    maxPages,
    followLinks,
    onProgress,
  } = deps
  while (true) {
    if (state.stopped || (signal && signal.aborted)) return
    if (state.processed >= maxPages) return

    const task = frontier.next()
    if (!task) {
      // Cola vacía: si hay workers en vuelo pueden encolar links nuevos →
      // cedemos el control y reintentamos. Si nadie está activo, terminamos.
      if (state.active > 0) {
        await _tick()
        continue
      }
      return
    }

    state.active++
    state.processed++
    try {
      if (rateLimiter && typeof rateLimiter.reserve === 'function') {
        const { waitMs } = rateLimiter.reserve(task.url)
        if (waitMs > 0 && clock && typeof clock.sleep === 'function') {
          await clock.sleep(waitMs, signal)
        }
      }

      let res
      try {
        res = await worker(task, { workerId })
      } catch (e) {
        res = {
          ok: false,
          retryable: true,
          error: e && e.message ? e.message : String(e),
        }
      }

      const success = !!(res && res.ok)
      if (success) {
        frontier.markDone(task.url)
        if (
          followLinks &&
          Array.isArray(res.links) &&
          typeof frontier.enqueueMany === 'function'
        ) {
          frontier.enqueueMany(res.links, { depth: (task.depth || 0) + 1 })
        }
      } else {
        frontier.markFailed(task.url, {
          retryable: !!(res && res.retryable),
          attempts: (task.attempts || 0) + 1,
          depth: task.depth || 0,
          error: res && res.error,
        })
      }

      state.results.push({ url: task.url, ok: success, workerId })
      if (typeof onProgress === 'function') {
        onProgress({
          url: task.url,
          ok: success,
          workerId,
          stats: frontier.stats ? frontier.stats() : {},
        })
      }
    } finally {
      state.active--
    }
  }
}

function _tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function _intOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function _numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

module.exports = { runScrapeJob, DEFAULT_CONCURRENCY }
