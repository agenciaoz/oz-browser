// OZ Browser — Crawl frontier persistente (V3-D, scraping/agent-control).
//
// Cola de URLs por crawlear con dedupe + visited set + reintentos, que
// sobrevive a restarts. El orquestador hace `next()` → procesa → `markDone()`
// o `markFailed()`. Dedupe por URL normalizada: nunca encola dos veces la misma
// URL (ni una ya visitada).
//
// Orden: FIFO (BFS si se encola nivel por nivel). `depth` opcional con
// `maxDepth` para cortar la profundidad del crawl.
//
// Persistencia: JSON atómico (tmp+rename) en `filePath`. Si no se pasa
// `filePath`, opera 100% en memoria (útil para tests y crawls efímeros).
//
// Estados de una URL: pending (en cola) → done | failed. `markFailed` con
// `retryable:true` re-encola hasta `maxAttempts` (default 3); agotados, va a
// failed.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 1
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Normaliza una URL para dedupe: dropea el fragmento (#...), respeta el resto.
 * El host ya viene lowercased por la API URL. Devuelve null si no parsea.
 *
 * @param {string} url
 * @returns {string|null}
 */
function normalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null
  let u
  try {
    u = new URL(url.trim())
  } catch (_e) {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hash = ''
  return u.toString()
}

class CrawlFrontier {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath]   persistencia; ausente = solo memoria.
   * @param {number} [opts.maxDepth]   profundidad máx a encolar (default Infinity).
   * @param {number} [opts.maxAttempts] reintentos por URL (default 3).
   */
  constructor(opts = {}) {
    this.filePath = opts.filePath || null
    this.maxDepth = _intOr(opts.maxDepth, Infinity)
    this.maxAttempts = Math.max(1, _intOr(opts.maxAttempts, DEFAULT_MAX_ATTEMPTS))
    this._queue = [] // [{url, depth, attempts, meta}]
    this._seen = new Set() // URLs normalizadas ya encoladas alguna vez
    this._done = new Set()
    this._failed = new Map() // url → { attempts, lastError }
    if (this.filePath) this._load()
  }

  /**
   * Encola una URL. Devuelve true si se agregó; false si era duplicada, ya
   * vista, inválida, o excede maxDepth.
   *
   * @param {string} url
   * @param {object} [opts] {depth, meta}
   * @returns {boolean}
   */
  enqueue(url, opts = {}) {
    const norm = normalizeUrl(url)
    if (!norm) return false
    if (this._seen.has(norm)) return false
    const depth = _intOr(opts.depth, 0)
    if (depth > this.maxDepth) return false
    this._seen.add(norm)
    this._queue.push({
      url: norm,
      depth,
      attempts: 0,
      meta: opts.meta != null ? opts.meta : null,
    })
    this._persist()
    return true
  }

  /**
   * Encola varias URLs. Devuelve cuántas se agregaron.
   *
   * @param {string[]} urls
   * @param {object} [opts] {depth, meta} aplicado a todas
   * @returns {number}
   */
  enqueueMany(urls, opts = {}) {
    if (!Array.isArray(urls)) return 0
    let added = 0
    // Defer persistence to a single write at the end.
    const prevDefer = this._deferPersist
    this._deferPersist = true
    try {
      for (const u of urls) if (this.enqueue(u, opts)) added++
    } finally {
      this._deferPersist = prevDefer
    }
    if (added > 0) this._persist()
    return added
  }

  /**
   * Saca la próxima URL pendiente (FIFO). Devuelve null si la cola está vacía.
   * El item sale de la cola; el caller debe llamar markDone/markFailed.
   *
   * @returns {{url:string, depth:number, attempts:number, meta:any}|null}
   */
  next() {
    if (this._queue.length === 0) return null
    const item = this._queue.shift()
    this._persist()
    return item
  }

  /** Marca una URL como completada con éxito. */
  markDone(url) {
    const norm = normalizeUrl(url)
    if (!norm) return
    this._done.add(norm)
    this._failed.delete(norm)
    this._persist()
  }

  /**
   * Marca una URL como fallida. Si `retryable` y aún quedan intentos, la
   * re-encola (con attempts+1) al final de la cola. Si no, va a failed.
   *
   * @param {string} url
   * @param {object} [opts] {retryable, attempts, error}
   * @returns {{requeued:boolean}}
   */
  markFailed(url, opts = {}) {
    const norm = normalizeUrl(url)
    if (!norm) return { requeued: false }
    const attempts = _intOr(opts.attempts, 1)
    if (opts.retryable && attempts < this.maxAttempts) {
      this._queue.push({
        url: norm,
        depth: _intOr(opts.depth, 0),
        attempts,
        meta: opts.meta != null ? opts.meta : null,
      })
      this._persist()
      return { requeued: true }
    }
    this._failed.set(norm, {
      attempts,
      lastError: opts.error ? String(opts.error) : null,
    })
    this._persist()
    return { requeued: false }
  }

  /** ¿Esta URL ya fue vista (encolada) alguna vez? */
  has(url) {
    const norm = normalizeUrl(url)
    return norm ? this._seen.has(norm) : false
  }

  /** Cantidad de URLs pendientes en la cola. */
  pending() {
    return this._queue.length
  }

  /** Snapshot de conteos. */
  stats() {
    return {
      pending: this._queue.length,
      seen: this._seen.size,
      done: this._done.size,
      failed: this._failed.size,
    }
  }

  // ---------- persistencia ----------------------------------------------------

  _load() {
    if (!fs.existsSync(this.filePath)) return
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (_e) {
      return // corrupto → arranca fresco
    }
    if (!raw || raw.version !== SCHEMA_VERSION) return
    this._queue = Array.isArray(raw.queue) ? raw.queue : []
    this._seen = new Set(Array.isArray(raw.seen) ? raw.seen : [])
    this._done = new Set(Array.isArray(raw.done) ? raw.done : [])
    this._failed = new Map(
      raw.failed && typeof raw.failed === 'object' ? Object.entries(raw.failed) : [],
    )
  }

  _persist() {
    if (!this.filePath || this._deferPersist) return
    const out = {
      version: SCHEMA_VERSION,
      queue: this._queue,
      seen: Array.from(this._seen),
      done: Array.from(this._done),
      failed: Object.fromEntries(this._failed),
    }
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}

function _intOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

module.exports = { CrawlFrontier, normalizeUrl, SCHEMA_VERSION, DEFAULT_MAX_ATTEMPTS }
