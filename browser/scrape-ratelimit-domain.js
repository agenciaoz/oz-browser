// OZ Browser — Per-domain rate limiter (V3-D, scraping/agent-control).
//
// Throttle por dominio para orquestación de scraping en paralelo: aunque N
// identities corran a la vez, los requests al MISMO dominio se espacian un
// intervalo mínimo (anti-detect + buena ciudadanía). Distintos dominios no se
// bloquean entre sí.
//
// Diseño: cada `reserve(url)` calcula cuánto esperar y EMPUJA el próximo slot
// disponible del dominio (start + intervalo). Bajo llamadas concurrentes esto
// serializa naturalmente: la 1ª reserva espera 0, la 2ª un intervalo, la 3ª
// dos, etc. Es el patrón clásico de "next-available timestamp".
//
// Pieza PURA salvo el `clock` inyectable (Date.now por defecto). Sin Electron,
// DOM ni fs → 100% testeable en node. El consumidor (orquestador paralelo)
// hace `await clock.sleep(waitMs)` con el waitMs devuelto.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const DEFAULT_MIN_INTERVAL_MS = 1000

/**
 * Deriva una clave de dominio estable desde una URL. Lowercase, sin `www.`.
 * Devuelve null si la URL no parsea o no tiene host (p.ej. about:blank).
 *
 * No reduce a eTLD+1 (evitamos depender de una Public Suffix List): la clave es
 * el hostname normalizado, suficiente para espaciar requests al mismo sitio.
 *
 * @param {string} url
 * @returns {string|null}
 */
function domainOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null
  let host
  try {
    host = new URL(url.trim()).hostname
  } catch (_e) {
    return null
  }
  if (!host) return null
  host = host.toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  return host || null
}

class DomainRateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minIntervalMs]  intervalo default entre requests al
   *   mismo dominio.
   * @param {Object<string,number>} [opts.perDomain]  overrides por dominio
   *   ({ 'instagram.com': 5000 }).
   * @param {{now:()=>number}} [opts.clock]
   */
  constructor(opts = {}) {
    this.minIntervalMs = _posNum(opts.minIntervalMs, DEFAULT_MIN_INTERVAL_MS)
    this.perDomain = {}
    if (opts.perDomain && typeof opts.perDomain === 'object') {
      for (const [k, v] of Object.entries(opts.perDomain)) {
        const n = Number(v)
        if (typeof k === 'string' && k.trim() && Number.isFinite(n) && n >= 0) {
          this.perDomain[domainOf('http://' + k) || k.toLowerCase()] = n
        }
      }
    }
    this.clock =
      opts.clock && typeof opts.clock.now === 'function' ? opts.clock : _realClock()
    this._nextAvailable = new Map() // domain → epoch ms del próximo slot libre
  }

  /** Intervalo (ms) configurado para un dominio. */
  intervalFor(domain) {
    if (domain && this.perDomain[domain] != null) return this.perDomain[domain]
    return this.minIntervalMs
  }

  /**
   * Reserva el próximo slot para `url`. MUTA el estado (empuja el next-available
   * del dominio). Devuelve cuánto esperar antes de disparar el request.
   *
   * URLs sin dominio (about:blank, basura) → waitMs 0 y no se trackean.
   *
   * @param {string} url
   * @returns {{domain:(string|null), waitMs:number, scheduledTs:number}}
   */
  reserve(url) {
    const domain = domainOf(url)
    const now = this.clock.now()
    if (!domain) return { domain: null, waitMs: 0, scheduledTs: now }
    const interval = this.intervalFor(domain)
    const prev = this._nextAvailable.get(domain) || 0
    const start = Math.max(now, prev)
    this._nextAvailable.set(domain, start + interval)
    return { domain, waitMs: Math.max(0, start - now), scheduledTs: start }
  }

  /**
   * Cuánto habría que esperar para `url` AHORA, sin reservar (no muta). Útil
   * para UI/telemetría.
   *
   * @param {string} url
   * @returns {number} ms
   */
  peek(url) {
    const domain = domainOf(url)
    if (!domain) return 0
    const prev = this._nextAvailable.get(domain) || 0
    return Math.max(0, prev - this.clock.now())
  }

  /** Snapshot { domain → nextAvailableTs } para inspección. */
  stats() {
    const out = {}
    for (const [d, ts] of this._nextAvailable.entries()) out[d] = ts
    return out
  }

  /** Resetea el estado de un dominio (o de todos si no se pasa). */
  reset(domain) {
    if (domain) this._nextAvailable.delete(domain)
    else this._nextAvailable.clear()
  }
}

function _posNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function _realClock() {
  return { now: () => Date.now() }
}

module.exports = { DomainRateLimiter, domainOf, DEFAULT_MIN_INTERVAL_MS }
