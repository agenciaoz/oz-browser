// OZ Browser — Proxy health checks + daemon (1.8c).
//
// Qué hace: tests de conectividad (single + bulk paralelo) + daemon que
// chequea cada 30 min + auto-disable después de 3 fallas seguidas.
//
// Doc: docs/modules/proxy-health.md
// ADR: docs/architecture/0017-proxy-model.md (sección Health checks)
//
// Estrategia v1 (sin deps externas):
//   - HTTP/HTTPS proxies: TCP connect + HTTP CONNECT handshake.
//     Status 200 → ok. Status 407 → ok (proxy vivo, solo falta auth — el user
//     ya verá el error en navigation real). Status 4xx/5xx u otro → fail.
//   - SOCKS5: solo TCP reachability (parsing SOCKS5 handshake completo es
//     overhead innecesario v1).
//   - Timeout default 10s. Latency = wall-time del primer-byte.
//
// Limitación: NO validamos que el proxy fetchee contenido externo (eso
// requiere TLS + GET + parsing). El TCP+CONNECT atrapa el 90% de los modos
// de falla (proxy dead, host wrong, port wrong, auth equivocado).
// "Real fetch test" llega en 1.10 con instrumentación completa.

const net = require('net')
const log = require('./logger')

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_DAEMON_INTERVAL_MS = 30 * 60 * 1000 // 30 min
const DEFAULT_TARGET = { host: 'api.ipify.org', port: 443 }

class ProxyHealth {
  constructor(opts = {}) {
    this.proxyManager = opts.proxyManager || null
    this.notify = opts.notify || null // optional fn(title, body)
    this.broadcast = opts.broadcast || null // optional fn(channel) — UI refresh
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    this._timer = null
    this._tcpConnect = opts.tcpConnect || tcpConnect // injectable for tests
    this._connectViaProxy = opts.connectViaProxy || connectViaProxy
  }

  /**
   * Run a single proxy health check. Records the result via the manager
   * (recordHealthSuccess / recordHealthFailure). Returns
   *   { ok: true, latencyMs, proxyId }
   * or
   *   { ok: false, reason, latencyMs?, proxyId, autoDisabled? }.
   */
  async testOne(proxyId) {
    const proxy = this.proxyManager && this.proxyManager.get(proxyId)
    if (!proxy) return { ok: false, reason: 'proxy-not-found', proxyId }

    const start = Date.now()
    let result
    try {
      if (proxy.protocol === 'socks5') {
        result = await this._tcpConnect(proxy.host, proxy.port, this.timeoutMs)
      } else {
        // http / https proxies: CONNECT handshake.
        result = await this._connectViaProxy(proxy, DEFAULT_TARGET, this.timeoutMs)
      }
    } catch (err) {
      result = { ok: false, message: err.message }
    }
    const latencyMs = Date.now() - start

    if (result.ok) {
      this.proxyManager.recordHealthSuccess(proxyId, { latencyMs })
      if (this.broadcast) this.broadcast('oz:proxies:changed')
      log.info('proxy-health', 'test ok', {
        proxyId,
        latencyMs,
        protocol: proxy.protocol,
      })
      return { ok: true, latencyMs, proxyId }
    }

    const rec = this.proxyManager.recordHealthFailure(proxyId, {
      reason: result.message || 'fail',
    })
    if (this.broadcast) this.broadcast('oz:proxies:changed')
    if (rec && rec.autoDisabled && this.notify) {
      try {
        this.notify(
          'OZ — Proxy auto-disabled',
          `${proxy.name || proxy.host} failed ${rec.failureCount} health checks in a row and was auto-disabled. Re-enable from the Proxy Manager.`,
        )
      } catch (_e) {
        // best-effort
      }
    }
    log.warn('proxy-health', 'test fail', {
      proxyId,
      reason: result.message,
      failureCount: rec && rec.failureCount,
      autoDisabled: rec && rec.autoDisabled,
    })
    return {
      ok: false,
      reason: result.message,
      latencyMs,
      proxyId,
      autoDisabled: rec && rec.autoDisabled,
    }
  }

  /**
   * Test all assignable proxies in parallel. Returns array of per-proxy
   * results in input order.
   */
  async testAll({ includeDisabled = false, activeOnly = false } = {}) {
    // includeDisabled → every proxy. activeOnly → everything not manually
    // turned off (incl. auto-disabled, so they can auto-recover). default →
    // only assignable.
    const proxies = includeDisabled
      ? this.proxyManager.list()
      : activeOnly
        ? this.proxyManager.listActiveForHealth()
        : this.proxyManager.listAssignable()
    if (proxies.length === 0) return []
    const results = await Promise.all(proxies.map((p) => this.testOne(p.id)))
    log.info('proxy-health', 'testAll done', {
      tested: proxies.length,
      ok: results.filter((r) => r.ok).length,
    })
    return results
  }

  /**
   * Start the periodic health daemon. Runs testAll() every `intervalMs`,
   * default 30 min. Only checks ASSIGNABLE proxies (no point checking ones
   * the user disabled).
   */
  startDaemon({ intervalMs = DEFAULT_DAEMON_INTERVAL_MS } = {}) {
    if (this._timer) return false
    this._timer = setInterval(() => {
      // alpha.39: activeOnly re-tests auto-disabled-but-active proxies too, so
      // a proxy that recovered gets auto-re-enabled (recordHealthSuccess clears
      // isDisabled). Manual-off proxies stay excluded.
      this.testAll({ activeOnly: true }).catch((err) => {
        log.error('proxy-health', 'daemon tick failed', { message: err.message })
      })
    }, intervalMs)
    log.info('proxy-health', 'daemon started', { intervalMs })
    return true
  }

  stopDaemon() {
    if (!this._timer) return false
    clearInterval(this._timer)
    this._timer = null
    log.info('proxy-health', 'daemon stopped')
    return true
  }
}

// ---------------- Low-level network helpers --------------------------------

/**
 * TCP connect with timeout. Resolves to {ok, message?} — the latency is
 * computed by the caller using Date.now().
 */
function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch (_e) {
        // ignore
      }
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish({ ok: true }))
    socket.on('timeout', () => finish({ ok: false, message: 'timeout' }))
    socket.on('error', (err) => finish({ ok: false, message: err.message }))
  })
}

/**
 * Open a TCP socket to the proxy and send an HTTP CONNECT request to the
 * target host:port. Resolves to {ok, status, message}. Status 200 or 407
 * counts as "proxy alive" (407 means missing creds, which is configurable
 * by the user — the proxy itself is reachable).
 */
function connectViaProxy(proxy, target, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let settled = false
    let buf = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch (_e) {
        // ignore
      }
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      const targetHost = target.host
      const targetPort = target.port
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
      ]
      if (proxy.username) {
        const creds = Buffer.from(
          `${proxy.username}:${proxy.password || ''}`,
          'utf-8',
        ).toString('base64')
        lines.push(`Proxy-Authorization: Basic ${creds}`)
      }
      lines.push('') // header terminator
      lines.push('') // body terminator
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      // Headers terminator
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1 && buf.length < 2048) return
      // Parse status line
      const firstLine = buf.split('\r\n')[0] || ''
      const m = firstLine.match(/^HTTP\/1\.[01]\s+(\d{3})/)
      if (!m) return finish({ ok: false, message: `bad response: ${firstLine}` })
      const status = parseInt(m[1], 10)
      if (status === 200 || status === 407) {
        return finish({ ok: true, status })
      }
      return finish({ ok: false, message: `HTTP ${status}`, status })
    })
    socket.on('timeout', () => finish({ ok: false, message: 'timeout' }))
    socket.on('error', (err) => finish({ ok: false, message: err.message }))
    socket.on('close', () => {
      if (!settled) finish({ ok: false, message: 'closed before response' })
    })
  })
}

module.exports = {
  ProxyHealth,
  tcpConnect,
  connectViaProxy,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DAEMON_INTERVAL_MS,
  DEFAULT_TARGET,
}
