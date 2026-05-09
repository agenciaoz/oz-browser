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

class WorkspaceManager {
  constructor(opts = {}) {
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
      updatedAt: t,
      tabSpecs: [],
      activeTabId: null,
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
    return this.workspaces.map((w) => ({ ...w, tabSpecs: [...w.tabSpecs] }))
  }

  /** Workspaces that are not archived. UI lists these by default. */
  listActive() {
    return this.list().filter((w) => !w.isArchived)
  }

  get(id) {
    const w = this.workspaces.find((x) => x.id === id)
    return w ? { ...w, tabSpecs: [...w.tabSpecs] } : null
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
      updatedAt: t,
      tabSpecs: [],
      activeTabId: null,
    }
    this.workspaces.push(ws)
    this._save()
    log.info('workspace-manager', 'workspace created', {
      id: ws.id,
      name: ws.name,
      total: this.workspaces.length,
    })
    return { ...ws, tabSpecs: [] }
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
    for (const key of allowed) {
      if (Object.hasOwn(patch, key)) {
        if (key === 'quickTabsMode' && !QUICK_TAB_MODES.includes(patch[key])) {
          log.warn('workspace-manager', 'invalid quickTabsMode ignored', {
            id,
            requested: patch[key],
          })
          continue
        }
        ws[key] = patch[key]
      }
    }
    ws.updatedAt = now()
    this._save()
    log.info('workspace-manager', 'workspace updated', {
      id,
      changedKeys: allowed.filter((k) => Object.hasOwn(patch, k) && before[k] !== ws[k]),
    })
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
      updatedAt: t,
      activeTabId: null,
      tabSpecs: src.tabSpecs.map((ts) => ({ ...ts, id: uuid() })),
    }
    this.workspaces.push(copy)
    this._save()
    log.info('workspace-manager', 'workspace duplicated', {
      from: id,
      to: copy.id,
      tabsCopied: copy.tabSpecs.length,
    })
    return { ...copy, tabSpecs: [...copy.tabSpecs] }
  }

  archive(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    if (ws.isDefault) {
      log.warn('workspace-manager', 'refusing to archive default workspace', { id })
      return false
    }
    ws.isArchived = true
    ws.updatedAt = now()
    this._save()
    log.info('workspace-manager', 'workspace archived', { id })
    return true
  }

  restore(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    ws.isArchived = false
    ws.updatedAt = now()
    this._save()
    log.info('workspace-manager', 'workspace restored', { id })
    return true
  }

  freeze(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    ws.isFrozen = true
    ws.updatedAt = now()
    this._save()
    log.info('workspace-manager', 'workspace frozen', { id })
    return true
  }

  unfreeze(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    ws.isFrozen = false
    ws.updatedAt = now()
    this._save()
    log.info('workspace-manager', 'workspace unfrozen', { id })
    return true
  }

  remove(id) {
    const ws = this._getRaw(id)
    if (!ws) return false
    if (ws.isDefault) {
      log.warn('workspace-manager', 'refusing to remove default workspace', { id })
      return false
    }
    this.workspaces = this.workspaces.filter((w) => w.id !== id)
    this._save()
    log.info('workspace-manager', 'workspace removed', { id })
    return true
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
    ws.updatedAt = now()
    this._save()
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
    ws.updatedAt = now()
    this._save()
    return true
  }

  removeTabSpec(id, tabId) {
    const ws = this._getRaw(id)
    if (!ws) return false
    const before = ws.tabSpecs.length
    ws.tabSpecs = ws.tabSpecs.filter((ts) => ts.id !== tabId)
    if (ws.tabSpecs.length === before) return false
    ws.updatedAt = now()
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
}

module.exports = {
  WorkspaceManager,
  DEFAULT_WORKSPACE_ID,
  QUICK_TAB_MODES,
  DEFAULT_QUICK_TAB_MODE,
}
