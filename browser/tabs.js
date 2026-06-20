// OZ Browser — Tabs (lazy materialization)
//
// Qué hace: Tab + Tabs class. Lazy: WebContentsView/renderer NO existe hasta primer click.
// Doc: docs/modules/tabs.md
// ADR: docs/architecture/0002-lazy-tabs.md
//
// Exports: Tab, Tabs (classes)
// IPC: ninguno directo — usado por window-manager.js + ipc-handlers.js
//
// Stable tab IDs (UUID) — independientes de webContents.id que solo existe post-materialize.

const { EventEmitter } = require('events')
const { WebContentsView } = require('electron')
const crypto = require('crypto')
const log = require('./logger')

// Layout constants — must match CSS in browser/ui/webui.html.
// v1.8.2: FOOTER_HEIGHT added for the v1.8.1 quick-access bookmarks bar
// that sits at the bottom of the window (`.oz-qab` min-height 46px in
// webui.html). Without this, invalidateLayout() let the WebContentsView
// overlap the footer bar — visible as the content area covering the
// right side of the bookmarks bar.
const TOOLBAR_HEIGHT = 64
const SIDEBAR_WIDTH = 220
const FOOTER_HEIGHT = 46

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

class Tab extends EventEmitter {
  constructor(parentWindow, identityManager, opts = {}) {
    super()
    this.invalidateLayout = this.invalidateLayout.bind(this)

    this.id = opts.id || uuid()
    this.identityId = opts.identityId || null
    this.pendingUrl = opts.url || null
    this.title = opts.title || 'New Tab'
    this.favicon = opts.favicon || null
    this.pinned = !!opts.pinned // 1.4b: persisted in tabSpecs; UI in 1.7
    // H2: lock = "no me cierres por accidente". Persisted in tabSpecs. The
    // close handler rejects with reason='tab-locked'; closeOthers/closeToRight
    // skip locked tabs (just like pinned). Lock does NOT block navigation,
    // pin/mute, or duplication — it only protects against destruction.
    this.locked = !!opts.locked
    this.window = parentWindow
    this.identityManager = identityManager
    // 1.10d: timestamps for the discard daemon. createdAt is also used as
    // initial lastSelectedAt so brand-new tabs are NOT discardable until
    // they age out.
    this.createdAt = Date.now()
    this.lastSelectedAt = this.createdAt

    // Materialization state
    this.materialized = false
    this.view = null
    this.webContents = null
    this._wcvOpts = opts.wcvOpts || null // optional override for materialize()

    // If caller pre-supplied a webContents (e.g. window.open handler),
    // we materialize eagerly using that.
    if (opts.webContents) {
      this._materializeWith(opts.webContents)
    }
  }

  /**
   * Numeric webContents id (used by Chrome tabs API). null until materialized.
   */
  get webContentsId() {
    return this.webContents && !this.webContents.isDestroyed()
      ? this.webContents.id
      : null
  }

  isMaterialized() {
    return this.materialized
  }

  /**
   * Build the WebContentsView and attach to the parent window.
   * Idempotent — calling twice is a no-op.
   */
  materialize() {
    if (this.materialized) return

    // Build webPreferences with the Identity's session.
    const wcvOpts = { webPreferences: {}, ...(this._wcvOpts || {}) }
    if (this.identityManager) {
      const { identity, session } = this.identityManager.resolve(this.identityId)
      this.identityId = identity.id
      if (!wcvOpts.webPreferences) wcvOpts.webPreferences = {}
      if (!wcvOpts.webPreferences.session) {
        wcvOpts.webPreferences.session = session
      }
    }

    // Clean undefined props that crash the WebContentsView constructor.
    if (Object.hasOwn(wcvOpts, 'webContents') && !wcvOpts.webContents) {
      delete wcvOpts.webContents
    }
    if (Object.hasOwn(wcvOpts, 'webPreferences') && !wcvOpts.webPreferences) {
      delete wcvOpts.webPreferences
    }

    const view = new WebContentsView(wcvOpts)
    this._materializeWith(view.webContents, view)
  }

  _materializeWith(webContents, view = null) {
    if (!view) {
      // We were given a bare webContents (from window.open handler). We can't
      // build a WebContentsView around it after the fact, so this path is
      // deprecated — but supported for backward compat: caller should have
      // wrapped it in a WebContentsView already.
      // Safest: synthesize a view by constructing a new WebContentsView using
      // the existing webContents.
      view = new WebContentsView({ webContents })
    }

    this.view = view
    this.webContents = webContents
    this.window.contentView.addChildView(this.view)
    this.materialized = true

    // Wire metadata events
    this.webContents.on('page-title-updated', (_e, title) => {
      this.title = title
      this.emit('updated', this.serialize())
    })
    this.webContents.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons[0] || null
      this.emit('updated', this.serialize())
    })
    this.webContents.on('did-navigate', (_e, _url) => {
      this.pendingUrl = null
      this.emit('updated', this.serialize())
    })
    this.webContents.on('did-navigate-in-page', () => {
      this.emit('updated', this.serialize())
    })

    // If a URL was queued before materialization, load it now.
    if (this.pendingUrl) {
      const url = this.pendingUrl
      this.pendingUrl = null
      this.webContents.loadURL(url)
    }

    this.emit('materialized')
  }

  loadURL(url) {
    if (this.materialized) {
      return this.webContents.loadURL(url)
    }
    this.pendingUrl = url
    this.emit('updated', this.serialize())
    return Promise.resolve()
  }

  show() {
    if (!this.materialized) {
      this.materialize()
    }
    this.invalidateLayout()
    this.startResizeListener()
    this.view.setVisible(true)
  }

  hide() {
    if (!this.materialized) return // nothing to hide
    this.stopResizeListener()
    this.view.setVisible(false)
  }

  reload() {
    if (this.materialized) {
      this.webContents.reload()
    }
  }

  /**
   * 1.10d: discard the live WebContentsView to free RAM, but keep the tab in
   * the tabList so it stays visible in the sidebar/tabstrip. Re-selecting it
   * triggers materialize() which loads pendingUrl fresh.
   *
   * Snapshot the current URL into pendingUrl BEFORE destroying so re-load
   * navigates back to where the user was (not the original opener URL).
   */
  discard() {
    if (!this.materialized) return false
    if (this.webContents && !this.webContents.isDestroyed()) {
      const currentUrl = this.webContents.getURL()
      if (currentUrl) this.pendingUrl = currentUrl
    }
    this.hide()
    if (this.window && this.view) {
      this.window.contentView.removeChildView(this.view)
    }
    if (this.webContents && !this.webContents.isDestroyed()) {
      if (this.webContents.isDevToolsOpened()) {
        this.webContents.closeDevTools()
      }
      try {
        this.webContents.destroy()
      } catch (_e) {
        // best-effort
      }
    }
    this.webContents = null
    this.view = null
    this.materialized = false
    log.info('tabs', 'tab discarded', {
      tabId: this.id,
      identityId: this.identityId,
      pendingUrl: this.pendingUrl,
    })
    this.emit('updated', this.serialize())
    return true
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true

    if (!this.materialized) {
      // Lazy tab — nothing to clean up.
      this.window = undefined
      return
    }

    this.hide()

    if (this.window && this.view) {
      this.window.contentView.removeChildView(this.view)
    }
    this.window = undefined

    if (this.webContents && !this.webContents.isDestroyed()) {
      if (this.webContents.isDevToolsOpened()) {
        this.webContents.closeDevTools()
      }
      this.webContents.emit('destroyed')
      this.webContents.destroy()
    }

    this.webContents = undefined
    this.view = undefined
  }

  invalidateLayout() {
    if (!this.materialized || !this.window || this.window.isDestroyed()) return
    const [width, height] = this.window.getSize()
    const padding = 4
    // alpha.65: top inset is dynamic when the tabstrip wraps to multiple rows
    // (set by ipc-handlers `oz:chrome:setRows`). Falls back to the single-row
    // TOOLBAR_HEIGHT constant.
    const top = this.window.__ozTopInset || TOOLBAR_HEIGHT
    this.view.setBounds({
      x: SIDEBAR_WIDTH + padding,
      y: top,
      width: width - SIDEBAR_WIDTH - padding * 2,
      // v1.8.2: subtract FOOTER_HEIGHT so the WebContentsView doesn't
      // overlap the bookmarks bar at the bottom (v1.8.1).
      height: height - top - FOOTER_HEIGHT - padding,
    })
    this.view.setBorderRadius(8)
  }

  startResizeListener() {
    this.stopResizeListener()
    this.window.on('resize', this.invalidateLayout)
  }
  stopResizeListener() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.off('resize', this.invalidateLayout)
    }
  }

  /** JSON-serializable view of the tab for the OZ sidebar UI. */
  serialize() {
    return {
      id: this.id,
      identityId: this.identityId,
      url: this.pendingUrl || (this.webContents && this.webContents.getURL()) || '',
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
      locked: this.locked,
      isLoaded: this.materialized,
      webContentsId: this.webContentsId,
    }
  }

  /**
   * Workspace-friendly spec used by WorkspaceManager.setTabSpecs() during
   * switch (1.4b). Strips runtime-only fields (isLoaded, webContentsId).
   */
  toSpec() {
    return {
      id: this.id,
      identityId: this.identityId,
      url: this.pendingUrl || (this.webContents && this.webContents.getURL()) || '',
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
      locked: this.locked,
    }
  }
}

/**
 * H1 — closed-tab stack. Cap to keep memory bounded; FIFO eviction once full.
 * Per-window: stored on Tabs instance, lifecycle ends with Tabs.destroy.
 */
const CLOSED_TABS_STACK_CAP = 25

class Tabs extends EventEmitter {
  /** Ordered list of all tabs (lazy + materialized). */
  tabList = []
  /** Currently active tab (always materialized while selected). */
  selected = null
  /**
   * H1 — closed-tab stack for Cmd+Shift+T (reopenClosed). Push happens at
   * the user-initiated `tab-handlers.close` boundary, NOT at Tabs.remove
   * (audit caught: Tabs.remove fires on every workspace switch as part of
   * the snapshot/destroy loop, which would fill the stack with tabs from
   * the OLD workspace and Cmd+Shift+T would resurrect them in the NEW one).
   */
  closedTabsStack = []

  constructor(browserWindow, identityManager = null) {
    super()
    this.window = browserWindow
    this.identityManager = identityManager
  }

  /**
   * H1 — record a closed tab onto the stack. Caller is responsible for
   * filtering out non-user-initiated closes (workspace switch, identity
   * delete cascade, etc).
   */
  pushClosed(spec) {
    if (!spec || !spec.id) return
    this.closedTabsStack.push({ ...spec, closedAt: Date.now() })
    while (this.closedTabsStack.length > CLOSED_TABS_STACK_CAP) {
      this.closedTabsStack.shift()
    }
  }

  /**
   * H1 — pop the most recently closed tab spec. Returns the spec or null.
   * The caller is responsible for invoking `create()` with it.
   */
  popClosed() {
    if (this.closedTabsStack.length === 0) return null
    return this.closedTabsStack.pop()
  }

  destroy() {
    this.tabList.forEach((tab) => tab.destroy())
    this.tabList = []
    this.selected = undefined
    if (this.window) {
      this.window.destroy()
      this.window = undefined
    }
  }

  /** Find by stable OZ tab id. */
  get(tabId) {
    return this.tabList.find((tab) => tab.id === tabId)
  }

  /** Find by webContents.id (for Chrome tabs API integration). */
  getByWebContentsId(wcId) {
    return this.tabList.find((tab) => tab.webContentsId === wcId)
  }

  /**
   * Create a new tab.
   * @param {object} opts
   * @param {string} [opts.identityId] - bind tab to this Identity
   * @param {string} [opts.url] - URL to load (queued; only loads on materialize)
   * @param {string} [opts.title] - initial title shown in sidebar
   * @param {boolean} [opts.materialize] - force eager materialization (e.g. for Chrome ext API)
   * @param {object} [opts.webPreferences] - extra wcv opts (passed at materialize)
   * @param {WebContents} [opts.webContents] - pre-existing webContents (eager)
   */
  create(opts = {}) {
    const tab = new Tab(this.window, this.identityManager, {
      // 1.4b: id/title/favicon/pinned are propagated so we can recreate tabs
      // from a workspace's tabSpecs and preserve identity (sidebar selection,
      // active tab pointer, etc.) across switches.
      id: opts.id,
      identityId: opts.identityId,
      url: opts.url,
      title: opts.title,
      favicon: opts.favicon,
      pinned: opts.pinned,
      locked: opts.locked,
      webContents: opts.webContents,
      wcvOpts: opts.webPreferences ? { webPreferences: opts.webPreferences } : null,
    })

    this.tabList.push(tab)

    // Re-emit per-tab updates so callers can listen at the Tabs level.
    tab.on('updated', (info) => this.emit('tab-updated', tab, info))
    tab.on('materialized', () => this.emit('tab-materialized', tab))

    log.info('tabs', 'tab created', {
      tabId: tab.id,
      identityId: tab.identityId,
      url: opts.url || '(none)',
      source: opts.source || '(unknown)',
      eager: !!opts.materialize,
      total: this.tabList.length,
      windowId: this.window && this.window.id,
    })

    this.emit('tab-created', tab)

    if (opts.materialize) {
      tab.materialize()
    }

    return tab
  }

  remove(tabId) {
    const tabIndex = this.tabList.findIndex((tab) => tab.id === tabId)
    if (tabIndex < 0) {
      throw new Error(`Tabs.remove: unable to find tab.id = ${tabId}`)
    }
    const tab = this.tabList[tabIndex]
    this.tabList.splice(tabIndex, 1)
    tab.destroy()
    if (this.selected === tab) {
      this.selected = undefined
      const nextTab = this.tabList[tabIndex] || this.tabList[tabIndex - 1]
      if (nextTab) this.select(nextTab.id)
    }
    this.emit('tab-destroyed', tab)
    if (this.tabList.length === 0) {
      // Don't auto-destroy the window — user might create a new tab via UI.
    }
  }

  /**
   * Reordena una tab a una nueva posición (drag-and-drop del tabstrip).
   * Devuelve true si se movió. No materializa ni cambia la selección.
   */
  reorder(tabId, toIndex) {
    const from = this.tabList.findIndex((t) => t.id === tabId)
    if (from < 0) return false
    const { moveItem } = require('./ui/tabstrip-layout')
    this.tabList = moveItem(this.tabList, from, toIndex)
    this.emit('tabs-reordered', { tabId, toIndex })
    return true
  }

  select(tabId) {
    const tab = this.get(tabId)
    if (!tab) return
    if (this.selected) this.selected.hide()
    tab.show() // materializes if needed
    tab.lastSelectedAt = Date.now() // 1.10d: timestamp for discard daemon
    this.selected = tab
    this.emit('tab-selected', tab)
  }

  /** All tabs as JSON-serializable objects (for OZ sidebar UI). */
  serializeAll() {
    return this.tabList.map((t) => t.serialize())
  }

  /**
   * All tabs as workspace tabSpecs (no runtime fields). Used by
   * window-workspace.js to snapshot a window's state into a workspace
   * before destroying its WebContentsViews on switch (1.4b).
   */
  toSpecs() {
    return this.tabList.map((t) => t.toSpec())
  }
}

exports.Tabs = Tabs
exports.Tab = Tab
