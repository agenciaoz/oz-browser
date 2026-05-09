// OZ Browser — Identity Manager
//
// Qué hace: CRUD de Identities + caching de Sessions per-Identity.
// Doc: docs/modules/identity-manager.md
// ADRs: docs/architecture/0003-default-identity-uses-defaultsession.md
//
// Exports: IdentityManager (class)
// IPC: registrado en ipc-handlers.js como oz:identities:*
//
// Storage: ~/Library/Application Support/<appName>/identities.json
// Sessions: persist:identity-<id> (excepto Default que usa defaultSession).

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app, session } = require('electron')
const log = require('./logger')

const DEFAULT_COLORS = [
  '#5b8def', '#ff7a45', '#36b37e', '#ffab00', '#9c5cf2',
  '#e85a8c', '#00b8d9', '#f15a5a', '#36b37e', '#ff5630',
]

// Free-tier cap. Bypass for development/internal builds via env OZ_TIER=paid.
// When billing arrives (Etapa 5), this is replaced by an entitlement check
// from auth-client.js. See plan §1 — Bloque 1.2 closing notes.
const MAX_IDENTITIES_FREE = 3
const IS_PAID_TIER = process.env.OZ_TIER === 'paid'

class IdentityCapError extends Error {
  constructor(current, max) {
    super(
      `Free tier limit reached (${current}/${max} identities). ` +
      `Upgrade to Basic ($12/mo) for unlimited identities, or set OZ_TIER=paid for development.`,
    )
    this.code = 'IDENTITY_CAP_REACHED'
    this.current = current
    this.max = max
  }
}

function uuid() {
  // Short, URL-safe id. crypto.randomUUID() works but is too long for partition names.
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

class IdentityManager {
  constructor() {
    this.dataDir = app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'identities.json')
    this.identities = []
    this.sessionCache = new Map() // id -> Session

    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.identities = JSON.parse(raw)
      }
    } catch (err) {
      console.error('[identity-manager] failed to load identities.json:', err)
      this.identities = []
    }

    // Ensure default identity exists.
    if (!this.identities.some((id) => id.isDefault)) {
      this.identities.unshift({
        id: 'default',
        name: 'Default',
        color: '#8a8a8a',
        fingerprintSeed: uuid(),
        createdAt: now(),
        isDefault: true,
      })
      this._save()
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.identities, null, 2), 'utf-8')
    } catch (err) {
      console.error('[identity-manager] failed to save identities.json:', err)
    }
  }

  // ---------- CRUD ----------

  list() {
    return this.identities.map((i) => ({ ...i }))
  }

  get(id) {
    return this.identities.find((i) => i.id === id) || null
  }

  getDefault() {
    return this.identities.find((i) => i.isDefault) || this.identities[0]
  }

  create({ name = 'New Identity', color, userAgent } = {}) {
    if (!IS_PAID_TIER) {
      // Default identity counts towards the cap intentionally — Free tier
      // gets 1 Default + up to (MAX-1) custom = 3 total.
      const current = this.identities.length
      if (current >= MAX_IDENTITIES_FREE) {
        log.warn('identity-manager', 'create blocked by free tier cap', {
          current,
          max: MAX_IDENTITIES_FREE,
        })
        throw new IdentityCapError(current, MAX_IDENTITIES_FREE)
      }
    }

    const used = new Set(this.identities.map((i) => i.color))
    const pickedColor =
      color ||
      DEFAULT_COLORS.find((c) => !used.has(c)) ||
      DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]

    const identity = {
      id: uuid(),
      name,
      color: pickedColor,
      fingerprintSeed: uuid(),
      createdAt: now(),
      userAgent: userAgent || null,
    }
    this.identities.push(identity)
    this._save()
    log.info('identity-manager', 'identity created', {
      id: identity.id, name: identity.name, total: this.identities.length,
    })
    return { ...identity }
  }

  rename(id, name) {
    return this.update(id, { name })
  }

  setColor(id, color) {
    return this.update(id, { color })
  }

  /**
   * Generic patch update. Whitelisted fields only.
   * If `userAgent` changes, the cached Session (if any) is updated immediately
   * via setUserAgent so subsequent navigations use the new UA.
   *
   * Default Identity rejects `userAgent` patches — see ADR 0010 (defaultSession
   * is shared with ElectronChromeExtensions; overriding its UA can break Web
   * Store install).
   */
  update(id, patch = {}) {
    const ident = this.get(id)
    if (!ident) return null

    const allowed = ['name', 'color', 'userAgent']
    const before = { ...ident }
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        if (key === 'userAgent' && ident.isDefault && patch.userAgent) {
          log.warn('identity-manager', 'refusing userAgent override on Default identity', {
            id, requested: patch.userAgent,
          })
          continue
        }
        ident[key] = patch[key] === '' ? null : patch[key]
      }
    }

    this._save()

    // Apply UA change to the live session if cached.
    if (
      Object.prototype.hasOwnProperty.call(patch, 'userAgent') &&
      this.sessionCache.has(id) &&
      !ident.isDefault
    ) {
      const ses = this.sessionCache.get(id)
      const ua = ident.userAgent || ''
      ses.setUserAgent(ua)
      log.info('identity-manager', 'live session UA updated', { id, ua: ua || '(default)' })
    }

    log.info('identity-manager', 'identity updated', {
      id, changedKeys: allowed.filter((k) =>
        Object.prototype.hasOwnProperty.call(patch, k) && before[k] !== ident[k],
      ),
    })

    return { ...ident }
  }

  remove(id) {
    const ident = this.get(id)
    if (!ident) return false
    if (ident.isDefault) {
      console.warn('[identity-manager] refusing to remove default identity')
      return false
    }
    this.identities = this.identities.filter((i) => i.id !== id)
    this.sessionCache.delete(id)
    this._save()
    // NOTE: partition data on disk is NOT cleared here — leave for Bloque 1.6.
    return true
  }

  // ---------- sessions ----------

  /**
   * Returns the Electron Session associated with this Identity, creating it
   * (via persist: partition) on first call and caching it thereafter.
   *
   * The 'default' identity uses session.defaultSession so that the
   * Chrome Web Store extensions registered in main.js work for it. Other
   * identities use isolated partitions; extension support for them is
   * deferred to Bloque 1.5.
   */
  getSession(id) {
    if (!id) id = this.getDefault().id

    if (this.sessionCache.has(id)) {
      return this.sessionCache.get(id)
    }

    const ident = this.get(id)
    let ses
    if (ident && ident.isDefault) {
      ses = session.defaultSession
    } else {
      ses = session.fromPartition(`persist:identity-${id}`, { cache: true })
      // Apply per-identity custom User-Agent for non-default identities.
      // ADR 0010: Default uses defaultSession (shared with extensions), so we
      // skip UA override there to keep Chrome Web Store install stable.
      if (ident && ident.userAgent) {
        ses.setUserAgent(ident.userAgent)
        log.debug('identity-manager', 'session created with custom UA', {
          id, ua: ident.userAgent,
        })
      }
    }

    this.sessionCache.set(id, ses)
    log.debug('identity-manager', 'session resolved', {
      id, cached: false, isDefault: !!(ident && ident.isDefault),
    })
    return ses
  }

  /**
   * Convenience: returns { identity, session } for a given id (or default).
   */
  resolve(id) {
    const ident = this.get(id) || this.getDefault()
    return { identity: ident, session: this.getSession(ident.id) }
  }
}

module.exports = { IdentityManager, IdentityCapError, MAX_IDENTITIES_FREE }
