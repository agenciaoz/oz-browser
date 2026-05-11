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

// 1.5c: content script preload for auto-fill / auto-save. Resolved lazily —
// `app.getAppPath()` is only valid after `app.whenReady()`, so we defer the
// computation to first session-creation. Under electron-forge webpack the
// path is `<repo>/.webpack/main/../../browser/preload-content.js`; in a
// packaged build it lives under the .asar at `app.getAppPath() + /browser/...`.
let _contentPreloadPath = null
function contentPreloadPath() {
  if (_contentPreloadPath) return _contentPreloadPath
  // 1) under electron-forge dev, __dirname = '<repo>/.webpack/main' (after
  // bundle), so '..' twice lands at repo root.
  const fromAppPath = path.join(app.getAppPath(), 'browser', 'preload-content.js')
  // 2) packaged: same join works (asar root). The webpack-mangled __dirname is
  // unreliable as a fallback, so trust app.getAppPath().
  _contentPreloadPath = fromAppPath
  return _contentPreloadPath
}

const DEFAULT_COLORS = [
  '#5b8def',
  '#ff7a45',
  '#36b37e',
  '#ffab00',
  '#9c5cf2',
  '#e85a8c',
  '#00b8d9',
  '#f15a5a',
  '#36b37e',
  '#ff5630',
]

// Identity cap. Default behavior in 1.5f: NO CAP (Jose's use case = 50+
// social media accounts, internal/paid use). Free tier (3 identities) is now
// OPT-IN via `OZ_TIER=free` — useful for screenshotting the upgrade prompt
// during marketing or for free-tier dev builds. When billing arrives (Etapa
// 5), this is replaced by an entitlement check from auth-client.js — the
// `IS_PAID_TIER` flag stays as the runtime-bypass for power users.
const MAX_IDENTITIES_FREE = 3
const IS_FREE_TIER = process.env.OZ_TIER === 'free'
const IS_PAID_TIER = !IS_FREE_TIER

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
        locked: false,
        // H3a: every identity belongs to exactly one workspace. Default lives
        // in 'general' (ADR 0023 D2).
        workspaceId: 'general',
      })
      this._save()
    }

    // H3a: defensive backfill — legacy data without workspaceId resolves to
    // 'general'. This avoids needing an explicit migration step (Jose
    // authorized wipe fresh on H3a kickoff). The defensive path stays for
    // any future edge case where pre-H3a JSON sneaks back in.
    let backfilled = 0
    for (const ident of this.identities) {
      if (!ident.workspaceId) {
        ident.workspaceId = 'general'
        backfilled += 1
      }
    }
    if (backfilled > 0) {
      log.warn('identity-manager', 'backfilled identities without workspaceId', {
        count: backfilled,
        defaultedTo: 'general',
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

  create({ name = 'New Identity', color, userAgent, workspaceId, fingerprintSeed } = {}) {
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
      // C-3: caller can pass an explicit fingerprintSeed (e.g. identity-clone
      // when "Same fingerprint" is checked — clones the parent's seed so the
      // new identity gets the SAME blueprint/UA/screen/timezone via
      // FingerprintEngine's deterministic SHA256-stream RNG). If omitted, a
      // fresh uuid() ensures every new identity gets its own perfil.
      fingerprintSeed: fingerprintSeed || uuid(),
      createdAt: now(),
      userAgent: userAgent || null,
      // H2: lock = "no me borres por accidente". Defaults to false. Only
      // remove() and clearBrowsingData() reject when locked — rename, color
      // and UA edits stay allowed (Jose-confirmed scope: "sólo destructivo").
      locked: false,
      // H3a: every identity belongs to exactly 1 workspace. Caller (handler)
      // typically passes the focused window's workspaceId; defaults to
      // 'general' if missing — the host (Browser) is responsible for routing
      // identities to the right workspace by the time they reach create().
      workspaceId: workspaceId || 'general',
    }
    this.identities.push(identity)
    this._save()
    log.info('identity-manager', 'identity created', {
      id: identity.id,
      name: identity.name,
      workspaceId: identity.workspaceId,
      total: this.identities.length,
    })
    // H3a: notify the host so it can sync workspace.identityIds[]. Loose
    // coupling — IdentityManager doesn't know about WorkspaceManager.
    this._fireWorkspaceSync('add', identity.id, null, identity.workspaceId)
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
          log.warn(
            'identity-manager',
            'refusing userAgent override on Default identity',
            {
              id,
              requested: patch.userAgent,
            },
          )
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
      log.info('identity-manager', 'live session UA updated', {
        id,
        ua: ua || '(default)',
      })
    }

    log.info('identity-manager', 'identity updated', {
      id,
      changedKeys: allowed.filter(
        (k) => Object.prototype.hasOwnProperty.call(patch, k) && before[k] !== ident[k],
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
    // H2: locked identities reject remove. Caller must unlock first.
    if (ident.locked) {
      log.warn('identity-manager', 'refusing to remove locked identity', {
        id,
        name: ident.name,
      })
      return false
    }
    const wsId = ident.workspaceId
    this.identities = this.identities.filter((i) => i.id !== id)
    this.sessionCache.delete(id)
    this._save()
    // H3a: notify the host to remove this id from workspace.identityIds[].
    this._fireWorkspaceSync('remove', id, wsId, null)
    // NOTE: partition data on disk is NOT cleared here — leave for Bloque 1.6.
    return true
  }

  // ---------- H3a: per-workspace identity scoping ----------

  /**
   * H3a — list identities belonging to a workspace. Returns array (possibly
   * empty). Default identity is returned only when wsId === 'general'.
   */
  listByWorkspace(wsId) {
    return this.identities.filter((i) => i.workspaceId === wsId).map((i) => ({ ...i }))
  }

  /**
   * H3a — move an identity to a different workspace. Locked identities
   * reject. Default identity is pinned to 'general' (ADR 0023 D2) and rejects
   * any move. Returns updated identity or { ok: false, reason }.
   */
  moveToWorkspace(id, targetWorkspaceId) {
    const ident = this.identities.find((i) => i.id === id)
    if (!ident) return { ok: false, reason: 'identity-not-found', id }
    if (ident.isDefault) {
      log.warn('identity-manager', 'refusing to move default identity', {
        id,
        targetWorkspaceId,
      })
      return { ok: false, reason: 'default-pinned-to-general', id }
    }
    if (ident.locked) {
      log.warn('identity-manager', 'refusing to move locked identity', {
        id,
        targetWorkspaceId,
      })
      return { ok: false, reason: 'identity-locked', id }
    }
    const fromWorkspaceId = ident.workspaceId
    if (fromWorkspaceId === targetWorkspaceId) {
      return { ok: true, noop: true, id, workspaceId: targetWorkspaceId }
    }
    ident.workspaceId = targetWorkspaceId
    this._save()
    log.info('identity-manager', 'identity moved to workspace', {
      id,
      from: fromWorkspaceId,
      to: targetWorkspaceId,
    })
    // H3a: notify host to update both source + target workspace.identityIds[].
    this._fireWorkspaceSync('move', id, fromWorkspaceId, targetWorkspaceId)
    return { ok: true, id, from: fromWorkspaceId, to: targetWorkspaceId }
  }

  /**
   * H3a — register a hook called after every identity create / remove / move
   * so the host (Browser) can sync workspace.identityIds[]. Loose coupling —
   * IdentityManager knows nothing about WorkspaceManager. Hook signature:
   *   (op: 'add'|'remove'|'move', identityId, fromWsId|null, toWsId|null)
   * Pass null to clear. Single hook (replaces) — additional sync sites should
   * route through the host.
   */
  setWorkspaceSyncHook(fn) {
    this._workspaceSyncHook = typeof fn === 'function' ? fn : null
    log.info('identity-manager', 'workspace sync hook installed', {
      installed: !!this._workspaceSyncHook,
    })
  }

  _fireWorkspaceSync(op, identityId, fromWsId, toWsId) {
    if (!this._workspaceSyncHook) return
    try {
      this._workspaceSyncHook(op, identityId, fromWsId, toWsId)
    } catch (err) {
      log.warn('identity-manager', 'workspace sync hook failed', {
        op,
        identityId,
        message: err.message,
      })
    }
  }

  /**
   * H2: toggle the lock flag on an identity. Idempotent. Default identity may
   * be locked too (it's already non-removable, but locking also blocks
   * clearBrowsingData on it). Returns the updated identity or null.
   */
  setLocked(id, locked) {
    const ident = this.identities.find((i) => i.id === id)
    if (!ident) return null
    ident.locked = !!locked
    this._save()
    log.info('identity-manager', 'identity lock toggled', {
      id,
      name: ident.name,
      locked: !!locked,
    })
    return { ...ident }
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
          id,
          ua: ident.userAgent,
        })
      }
    }

    // 1.5c: register content script preload for auto-fill / auto-save.
    // The preload doesn't know identityId — main resolves it via
    // identityIdForSession(event.sender.session) on each IPC call. This way
    // a compromised renderer cannot impersonate another identity.
    try {
      const preloadPath = contentPreloadPath()
      // Electron 30+: registerPreloadScript is the modern API, setPreloads is
      // deprecated but still works. Use the new API if available.
      if (typeof ses.registerPreloadScript === 'function') {
        ses.registerPreloadScript({
          type: 'frame',
          id: 'oz-content-preload',
          filePath: preloadPath,
        })
      } else {
        ses.setPreloads([preloadPath])
      }
      log.debug('identity-manager', 'content preload registered', {
        id,
        path: preloadPath,
      })
    } catch (err) {
      log.warn('identity-manager', 'setPreloads failed', {
        id,
        message: err.message,
      })
    }

    this.sessionCache.set(id, ses)

    // 1.8b: apply the identity's resolved proxy (from ProxyAssignment) to the
    // session as soon as it's created. Optional — only fires if the host has
    // wired this hook via setProxyResolutionHook(). Keeps identity-manager
    // unaware of ProxyManager's existence (loose coupling).
    if (this._proxyResolutionHook) {
      try {
        this._proxyResolutionHook(id, ses)
      } catch (err) {
        log.warn('identity-manager', 'proxy resolution hook failed', {
          id,
          message: err.message,
        })
      }
    }

    // 1.9b: also fire any registered session init hooks (FingerprintEngine
    // + future cross-cutting setup). Hooks run in registration order. A
    // throw in one hook does NOT block the rest.
    if (this._sessionInitHooks && this._sessionInitHooks.length > 0) {
      for (const hook of this._sessionInitHooks) {
        try {
          hook(id, ses)
        } catch (err) {
          log.warn('identity-manager', 'session init hook failed', {
            id,
            message: err.message,
          })
        }
      }
    }
    log.debug('identity-manager', 'session resolved', {
      id,
      cached: false,
      isDefault: !!(ident && ident.isDefault),
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

  /**
   * 1.8b: register a hook called after each session creation so the host can
   * apply per-identity proxy settings without IdentityManager knowing about
   * ProxyManager. Pass `null` to clear.
   *
   * Signature: `(identityId, session) => void` — the host typically calls
   * proxyAssignment.resolve(...) and session.setProxy(...).
   *
   * 1.9b: also used to wire FingerprintEngine. Multiple callers OK — see
   * addSessionInitHook for the multi-hook variant. setProxyResolutionHook
   * REPLACES the single hook (legacy behavior); addSessionInitHook APPENDS.
   */
  setProxyResolutionHook(fn) {
    this._proxyResolutionHook = fn
    log.info('identity-manager', 'proxy resolution hook installed', {
      installed: typeof fn === 'function',
    })
  }

  /**
   * 1.9b: append a hook that runs after each session creation. Multiple
   * hooks chain in registration order. Use for cross-cutting per-session
   * setup (proxy assignment, fingerprint UA, etc) without coupling
   * IdentityManager to those subsystems.
   *
   * Signature: `(identityId, session) => void`
   */
  addSessionInitHook(fn) {
    if (typeof fn !== 'function') return false
    if (!this._sessionInitHooks) this._sessionInitHooks = []
    this._sessionInitHooks.push(fn)
    log.info('identity-manager', 'session init hook appended', {
      total: this._sessionInitHooks.length,
    })
    return true
  }

  /**
   * Reverse lookup: given an Electron Session object, return the identity id
   * it belongs to (or null if it doesn't match any cached session). Used by
   * 1.5c IPC handlers to deduce identityId from event.sender.session — this
   * way the renderer cannot impersonate a different identity by passing a
   * fake identityId arg.
   */
  identityIdForSession(sessionObj) {
    if (!sessionObj) return null
    for (const [id, cached] of this.sessionCache) {
      if (cached === sessionObj) return id
    }
    // defaultSession may not be in cache yet — check explicitly.
    const def = this.getDefault()
    if (def && session.defaultSession === sessionObj) return def.id
    return null
  }
}

module.exports = { IdentityManager, IdentityCapError, MAX_IDENTITIES_FREE }
