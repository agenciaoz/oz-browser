// OZ Browser — Workspace Manager
//
// Qué hace: CRUD de Workspaces + persistencia + freeze/archive/duplicate.
// Doc: docs/modules/workspace-manager.md
// ADR: docs/architecture/0015-workspace-model.md
//
// Exports: WorkspaceManager (class), DEFAULT_WORKSPACE_ID
// IPC: registrado en ipc-handlers.js como oz:workspaces:*
//
// Storage: ~/Library/Application Support/<appName>/workspaces.json
//
// Modelo (cada workspace es un objeto plano, serializable):
//   {
//     id, name, color, isDefault, isArchived, isFrozen, quickTabsMode,
//     createdAt, updatedAt,
//     tabSpecs: [{ id, identityId, url, title, favicon?, pinned? }],
//     activeTabId  // last selected tab id while this workspace was active
//   }
//
// Las tabs vivas (WebContentsView en RAM) viven en TabbedBrowserWindow.tabs
// SOLO mientras el workspace está activo en alguna ventana. Al cambiar de
// workspace serializamos la lista a tabSpecs (ver TabbedBrowserWindow.switchToWorkspace
// en el bloque 1.4b) y destruimos las views — la SQLite per-identity en disk
// preserva cookies/storage, así que reabrir el workspace recrea sesión intacta.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { app } = require('electron')
const log = require('./logger')

const DEFAULT_WORKSPACE_ID = 'general'
const DEFAULT_COLORS = [
  '#5b8def',
  '#36b37e',
  '#ff7a45',
  '#ffab00',
  '#9c5cf2',
  '#e85a8c',
  '#00b8d9',
]

const QUICK_TAB_MODES = ['load-all', 'one-by-one', 'on-click', 'on-click-confirm']
const DEFAULT_QUICK_TAB_MODE = 'on-click'

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

// D-4: ISO 8601 timestamp for the sync layer. createdAt stays as ms-since-epoch
// (legacy compatibility); updatedAt is now ISO so the sync engine can do
// lex / Date.parse comparisons consistently across devices.
function nowIso() {
  return new Date().toISOString()
}

class WorkspaceManager extends EventEmitter {
  /**
   * D-4 — emits 'changed' after every metadata mutation (create/update/
   * archive/restore/freeze/unfreeze/remove/duplicate/addIdentity/
   * removeIdentity). Tab-spec mutations (setTabSpecs/appendTabSpec/
   * removeTabSpec/setActiveTabId) do NOT emit — tab state is local
   * session state, not shared team config (ADR 0026 §1 carveout).
   *
   * Event payload shapes (mirrors IdentityManager):
   *   { op: 'create',  recordType: 'workspace', recordId, record, updatedAt }
   *   { op: 'update',  recordType: 'workspace', recordId, record, updatedAt }
   *   { op: 'delete',  recordType: 'workspace', recordId, deletedAt }
   */
  constructor(opts = {}) {
    super()
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'workspaces.json')
    this.workspaces = []

    // Throttle for save() — coalesces bursts of tabSpec updates during heavy
    // navigation. Flushed on switch and on app quit (see main.js).
    this._saveTimer = null
    this._dirty = false
    this._saveDelayMs = opts.saveDelayMs || 0 // 0 = synchronous (default; switch logic enables throttling later)

    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.workspaces = JSON.parse(raw)
      }
    } catch (err) {
      console.error('[workspace-manager] failed to load workspaces.json:', err)
      this.workspaces = []
    }

    // Ensure the Default workspace exists (always-present, non-deletable).
    if (!this.workspaces.some((w) => w.isDefault)) {
      this.workspaces.unshift(this._buildDefault())
      this._saveNow()
    }

    // H3a: defensive backfill — legacy data without identityIds[] resolves to
    // []. Avoids needing an explicit migration step. The host (Browser)
    // recomputes identityIds[] from IdentityManager at boot for accuracy
    // (this just guarantees the field exists).
    let backfilled = 0
    for (const ws of this.workspaces) {
      if (!Array.isArray(ws.identityIds)) {
        ws.identityIds = []
        backfilled += 1
      }
    }
    if (backfilled > 0) {
      log.warn('workspace-manager', 'backfilled workspaces without identityIds', {
        count: backfilled,
      })
      this._saveNow()
    }

    // D-4: backfill updatedAt to ISO. Legacy records have ms-since-epoch
    // (number); coerce to ISO for sync LWW comparisons. Missing field →
    // fall back to ISO(createdAt) when available, otherwise nowIso().
    let isoBackfilled = 0
    for (const ws of this.workspaces) {
      if (typeof ws.updatedAt === 'number') {
        ws.updatedAt = new Date(ws.updatedAt).toISOString()
        isoBackfilled += 1
      } else if (typeof ws.updatedAt !== 'string') {
        const seed =
          typeof ws.createdAt === 'number'
            ? new Date(ws.createdAt).toISOString()
            : nowIso()
        ws.updatedAt = seed
        isoBackfilled += 1
      }
    }
    if (isoBackfilled > 0) {
      log.warn('workspace-manager', 'backfilled workspaces to ISO updatedAt', {
        count: isoBackfilled,
      })
      this._saveNow()
    }
  }

  _buildDefault() {
    const t = now()
    return {
      id: DEFAULT_WORKSPACE_ID,
      name: 'General Browsing',
      color: '#8a8a8a',
      isDefault: true,
      isArchived: false,
      isFrozen: false,
      quickTabsMode: DEFAULT_QUICK_TAB_MODE,
      createdAt: t,
      // D-4: ISO timestamp used by the sync engine for LWW.
      updatedAt: nowIso(),
      tabSpecs: [],
      activeTabId: null,
      // H3a: identities belonging to this workspace (ADR 0023 D1).
      identityIds: [],
    }
  }

  _saveNow() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.workspaces, null, 2), 'utf-8')
      this._dirty = false
    } catch (err) {
      console.error('[workspace-manager] failed to save workspaces.json:', err)
    }
  }

  /**
   * Schedule a save. If saveDelayMs > 0, debounces; otherwise saves synchronously.
   * Used by the switch logic (1.4b) to throttle high-frequency tabSpec writes.
   */
  _save() {
    if (this._saveDelayMs <= 0) {
      this._saveNow()
      return
    }
    this._dirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this._dirty) this._saveNow()
    }, this._saveDelayMs)
  }

  /** Flush any pending throttled save synchronously. Called on app quit. */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this._dirty) this._saveNow()
  }

  // ---------- CRUD ----------

  list() {
    return this.workspaces.map((w) => ({
      ...w,
      tabSpecs: [...w.tabSpecs],
      identityIds: [...(w.identityIds || [])],
    }))
  }

  /** Workspaces that are not archived. UI lists these by default. */
  listActive() {
    return this.list().filter((w) => !w.isArchived)
  }

  get(id) {
    const w = this.workspaces.find((x) => x.id === id)
    return w
      ? { ...w, tabSpecs: [...w.tabSpecs], identityIds: [...(w.identityIds || [])] }
      : null
  }

  /** Internal mutable handle — used by patch helpers. Not for export. */
  _getRaw(id) {
    return this.workspaces.find((x) => x.id === id) || null
  }

  getDefault() {
    return this.get(DEFAULT_WORKSPACE_ID) || this.list()[0]
  }

  create({ name = 'New Workspace', color, quickTabsMode } = {}) {
    const used = new Set(this.workspaces.map((w) => w.color))
    const pickedColor =
      color ||
      DEFAULT_COLORS.find((c) => !used.has(c)) ||
      DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]

    const t = now()
    const ws = {
      id: uuid(),
      name,
      color: pickedColor,
      isDefault: false,
      isArchived: false,
      isFrozen: false,
      quickTabsMode: QUICK_TAB_MODES.includes(quickTabsMode)
        ? quickTabsMode
        : DEFAULT_QUICK_TAB_MODE,
      createdAt: t,
      updatedAt: nowIso(),
      tabSpecs: [],
      activeTabId: null,
      // H3a: identities belonging to this workspace (ADR 0023 D1).
      identityIds: [],
    }
    this.workspaces.push(ws)
    this._save()
    log.info('workspace-manager', 'workspace created', {
      id: ws.id,
      name: ws.name,
      total: this.workspaces.length,
    })
    this._emitChanged({
      op: 'create',
      recordType: 'workspace',
      recordId: ws.id,
      record: { ...ws, tabSpecs: [], identityIds: [] },
      updatedAt: ws.updatedAt,
    })
    return { ...ws, tabSpecs: [], identityIds: [] }
  }

  /**
   * Generic patch update. Whitelisted fields only.
   * Frozen workspaces reject mutations (caller may unfreeze first).
   */
  update(id, patch = {}) {
    const ws = this._getRaw(id)
    if (!ws) return null
    if (ws.isFrozen) {
      log.warn('workspace-manager', 'refusing update on frozen workspace', { id })
      return null
    }

    const allowed = ['name', 'color', 'quickTabsMode']
    const before = { ...ws }
    let mutated = false
    for (const key of allowed) {
      if (Object.hasOwn(patch, key)) {
        if (key === 'quickTabsMode' && !QUICK_TAB_MODES.includes(patch[key])) {
          log.warn('workspace-manager', 'invalid quickTabsMode ignored', {
            id,
            requested: patch[key],
          })
          continue
        }
        if (ws[key] !== patch[key]) {
          ws[key] = patch[key]
          mutated = true
        }
      }
    }
    if (mutated) {
      ws.updatedAt = nowIso()
    }
    this._save()
    log.info('workspace-manager', 'workspace updated', {
      id,
      changedKeys: allowed.filter((k) => Object.hasOwn(patch, k) && before[k] !== ws[k]),
    })
    if (mutated) {
      this._emitChanged({
        op: 'update',
        recordType: 'workspace',
        recordId: id,
        record: { ...ws, tabSpecs: [...ws.tabSpecs] },
        updatedAt: ws.updatedAt,
      })
    }
    return { ...ws, tabSpecs: [...ws.tabSpecs] }
  }

  rename(id, name) {
    return this.update(id, { name })
  }

  setColor(id, color) {
    return this.update(id, { color })
  }

  /**
   * Deep clone a workspace. Tab specs come along (with fresh ids so the
   * runtime treats them as different tabs from the original). The duplicate
   * is never the Default and never frozen / archived.
   */
  duplicate(id) {
    const src = this._getRaw(id)
    if (!src) return null
    const t = now()
    const copy = {
      ...src,
      id: uuid(),
      name: `${src.name} (copy)`,
      isDefault: false,
      isArchived: false,
      isFrozen: false,
      createdAt: t,
      updatedAt: nowIso(),
      activeTabId: null,
      tabSpecs: src.tabSpecs.map((ts) => ({ ...ts, id: uuid() })),
      // H3a: duplicate is a fresh workspace — identities aren't copied
      // (D1 says 1 identity = 1 workspace; copying would violate that).
      // Caller can move identities in via the UI / API later.
      identityIds: [],
    }
    this.workspaces.push(copy)
    this._save()
    log.info('workspace-manager', 'workspace duplicated', {
      from: id,
      to: copy.id,
      tabsCopied: copy.tabSpecs.length,
    })
    this._emitChanged({
      op: 'create',
      recordType: 'workspace',
      recordId: copy.id,
      record: { ...copy, tabSpecs: [...copy.tabSpecs], identityIds: [] },
      updatedAt: copy.updatedAt,
    })
    return { ...copy, tabSpecs: [...copy.tabSpecs], identityIds: [] }
  }

  archive(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    if (ws.isDefault) {
      log.warn('workspace-manager', 'refusing to archive default workspace', { id })
      return false
    }
    const before = !!ws.isArchived
    ws.isArchived = true
    if (!before) ws.updatedAt = nowIso()
    this._save()
    log.info('workspace-manager', 'workspace archived', { id })
    if (!before) this._emitWs('update', ws)
    return true
  }

  restore(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    const before = !!ws.isArchived
    ws.isArchived = false
    if (before) ws.updatedAt = nowIso()
    this._save()
    log.info('workspace-manager', 'workspace restored', { id })
    if (before) this._emitWs('update', ws)
    return true
  }

  freeze(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    const before = !!ws.isFrozen
    ws.isFrozen = true
    if (!before) ws.updatedAt = nowIso()
    this._save()
    log.info('workspace-manager', 'workspace frozen', { id })
    if (!before) this._emitWs('update', ws)
    return true
  }

  unfreeze(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    const before = !!ws.isFrozen
    ws.isFrozen = false
    if (before) ws.updatedAt = nowIso()
    this._save()
    log.info('workspace-manager', 'workspace unfrozen', { id })
    if (before) this._emitWs('update', ws)
    return true
  }

  /**
   * H3a — D7: workspace remove with identities inside.
   *
   * Default behavior: rejects if the workspace has identities, returning
   * `{ ok: false, reason: 'has-identities', count: N, lockedCount: K }`.
   * The caller (UI) shows a dialog: "This will move N identities to Default.
   * Continue?" — when confirmed, the caller passes `{ cascade: true }`.
   *
   * With `cascade: true`: any locked identity blocks the whole remove
   * (`{ ok: false, reason: 'has-locked-identities', lockedCount }`). Otherwise
   * the host (Browser) cascade-moves all identities to 'general' via
   * IdentityManager.moveToWorkspace, then this method removes the empty ws.
   * The cascade is invoked through the workspaceCascadeHook so this manager
   * doesn't need to know about IdentityManager.
   *
   * Returns `true` (legacy boolean for backward compat with the simple
   * `false` rejection cases like Default protection) OR a structured
   * result object when D7 logic kicks in. Callers checking `=== true` keep
   * working when there are no identities. New callers can also `=== false`
   * for legacy reject paths or check `r.ok === false` for D7 reasons.
   */
  remove(id, options = {}) {
    const ws = this._getRaw(id)
    if (!ws) return false
    if (ws.isDefault) {
      log.warn('workspace-manager', 'refusing to remove default workspace', { id })
      return false
    }
    const identityIds = Array.isArray(ws.identityIds) ? [...ws.identityIds] : []
    if (identityIds.length > 0) {
      // The host installs a hook that returns { lockedCount, identities[] }
      // for the given workspace. Without the hook we can't know which are
      // locked, so we conservatively reject without cascade.
      const cascade = !!options.cascade
      const probe = this._workspaceCascadeProbe
        ? this._workspaceCascadeProbe(id, identityIds)
        : { lockedCount: 0, movableCount: identityIds.length }
      if (!cascade) {
        return {
          ok: false,
          reason: 'has-identities',
          id,
          count: identityIds.length,
          lockedCount: probe.lockedCount || 0,
        }
      }
      if (probe.lockedCount > 0) {
        return {
          ok: false,
          reason: 'has-locked-identities',
          id,
          lockedCount: probe.lockedCount,
        }
      }
      // Run cascade: host moves all identities to 'general' synchronously.
      if (this._workspaceCascadeRun) {
        this._workspaceCascadeRun(id, identityIds, DEFAULT_WORKSPACE_ID)
      }
    }
    const deletedAt = nowIso()
    this.workspaces = this.workspaces.filter((w) => w.id !== id)
    this._save()
    log.info('workspace-manager', 'workspace removed', {
      id,
      cascadedIdentities: identityIds.length,
    })
    this._emitChanged({
      op: 'delete',
      recordType: 'workspace',
      recordId: id,
      deletedAt,
    })
    return true
  }

  // ---------- H3a: identityIds[] sync helpers ----------

  /** H3a — append identityId to workspace.identityIds[] (idempotent). */
  addIdentity(id, identityId) {
    const ws = this._getRaw(id)
    if (!ws) return false
    if (!Array.isArray(ws.identityIds)) ws.identityIds = []
    if (!ws.identityIds.includes(identityId)) {
      ws.identityIds.push(identityId)
      ws.updatedAt = nowIso()
      this._save()
      this._emitWs('update', ws)
    }
    return true
  }

  /** H3a — remove identityId from workspace.identityIds[] (idempotent). */
  removeIdentity(id, identityId) {
    const ws = this._getRaw(id)
    if (!ws) return false
    if (!Array.isArray(ws.identityIds)) {
      ws.identityIds = []
      return true
    }
    const before = ws.identityIds.length
    ws.identityIds = ws.identityIds.filter((iid) => iid !== identityId)
    if (ws.identityIds.length !== before) {
      ws.updatedAt = nowIso()
      this._save()
      this._emitWs('update', ws)
    }
    return true
  }

  /**
   * H3a — register hooks the host calls during workspace.remove() with
   * D7 cascade. Loose coupling — WorkspaceManager doesn't know about
   * IdentityManager.
   *
   *   probe(wsId, identityIds[]) -> { lockedCount, movableCount }
   *   run(wsId, identityIds[], destWorkspaceId) -> void  (moves identities)
   */
  setWorkspaceCascadeHooks({ probe, run }) {
    this._workspaceCascadeProbe = typeof probe === 'function' ? probe : null
    this._workspaceCascadeRun = typeof run === 'function' ? run : null
    log.info('workspace-manager', 'cascade hooks installed', {
      probeInstalled: !!this._workspaceCascadeProbe,
      runInstalled: !!this._workspaceCascadeRun,
    })
  }

  // ---------- tabSpecs management ----------
  // Used by the window switch logic (1.4b) to snapshot/restore tab state.

  /**
   * Replace the entire tabSpecs of a workspace. Frozen workspaces accept this
   * (it's the snapshot-on-switch path; freezing prevents user CRUD, not
   * runtime serialization).
   */
  setTabSpecs(id, tabSpecs, activeTabId) {
    const ws = this._getRaw(id)
    if (!ws) return false
    ws.tabSpecs = (tabSpecs || []).map((ts) => ({ ...ts }))
    if (activeTabId !== undefined) ws.activeTabId = activeTabId
    ws.updatedAt = nowIso()
    this._save()
    // D-4: tabSpec ops do NOT emit 'changed' — tab state is local session
    // state, not shared team config (ADR 0026 §1 carveout).
    return true
  }

  getTabSpecs(id) {
    const ws = this._getRaw(id)
    return ws ? ws.tabSpecs.map((ts) => ({ ...ts })) : []
  }

  appendTabSpec(id, spec) {
    const ws = this._getRaw(id)
    if (!ws) return false
    ws.tabSpecs.push({ ...spec })
    ws.updatedAt = nowIso()
    this._save()
    return true
  }

  removeTabSpec(id, tabId) {
    const ws = this._getRaw(id)
    if (!ws) return false
    const before = ws.tabSpecs.length
    ws.tabSpecs = ws.tabSpecs.filter((ts) => ts.id !== tabId)
    if (ws.tabSpecs.length === before) return false
    ws.updatedAt = nowIso()
    this._save()
    return true
  }

  setActiveTabId(id, tabId) {
    const ws = this._getRaw(id)
    if (!ws) return false
    ws.activeTabId = tabId
    this._save()
    return true
  }

  // ---------- D-4: 'changed' event helpers ----------

  /**
   * D-4: internal helper that announces a workspace mutation to listeners
   * (the sync engine). Wraps emit in try/catch so a faulty listener cannot
   * roll back state that's already on disk. Mirrors IdentityManager.
   */
  _emitChanged(payload) {
    try {
      this.emit('changed', payload)
    } catch (err) {
      log.warn('workspace-manager', "'changed' listener threw", {
        op: payload && payload.op,
        recordId: payload && payload.recordId,
        message: err.message,
      })
    }
  }

  /** Helper for the common op:'update' case — builds the payload from a ws record. */
  _emitWs(op, ws) {
    this._emitChanged({
      op,
      recordType: 'workspace',
      recordId: ws.id,
      record: { ...ws, tabSpecs: [...ws.tabSpecs] },
      updatedAt: ws.updatedAt,
    })
  }
}

module.exports = {
  WorkspaceManager,
  DEFAULT_WORKSPACE_ID,
  QUICK_TAB_MODES,
  DEFAULT_QUICK_TAB_MODE,
}
