// OZ Browser — Bandwidth meter real por proxy (Fase 7, alpha.113).
//
// Reemplaza el placeholder `bandwidthBytesUsed: 0` de proxy-manager con una
// medición real: por cada respuesta de red de una sesión de identity, estima
// los bytes (Content-Length del header, o encodedDataLength cuando Electron lo
// da) y los atribuye al proxy que esa identity está usando. Se acumula en
// memoria y se vuelca (flush) al proxy-manager cada N ms para no escribir a
// disco en cada request.
//
// `estimateBytesFromHeaders` y `BandwidthAccumulator` son puros (sin Electron)
// → test determinista (ADR 0005). `attachBandwidthMeter` es el glue que hookea
// `session.webRequest.onCompleted` y requiere smoke en Electron.
//
// Doc: docs/modules/proxy-bandwidth.md
// ADR: docs/architecture/0044-bandwidth-meter.md

'use strict'

const log = require('./logger')

/**
 * Estima los bytes de una respuesta a partir de sus headers (y del
 * details.encodedDataLength si viene). Devuelve 0 si no hay señal.
 *
 * @param {object} details — objeto de webRequest.onCompleted.
 * @returns {number}
 */
function estimateBytesFromHeaders(details) {
  if (!details) return 0
  // 1. Electron a veces expone encodedDataLength (bytes reales on-wire).
  if (Number.isFinite(details.encodedDataLength) && details.encodedDataLength > 0) {
    return Math.floor(details.encodedDataLength)
  }
  // 2. Content-Length del header (case-insensitive; puede venir como array).
  const headers = details.responseHeaders || {}
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-length') {
      const raw = headers[key]
      const val = Array.isArray(raw) ? raw[0] : raw
      const n = parseInt(val, 10)
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return 0
}

/**
 * Acumula bytes por proxyId en memoria y los vuelca a un sink en batch. Puro:
 * el sink (que persiste) y el reloj se inyectan.
 */
class BandwidthAccumulator {
  /**
   * @param {object} opts
   * @param {(perProxy:Map<string,number>)=>void} opts.sink — recibe el batch al flush.
   */
  constructor(opts = {}) {
    this.sink = typeof opts.sink === 'function' ? opts.sink : () => {}
    this._pending = new Map() // proxyId → bytes acumulados desde el último flush
    this.totalBytes = 0
  }

  /** Suma bytes a un proxy. No-op si proxyId falsy o bytes <= 0. */
  add(proxyId, bytes) {
    if (!proxyId) return
    const n = Number(bytes)
    if (!Number.isFinite(n) || n <= 0) return
    this._pending.set(proxyId, (this._pending.get(proxyId) || 0) + Math.floor(n))
    this.totalBytes += Math.floor(n)
  }

  /** Vuelca lo acumulado al sink y limpia el buffer. Devuelve el batch. */
  flush() {
    if (this._pending.size === 0) return new Map()
    const batch = this._pending
    this._pending = new Map()
    try {
      this.sink(batch)
    } catch (e) {
      log.warn('proxy-bandwidth', 'sink flush failed', { message: e && e.message })
    }
    return batch
  }

  pendingSize() {
    return this._pending.size
  }
}

/**
 * Glue Electron: hookea onCompleted de una sesión y atribuye bytes al proxy
 * resuelto para su identity. Best-effort. Requiere smoke en vivo.
 *
 * @param {object} args
 * @param {object} args.session — Electron Session.
 * @param {string} args.identityId
 * @param {()=>string|null} args.resolveProxyId — devuelve el proxyId actual de la identity.
 * @param {BandwidthAccumulator} args.accumulator
 * @returns {boolean} true si se pudo enganchar.
 */
function attachBandwidthMeter({ session, identityId, resolveProxyId, accumulator } = {}) {
  if (!session || !session.webRequest || !accumulator) return false
  try {
    session.webRequest.onCompleted((details) => {
      try {
        const bytes = estimateBytesFromHeaders(details)
        if (bytes <= 0) return
        const proxyId =
          typeof resolveProxyId === 'function' ? resolveProxyId(identityId) : null
        if (proxyId) accumulator.add(proxyId, bytes)
      } catch (_e) {
        /* per-request best-effort */
      }
    })
    return true
  } catch (e) {
    log.warn('proxy-bandwidth', 'attach failed', {
      identityId,
      message: e && e.message,
    })
    return false
  }
}

module.exports = {
  estimateBytesFromHeaders,
  BandwidthAccumulator,
  attachBandwidthMeter,
}
