// OZ Browser — Tabs with lazy loading
//
// Each Tab is a lightweight stub (~1 KB) until the user actually activates it.
// On first activation, materialize() creates the WebContentsView, attaches it
// to the window, and starts loading. Until then a tab consumes no renderer
// process — letting us hold 100+ tabs at minimal cost.
//
// Stable tab IDs (UUID) are assigned at construction so the UI can reference
// tabs that don't yet have a webContents. After materialization,
// `tab.webContentsId` returns the underlying webContents.id used by the
// Chrome tabs extension API.

const { EventEmitter } = require('events')
const { WebContentsView } = require('electron')
const crypto = require('crypto')

// Layout constants — must match CSS in browser/ui/webui.html
const TOOLBAR_HEIGHT = 64
const SIDEBAR_WIDTH = 220

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
    this.window = parentWindow
    this.identityManager = identityManager

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
    if (wcvOpts.hasOwnProperty('webContents') && !wcvOpts.webContents) {
      delete wcvOpts.webContents
    }
    if (wcvOpts.hasOwnProperty('webPreferences') && !wcvOpts.webPreferences) {
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
    this.webContents.on('did-navigate', (_e, url) => {
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
    this.view.setBounds({
      x: SIDEBAR_WIDTH + padding,
      y: TOOLBAR_HEIGHT,
      width: width - SIDEBAR_WIDTH - padding * 2,
      height: height - TOOLBAR_HEIGHT - padding,
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
      isLoaded: this.materialized,
      webContentsId: this.webContentsId,
    }
  }
}

class Tabs extends EventEmitter {
  /** Ordered list of all tabs (lazy + materialized). */
  tabList = []
  /** Currently active tab (always materialized while selected). */
  selected = null

  constructor(browserWindow, identityManager = null) {
    super()
    this.window = browserWindow
    this.identityManager = identityManager
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
      identityId: opts.identityId,
      url: opts.url,
      title: opts.title,
      webContents: opts.webContents,
      wcvOpts: opts.webPreferences ? { webPreferences: opts.webPreferences } : null,
    })

    this.tabList.push(tab)

    // Re-emit per-tab updates so callers can listen at the Tabs level.
    tab.on('updated', (info) => this.emit('tab-updated', tab, info))
    tab.on('materialized', () => this.emit('tab-materialized', tab))

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

  select(tabId) {
    const tab = this.get(tabId)
    if (!tab) return
    if (this.selected) this.selected.hide()
    tab.show() // materializes if needed
    this.selected = tab
    this.emit('tab-selected', tab)
  }

  /** All tabs as JSON-serializable objects (for OZ sidebar UI). */
  serializeAll() {
    return this.tabList.map((t) => t.serialize())
  }
}

exports.Tabs = Tabs
exports.Tab = Tab
