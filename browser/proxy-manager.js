// OZ Browser — Proxy Manager (1.8a).
//
// Qué hace: CRUD de proxies + persistencia proxies.json + Auto-Assign
// random/round-robin. Proxies son recursos de runtime (no del Vault) — no se
// encriptan porque (a) el username/password ya están en plaintext en URLs como
// http://user:pass@host:port (b) el user los pega manualmente o via CSV
// import. La encriptación llegaría sólo si se introduce sync de proxies entre
// dispositivos (post-Etapa 4).
//
// Doc: docs/modules/proxy-manager.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Modelo:
//   {
//     id, name, protocol ('http'|'https'|'socks5'),
//     host, port, username?, password?,
//     tags: [], country?,
//     lastTestedAt?, lastLatencyMs?, lastTestedIp?, failureCount: 0,
//     isActive: true, isDisabled: false,
//     bandwidthBytesUsed: 0,
//     createdAt
//   }
//
// `isActive` = el user activó este proxy (puede asignarse).
// `isDisabled` = auto-disable después de 3 fallas seguidas (1.8c). Restauro on
// successful test. Si isDisabled=true, NO se asigna automáticamente aunque
// isActive=true.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const log = require('./logger')

const VALID_PROTOCOLS = ['http', 'https', 'socks5']
const DEFAULT_PROTOCOL = 'https' // ADR 0004
// alpha.39: consecutive health failures before auto-disable. Raised 3→5 —
// residential proxies (Oxylabs) have transient timeouts; 3 strikes disabled
// healthy proxies too eagerly. Pair with daemon auto-recovery (re-tests
// auto-disabled-but-active proxies so they come back on their own).
const AUTO_DISABLE_THRESHOLD = 5

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

class ProxyManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'proxies.json')
    this.proxies = []
    // Round-robin cursor across calls. Persisted across restarts via the
    // proxy.lastAssignedAt timestamp; we just compute next-by-time on demand.
    this._roundRobinIndex = 0
    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.proxies = JSON.parse(raw)
        if (!Array.isArray(this.proxies)) this.proxies = []
      }
    } catch (err) {
      console.error('[proxy-manager] failed to load proxies.json:', err)
      this.proxies = []
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.proxies, null, 2), 'utf-8')
    } catch (err) {
      console.error('[proxy-manager] failed to save proxies.json:', err)
    }
  }

  // ---------- CRUD ----------

  list() {
    return this.proxies.map((p) => ({ ...p }))
  }

  /** Filter to proxies usable for assignment: isActive AND NOT isDisabled. */
  listAssignable() {
    return this.proxies.filter((p) => p.isActive && !p.isDisabled).map((p) => ({ ...p }))
  }

  /**
   * alpha.39: proxies the health daemon should keep testing — everything the
   * user hasn't manually turned off (isActive), INCLUDING auto-disabled ones
   * so a recovered proxy gets re-tested and auto-re-enabled. Manual-off
   * (isActive=false) stays excluded.
   */
  listActiveForHealth() {
    return this.proxies.filter((p) => p.isActive).map((p) => ({ ...p }))
  }

  get(id) {
    return this.proxies.find((p) => p.id === id) || null
  }

  /**
   * Create a new proxy. Validates protocol + required fields. Returns the
   * proxy or { __error: { code, message } } for structured failures.
   */
  create({
    name = '',
    protocol = DEFAULT_PROTOCOL,
    host,
    port,
    username = null,
    password = null,
    tags = [],
    country = null,
    isActive = true,
  } = {}) {
    if (!host || typeof host !== 'string') {
      return { __error: { code: 'MISSING_HOST', message: 'Proxy needs a host.' } }
    }
    const portNum = Number(port)
    if (!portNum || portNum < 1 || portNum > 65535) {
      return {
        __error: {
          code: 'INVALID_PORT',
          message: `Invalid port: ${port}. Must be 1-65535.`,
        },
      }
    }
    if (!VALID_PROTOCOLS.includes(protocol)) {
      return {
        __error: {
          code: 'INVALID_PROTOCOL',
          message: `Invalid protocol: ${protocol}. Use one of ${VALID_PROTOCOLS.join('/')}.`,
        },
      }
    }

    const proxy = {
      id: uuid(),
      name: name || `${protocol}://${host}:${portNum}`,
      protocol,
      host,
      port: portNum,
      username,
      password,
      tags: Array.isArray(tags) ? tags.slice() : [],
      country,
      lastTestedAt: null,
      lastLatencyMs: null,
      lastTestedIp: null,
      failureCount: 0,
      isActive: !!isActive,
      isDisabled: false,
      bandwidthBytesUsed: 0, // Placeholder — real instrumentation in 1.10.
      createdAt: now(),
    }
    this.proxies.push(proxy)
    this._save()
    log.info('proxy-manager', 'proxy created', {
      id: proxy.id,
      protocol,
      host,
      port: portNum,
      total: this.proxies.length,
    })
    return { ...proxy }
  }

  /**
   * Patch update. Whitelisted fields. Returns updated proxy or null if id
   * unknown.
   */
  update(id, patch = {}) {
    const proxy = this._getRaw(id)
    if (!proxy) return null
    const allowed = [
      'name',
      'protocol',
      'host',
      'port',
      'username',
      'password',
      'tags',
      'country',
      'isActive',
      'isDisabled',
    ]
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
      if (key === 'protocol' && !VALID_PROTOCOLS.includes(patch.protocol)) {
        log.warn('proxy-manager', 'update: invalid protocol ignored', {
          id,
          requested: patch.protocol,
        })
        continue
      }
      if (key === 'port') {
        const p = Number(patch.port)
        if (!p || p < 1 || p > 65535) {
          log.warn('proxy-manager', 'update: invalid port ignored', {
            id,
            requested: patch.port,
          })
          continue
        }
        proxy.port = p
        continue
      }
      proxy[key] = patch[key]
    }
    this._save()
    log.info('proxy-manager', 'proxy updated', { id })
    return { ...proxy }
  }

  remove(id) {
    const before = this.proxies.length
    this.proxies = this.proxies.filter((p) => p.id !== id)
    if (this.proxies.length === before) return false
    this._save()
    log.info('proxy-manager', 'proxy removed', { id })
    return true
  }

  /** Bulk add (used by CSV import in 1.8d). Returns array of created proxies. */
  bulkAdd(items) {
    const out = []
    for (const item of items || []) {
      const r = this.create(item)
      if (!r.__error) out.push(r)
    }
    return out
  }

  // ---------- Auto-Assign ----------

  /**
   * Pick a proxy via the requested strategy from the assignable pool.
   *   - 'random': random non-disabled
   *   - 'round-robin': cycles through assignable list in insertion order
   * Returns null if no assignable proxies exist.
   */
  autoAssign(strategy = 'random') {
    const pool = this.listAssignable()
    if (pool.length === 0) return null
    if (strategy === 'random') {
      const idx = Math.floor(Math.random() * pool.length)
      return pool[idx]
    }
    if (strategy === 'round-robin') {
      const idx = this._roundRobinIndex % pool.length
      this._roundRobinIndex = (this._roundRobinIndex + 1) % pool.length
      return pool[idx]
    }
    log.warn('proxy-manager', 'autoAssign: unknown strategy, falling back to random', {
      strategy,
    })
    return pool[Math.floor(Math.random() * pool.length)]
  }

  // ---------- Health helpers (1.8c) ----------

  /**
   * Record a successful test result. Resets failureCount and re-enables a
   * disabled proxy (the user / daemon can recover from auto-disable).
   */
  recordHealthSuccess(id, { latencyMs, ip } = {}) {
    const proxy = this._getRaw(id)
    if (!proxy) return false
    proxy.lastTestedAt = now()
    proxy.lastLatencyMs = latencyMs || null
    proxy.lastTestedIp = ip || null
    proxy.failureCount = 0
    if (proxy.isDisabled) {
      proxy.isDisabled = false
      log.info('proxy-manager', 'proxy auto-re-enabled after success', { id })
    }
    this._save()
    return true
  }

  /**
   * Record a failure. After 3 consecutive failures, auto-disable.
   * Returns { failureCount, autoDisabled }.
   */
  recordHealthFailure(id, { reason } = {}) {
    const proxy = this._getRaw(id)
    if (!proxy) return null
    proxy.failureCount = (proxy.failureCount || 0) + 1
    proxy.lastTestedAt = now()
    let autoDisabled = false
    if (proxy.failureCount >= AUTO_DISABLE_THRESHOLD && !proxy.isDisabled) {
      proxy.isDisabled = true
      autoDisabled = true
      log.warn('proxy-manager', 'proxy auto-disabled after 3 failures', {
        id,
        reason,
      })
    }
    this._save()
    return { failureCount: proxy.failureCount, autoDisabled }
  }

  /** Internal mutable getter (not copied). Used by health record helpers. */
  _getRaw(id) {
    return this.proxies.find((p) => p.id === id) || null
  }
}

module.exports = {
  ProxyManager,
  VALID_PROTOCOLS,
  DEFAULT_PROTOCOL,
  AUTO_DISABLE_THRESHOLD,
}
