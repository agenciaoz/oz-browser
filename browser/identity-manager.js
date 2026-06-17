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
const { EventEmitter } = require('events')
const { app, session } = require('electron')
const log = require('./logger')
// alpha.40: pure helpers extracted to keep this file under the LOC budget.
const { uuid, now, nowIso, normalizeTags, DEFAULT_COLORS } = require('./identity-utils')

// 1.5c: content script preload for auto-fill / auto-save. Resolved lazily —
// `app.getAppPath()` is only valid after `app.whenReady()`, so we defer the
// computation to first session-creation. Under electron-forge webpack the
// path is `<repo>/.webpack/main/../../browser/preload-content.js`; in a
// packaged build it lives under the .asar at `app.getAppPath() + /browser/...`.
let _contentPreloadPath = null
function contentPreloadPath() {
  if (_contentPreloadPath) return _contentPreloadPath
  // v1.4.4: load the WEBPACK-BUNDLED preload (with its `./site-templates`
  // sibling inlined). Raw preload-content.js fails silently in sandboxed
  // mode because `require('./site-templates')` is rejected by Electron's
  // sandbox loader (smoke 2026-05-15). The bundle is produced by
  // `scripts/bundle-preloads.js` (npm prestart + prepackage) and lands in
  // `browser/.bundled/preload-content.bundled.js`.
  _contentPreloadPath = path.join(
    app.getAppPath(),
    'browser',
    '.bundled',
    'preload-content.bundled.js',
  )
  return _contentPreloadPath
}

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

class IdentityManager extends EventEmitter {
  /**
   * D-3a — emits 'changed' after every successful CRUD mutation. The sync
   * engine (D-3b/c) listens to this to enqueue uploads / tombstones.
   * Listeners must be defensive — a throw is caught and logged but does
   * NOT roll back the mutation.
   *
   * Event payload shapes:
   *   { op: 'create',  recordType: 'identity', recordId, record, updatedAt }
   *   { op: 'update',  recordType: 'identity', recordId, record, updatedAt }
   *   { op: 'delete',  recordType: 'identity', recordId, deletedAt }
   */
  constructor() {
    super()
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
      const createdMs = now()
      this.identities.unshift({
        id: 'default',
        name: 'Default',
        color: '#8a8a8a',
        fingerprintSeed: uuid(),
        createdAt: createdMs,
        // D-3a: ISO timestamp used by the sync engine for LWW comparisons.
        updatedAt: nowIso(),
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
      // alpha.40: ensure tags[] exists on legacy identities.
      if (!Array.isArray(ident.tags)) {
        ident.tags = []
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

    // D-3a: defensive backfill — legacy identities written before the sync
    // engine landed have no `updatedAt`. Default to ISO(createdAt) when
    // available, otherwise current time. This keeps LWW deterministic for
    // every record on first sync.
    let updatedAtBackfilled = 0
    for (const ident of this.identities) {
      if (typeof ident.updatedAt !== 'string') {
        const seed =
          typeof ident.createdAt === 'number'
            ? new Date(ident.createdAt).toISOString()
            : nowIso()
        ident.updatedAt = seed
        updatedAtBackfilled += 1
      }
    }
    if (updatedAtBackfilled > 0) {
      log.warn('identity-manager', 'backfilled identities without updatedAt', {
        count: updatedAtBackfilled,
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

  create({
    name = 'New Identity',
    color,
    userAgent,
    workspaceId,
    fingerprintSeed,
    tags,
  } = {}) {
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

    const createdMs = now()
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
      createdAt: createdMs,
      // D-3a: sync engine uses this for LWW conflict resolution.
      updatedAt: nowIso(),
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
      // alpha.40: free-text labels for grouping/filtering (Ghost parity).
      tags: normalizeTags(tags),
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
    // D-3a: announce to the sync engine so it can enqueue an upsert.
    this._emitChanged({
      op: 'create',
      recordType: 'identity',
      recordId: identity.id,
      record: { ...identity },
      updatedAt: identity.updatedAt,
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
    let mutated = false
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
        const next = patch[key] === '' ? null : patch[key]
        if (ident[key] !== next) {
          ident[key] = next
          mutated = true
        }
      }
    }

    // alpha.40: tags (array) — normalized + compared separately from the
    // scalar whitelist above.
    if (Object.prototype.hasOwnProperty.call(patch, 'tags')) {
      const nextTags = normalizeTags(patch.tags)
      if (JSON.stringify(ident.tags || []) !== JSON.stringify(nextTags)) {
        ident.tags = nextTags
        mutated = true
      }
    }

    // D-3a: only stamp updatedAt when a whitelisted field actually changed,
    // so no-op updates don't generate spurious sync traffic.
    if (mutated) {
      ident.updatedAt = nowIso()
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

    // D-3a: only emit when something actually changed, mirroring the
    // mutated-guard above.
    if (mutated) {
      this._emitChanged({
        op: 'update',
        recordType: 'identity',
        recordId: id,
        record: { ...ident },
        updatedAt: ident.updatedAt,
      })
    }

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
    const deletedAt = nowIso()
    this.identities = this.identities.filter((i) => i.id !== id)
    this.sessionCache.delete(id)
    this._save()
    // H3a: notify the host to remove this id from workspace.identityIds[].
    this._fireWorkspaceSync('remove', id, wsId, null)
    // D-3a: announce a tombstone so the sync engine can publish it remotely.
    this._emitChanged({
      op: 'delete',
      recordType: 'identity',
      recordId: id,
      deletedAt,
    })
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
    // D-3a: stamp updatedAt so the sync engine picks up the move.
    ident.updatedAt = nowIso()
    this._save()
    log.info('identity-manager', 'identity moved to workspace', {
      id,
      from: fromWorkspaceId,
      to: targetWorkspaceId,
    })
    // H3a: notify host to update both source + target workspace.identityIds[].
    this._fireWorkspaceSync('move', id, fromWorkspaceId, targetWorkspaceId)
    // D-3a: a workspace move is a content change → emit 'changed'.
    this._emitChanged({
      op: 'update',
      recordType: 'identity',
      recordId: id,
      record: { ...ident },
      updatedAt: ident.updatedAt,
    })
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
    const before = !!ident.locked
    const next = !!locked
    ident.locked = next
    // D-3a: only stamp + emit when the flag actually flipped. Idempotent
    // setLocked(true) calls shouldn't generate sync traffic.
    if (before !== next) {
      ident.updatedAt = nowIso()
    }
    this._save()
    log.info('identity-manager', 'identity lock toggled', {
      id,
      name: ident.name,
      locked: next,
    })
    if (before !== next) {
      this._emitChanged({
        op: 'update',
        recordType: 'identity',
        recordId: id,
        record: { ...ident },
        updatedAt: ident.updatedAt,
      })
    }
    return { ...ident }
  }

  /**
   * D-3a: internal helper that announces a CRUD mutation to listeners (the
   * sync engine in D-3b/c). Mirrors BackupManager's snapshot-created
   * pattern — the emit is wrapped in try/catch so a faulty listener cannot
   * break the mutation path that already persisted state to disk.
   */
  _emitChanged(payload) {
    try {
      this.emit('changed', payload)
    } catch (err) {
      log.warn('identity-manager', "'changed' listener threw", {
        op: payload && payload.op,
        recordId: payload && payload.recordId,
        message: err.message,
      })
    }
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
   *
   * v1.6.3 CRITICAL FIX: when the hook is installed AFTER sessions have
   * already been cached (which happens at every boot — AntiLogout.install()
   * pre-creates all per-identity sessions before main.js wires ProxyManager),
   * the hook would never fire for those cached sessions, leaving them with
   * 'direct://' as their proxy rule (= REAL IP LEAK). The fix: when a new
   * hook is set, retroactively apply it to every session already in the
   * cache. Idempotent — session.setProxy() can be called repeatedly with
   * the same rules safely.
   */
  setProxyResolutionHook(fn) {
    this._proxyResolutionHook = fn
    log.info('identity-manager', 'proxy resolution hook installed', {
      installed: typeof fn === 'function',
      cachedSessionsToRetroApply: this.sessionCache ? this.sessionCache.size : 0,
    })
    if (typeof fn !== 'function') return
    // Retro-apply to every session already cached. Without this, identities
    // whose sessions were created by AntiLogout / FingerprintEngine pre-warm
    // at boot leak the user's real IP because the hook ran AFTER caching.
    if (this.sessionCache && this.sessionCache.size > 0) {
      let applied = 0
      let errored = 0
      for (const [id, ses] of this.sessionCache.entries()) {
        try {
          fn(id, ses)
          applied++
        } catch (err) {
          errored++
          log.warn('identity-manager', 'retro-apply proxy hook failed', {
            id,
            message: err.message,
          })
        }
      }
      log.info('identity-manager', 'retro-applied proxy hook to cached sessions', {
        applied,
        errored,
        totalCached: this.sessionCache.size,
      })
    }
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
