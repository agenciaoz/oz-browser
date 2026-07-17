// OZ Browser — Sticky-sessid auto-rotation per identity (v2 alpha.30).
//
// Cada identity con un proxy que tenga `-sessid-XXX-` en el username (e.g.
// Oxylabs) recibe un sessid ephemeral generado al activar la identity. Ese
// sessid se mantiene mientras esté dentro del sticky window (30 min default,
// match con sesstime-30 de Oxylabs). Al re-activar la identity DESPUÉS del
// window, el sessid se renueva automáticamente → IP nueva.
//
// State: solo en memoria. Boot fresh = sessid fresh en la primera activación
// de cada identity (acorde a la decisión Jose).
//
// Why: evita que el sticky de Oxylabs (que devuelve la MISMA IP residencial
// mientras el ticket esté vivo) re-use la IP después del window — cada
// "nueva sesión" del operador resulta en IP nueva, sin perder consistencia
// mid-sesión.
//
// ADR: docs/architecture/0034-sticky-sessid-rotation.md
// Doc: docs/modules/proxy-sticky-rotation.md

'use strict'

const DEFAULT_STICKY_WINDOW_MS = 30 * 60 * 1000 // 30 min — match Oxylabs sesstime
// Fail-closed sink: nothing listens on port 1, so every request errors with
// ERR_PROXY_CONNECTION_FAILED instead of silently going direct (real-IP leak).
const BLACKHOLE_RULES = 'socks5://127.0.0.1:1'

/**
 * Replace `-sessid-XXX-` (or `-sessid-XXX$`) in a proxy username with a new
 * random sessid. Returns the new username, or the original if no marker.
 * Pure helper — exported for tests.
 */
function replaceSessidInUsername(username, newSessid) {
  if (!username || typeof username !== 'string') return username
  if (!username.match(/-sessid-([^-]+)/)) return username
  return username.replace(/-sessid-[^-]+/, `-sessid-${newSessid}`)
}

/**
 * Generate a random sessid suitable for Oxylabs (base36, 8 chars). Same
 * shape as proxy-actions.js._normalizeSessidInUsername to keep behavior
 * consistent across the manual "Rotate sticky" button and this auto path.
 */
function generateSessid() {
  return Math.floor(Math.random() * 1e8)
    .toString(36)
    .slice(0, 8)
}

function _silentLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop }
}

class StickyRotation {
  /**
   * @param {object} opts
   * @param {object} opts.proxyAssignment — has .resolve({identityId})
   * @param {function} opts.toProxyRulesString — converts proxy → Electron rules
   * @param {object} [opts.identityManager] — has .getSession(identityId)
   * @param {number} [opts.windowMs=1800000] — sticky window in ms (30 min default)
   * @param {function} [opts.now=Date.now] — injectable clock for tests
   * @param {function} [opts.sessidGenerator=generateSessid] — injectable for tests
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    if (!opts.proxyAssignment) {
      throw new Error('StickyRotation: proxyAssignment required')
    }
    if (typeof opts.toProxyRulesString !== 'function') {
      throw new Error('StickyRotation: toProxyRulesString required')
    }
    this.proxyAssignment = opts.proxyAssignment
    this.toProxyRulesString = opts.toProxyRulesString
    this.identityManager = opts.identityManager || null
    this.windowMs = Number(opts.windowMs) || DEFAULT_STICKY_WINDOW_MS
    this.now = opts.now || Date.now
    this.sessidGenerator = opts.sessidGenerator || generateSessid
    this.log = opts.logger || _silentLogger()
    // Fail-closed: when enforce is ON and no proxy resolves, route to a
    // blackhole instead of direct — so a managed install can NEVER leak the
    // real IP (Jose: "el browser no puede navegar sin proxies").
    this.enforce = !!opts.enforce
    // identityId → { sessid: string, generatedAt: number }
    this._state = new Map()
  }

  /** Toggle fail-closed enforcement at runtime. */
  setEnforce(on) {
    this.enforce = !!on
  }

  /** Predicate exposed for tests. */
  isStale(generatedAt) {
    if (!generatedAt) return true
    return this.now() - generatedAt > this.windowMs
  }

  /**
   * Return the sessid currently in use for this identity. Rotates if stale
   * or first time. Returns null if the proxy doesn't have a sticky-session
   * marker (no `-sessid-` in username) — caller should fall back to the raw
   * proxy username.
   */
  getOrRotateSessid(identityId, proxy) {
    if (!proxy || !proxy.username) return null
    if (!proxy.username.match(/-sessid-([^-]+)/)) return null
    const current = this._state.get(identityId)
    if (current && !this.isStale(current.generatedAt)) {
      return current.sessid
    }
    const fresh = this.sessidGenerator()
    this._state.set(identityId, { sessid: fresh, generatedAt: this.now() })
    this.log.info('proxy-sticky-rotation', 'rotated sessid', {
      identityId,
      sessid: fresh,
      reason: current ? 'stale' : 'first-activation',
    })
    return fresh
  }

  /**
   * Build the Electron proxy-rules string for an identity, substituting the
   * ephemeral sessid if applicable. Returns 'direct://' if no proxy assigned.
   */
  buildRulesForIdentity(identityId) {
    // alpha.108: explicit 'direct' opt-out wins over enforce (fail-closed).
    // resolveRouting distingue "user eligió directo" de "no hay proxy".
    if (typeof this.proxyAssignment.resolveRouting === 'function') {
      const routing = this.proxyAssignment.resolveRouting({ identityId })
      if (routing.mode === 'direct') {
        this.log.info('proxy-sticky-rotation', 'explicit direct opt-out', {
          identityId,
        })
        return { proxy: null, rules: 'direct://', sessid: null, direct: true }
      }
    }
    const proxy = this.proxyAssignment.resolve({ identityId })
    if (!proxy) {
      // No proxy resolved. Fail-closed if enforcing (blackhole = every request
      // errors, no real-IP leak); otherwise direct as before.
      const rules = this.enforce ? BLACKHOLE_RULES : 'direct://'
      if (this.enforce) {
        this.log.warn('proxy-sticky-rotation', 'no proxy — blackholing (enforced)', {
          identityId,
        })
      }
      return { proxy: null, rules, sessid: null, blackholed: this.enforce }
    }
    const sessid = this.getOrRotateSessid(identityId, proxy)
    if (!sessid) {
      return { proxy, rules: this.toProxyRulesString(proxy), sessid: null }
    }
    const rotated = {
      ...proxy,
      username: replaceSessidInUsername(proxy.username, sessid),
    }
    return { proxy: rotated, rules: this.toProxyRulesString(rotated), sessid }
  }

  /**
   * Apply the (rotated-if-needed) proxy to an Electron session for the
   * given identity. Idempotent within the sticky window — calling repeatedly
   * mid-window with no clock advance is a no-op at the engine level.
   *
   * Returns a promise that resolves to {proxyId, sessid, rules}.
   */
  async applyForIdentity(identityId, session) {
    if (!session || typeof session.setProxy !== 'function') {
      this.log.warn('proxy-sticky-rotation', 'session missing setProxy', {
        identityId,
      })
      return { proxyId: null, sessid: null, rules: null }
    }
    const { proxy, rules, sessid } = this.buildRulesForIdentity(identityId)
    try {
      await session.setProxy({ proxyRules: rules })
      this.log.debug('proxy-sticky-rotation', 'session proxy applied', {
        identityId,
        proxyId: proxy && proxy.id,
        sessid,
        rules,
      })
    } catch (err) {
      this.log.error('proxy-sticky-rotation', 'session.setProxy failed', {
        identityId,
        message: err && err.message,
      })
    }
    return { proxyId: proxy && proxy.id, sessid, rules }
  }

  /**
   * Convenience: apply for the identity's CURRENT session via identityManager.
   * No-op if the manager hasn't created a session for this identity yet
   * (the normal setProxyResolutionHook will call us on create).
   */
  async refreshActiveSession(identityId) {
    if (!this.identityManager) return null
    const session =
      typeof this.identityManager.getSession === 'function'
        ? this.identityManager.getSession(identityId)
        : null
    if (!session) return null
    return this.applyForIdentity(identityId, session)
  }

  /** Forget the ephemeral state for an identity (used when identity is removed). */
  forget(identityId) {
    this._state.delete(identityId)
  }

  /** Test/debug helper: peek at the cache. */
  _peek(identityId) {
    return this._state.get(identityId) || null
  }
}

module.exports = {
  StickyRotation,
  replaceSessidInUsername,
  generateSessid,
  DEFAULT_STICKY_WINDOW_MS,
}
