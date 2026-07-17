// OZ Browser — Proxy assignment + resolution (1.8b).
//
// Qué hace: mapping persistente entre identities/workspaces y proxies, con
// resolución por jerarquía Identity > Workspace > none. Per-tab proxy NO
// está soportado en v1 (limitación técnica — ver ADR 0017 sección "Per-tab
// proxy not supported in v1"). Si querés un proxy distinto en una tab
// específica, usá Duplicate→New Identity y asignale un proxy a esa identity.
//
// Doc: docs/modules/proxy-assignment.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Storage: ~/Library/Application Support/<appName>/proxy-assignments.json
//
// Modelo:
//   {
//     byIdentity: { identityId: proxyId | 'auto-random' | 'auto-round-robin' | null },
//     byWorkspace: { workspaceId: ... },
//     defaultStrategy: null | 'auto-random' | 'auto-round-robin'  // global fallback
//   }
//
// Resolución (más específico gana):
//   1. byIdentity[identityId] → si concrete proxyId, return it.
//   2. byIdentity[identityId] === 'auto-*' → manager.autoAssign(strategy).
//   3. byWorkspace[workspaceId] → mismo.
//   4. defaultStrategy → mismo.
//   5. null = no proxy (direct).

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const log = require('./logger')

const AUTO_STRATEGIES = ['auto-random', 'auto-round-robin']

// alpha.108: explicit "no proxy, go direct" opt-out. Distinto de null/unset:
// null = "sin elección" (cae a workspace/defaultStrategy → en installs
// managed termina en proxy o blackhole), 'direct' = elección deliberada del
// user de navegar sin proxy. Corta la resolución (no fallthrough) y
// sticky-rotation la respeta incluso con enforce (fail-closed) activo.
const DIRECT = 'direct'

class ProxyAssignment {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'proxy-assignments.json')
    this.proxyManager = opts.proxyManager || null
    this.assignments = {
      byIdentity: {},
      byWorkspace: {},
      defaultStrategy: null,
    }
    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        this.assignments = {
          byIdentity: (parsed && parsed.byIdentity) || {},
          byWorkspace: (parsed && parsed.byWorkspace) || {},
          defaultStrategy: (parsed && parsed.defaultStrategy) || null,
        }
      }
    } catch (err) {
      console.error('[proxy-assignment] failed to load:', err)
      this.assignments = { byIdentity: {}, byWorkspace: {}, defaultStrategy: null }
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.assignments, null, 2), 'utf-8')
    } catch (err) {
      console.error('[proxy-assignment] failed to save:', err)
    }
  }

  // ---------- mutations ----------

  /**
   * Bind a proxy (or auto strategy, or null=clear) to an identity.
   * value can be: proxyId string | 'auto-random' | 'auto-round-robin' | null
   */
  assignToIdentity(identityId, value) {
    if (!identityId) return false
    if (value === null || value === undefined) {
      delete this.assignments.byIdentity[identityId]
    } else {
      this.assignments.byIdentity[identityId] = value
    }
    this._save()
    log.info('proxy-assignment', 'assigned to identity', { identityId, value })
    return true
  }

  assignToWorkspace(workspaceId, value) {
    if (!workspaceId) return false
    if (value === null || value === undefined) {
      delete this.assignments.byWorkspace[workspaceId]
    } else {
      this.assignments.byWorkspace[workspaceId] = value
    }
    this._save()
    log.info('proxy-assignment', 'assigned to workspace', { workspaceId, value })
    return true
  }

  setDefaultStrategy(strategy) {
    if (strategy !== null && !AUTO_STRATEGIES.includes(strategy)) {
      log.warn('proxy-assignment', 'invalid default strategy', { strategy })
      return false
    }
    this.assignments.defaultStrategy = strategy
    this._save()
    return true
  }

  /** Bulk clear all assignments touching `proxyId` (called on proxy delete). */
  clearByProxyId(proxyId) {
    let changed = false
    for (const id of Object.keys(this.assignments.byIdentity)) {
      if (this.assignments.byIdentity[id] === proxyId) {
        delete this.assignments.byIdentity[id]
        changed = true
      }
    }
    for (const id of Object.keys(this.assignments.byWorkspace)) {
      if (this.assignments.byWorkspace[id] === proxyId) {
        delete this.assignments.byWorkspace[id]
        changed = true
      }
    }
    if (changed) this._save()
    return changed
  }

  // ---------- resolution ----------

  /**
   * Resolve which proxy (if any) should be applied for the given context.
   * Returns the concrete proxy object (from ProxyManager) or null.
   *
   * @param {object} ctx
   * @param {string} [ctx.identityId]
   * @param {string} [ctx.workspaceId]
   */
  resolve(ctx = {}) {
    return this.resolveRouting(ctx).proxy
  }

  /**
   * Like resolve() but distinguishes WHY there is no proxy:
   *   { mode: 'proxy',  proxy }  — a concrete proxy resolved.
   *   { mode: 'direct', proxy: null } — explicit 'direct' opt-out (no
   *     fallthrough; wins over defaultStrategy and fail-closed enforce).
   *   { mode: 'none',   proxy: null } — nothing assigned/resolvable.
   */
  resolveRouting(ctx = {}) {
    const levels = [
      ctx.identityId != null ? this.assignments.byIdentity[ctx.identityId] : undefined,
      ctx.workspaceId != null ? this.assignments.byWorkspace[ctx.workspaceId] : undefined,
      this.assignments.defaultStrategy,
    ]
    for (const val of levels) {
      if (val === undefined || val === null) continue
      if (val === DIRECT) return { mode: 'direct', proxy: null }
      const r = this._materialize(val)
      if (r) return { mode: 'proxy', proxy: r }
    }
    return { mode: 'none', proxy: null }
  }

  /**
   * Convert an assignment value (proxyId | 'auto-*' | null) into a concrete
   * proxy object. Returns null if no manager, value invalid, or auto strategy
   * has empty pool.
   */
  _materialize(value) {
    if (!value || !this.proxyManager) return null
    if (AUTO_STRATEGIES.includes(value)) {
      const strategy = value === 'auto-random' ? 'random' : 'round-robin'
      return this.proxyManager.autoAssign(strategy)
    }
    // Concrete proxy id — must exist and be assignable.
    const proxy = this.proxyManager.get(value)
    if (!proxy || !proxy.isActive || proxy.isDisabled) return null
    return proxy
  }

  // ---------- inspection ----------

  /** Return the raw assignment map for the UI/MCP to display. */
  snapshot() {
    return {
      byIdentity: { ...this.assignments.byIdentity },
      byWorkspace: { ...this.assignments.byWorkspace },
      defaultStrategy: this.assignments.defaultStrategy,
    }
  }
}

/**
 * Convert a Proxy object into the proxyRules string Electron expects in
 * session.setProxy(). For HTTPS/HTTP a single 'host:port' works; SOCKS5
 * needs the 'socks5://' prefix.
 */
function toProxyRulesString(proxy) {
  if (!proxy) return null
  if (proxy.protocol === 'socks5') {
    return `socks5://${proxy.host}:${proxy.port}`
  }
  // For 'http' and 'https' Electron treats them as HTTP-tunnelled proxies;
  // we use the canonical 'host:port' form.
  return `${proxy.host}:${proxy.port}`
}

module.exports = {
  ProxyAssignment,
  toProxyRulesString,
  AUTO_STRATEGIES,
  DIRECT,
}
