const path = require('path')
const { app, session, BrowserWindow, dialog, ipcMain } = require('electron')

const log = require('./logger')
const { setupErrorHandlers, showErrorDialog } = require('./error-handler')

// Initialize logger and global error handlers as early as possible.
log.init()
setupErrorHandlers()

const { Tabs } = require('./tabs')
const { IdentityManager } = require('./identity-manager')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { setupMenu } = require('./menu')
const { buildChromeContextMenu } = require('electron-chrome-context-menu')
const { installChromeWebStore, loadAllExtensions } = require('electron-chrome-web-store')

// OZ Browser — paths relative to project root (no longer in a monorepo).
// At runtime under electron-forge webpack, __dirname = .webpack/main, so PROJECT_ROOT goes up 2 levels.
const PROJECT_ROOT = path.join(__dirname, '../../')
const PATHS = {
  WEBUI: app.isPackaged
    ? path.resolve(process.resourcesPath, 'ui')
    : path.resolve(PROJECT_ROOT, 'browser', 'ui'),
  PRELOAD: path.join(__dirname, '../renderer/browser/preload.js'),
  LOCAL_EXTENSIONS: path.join(PROJECT_ROOT, 'extensions'),
}

let webuiExtensionId

const getParentWindowOfTab = (tab) => {
  switch (tab.getType()) {
    case 'window':
      return BrowserWindow.fromWebContents(tab)
    case 'browserView':
    case 'webview':
      return tab.getOwnerBrowserWindow()
    case 'backgroundPage':
      return BrowserWindow.getFocusedWindow()
    default:
      throw new Error(`Unable to find parent window of '${tab.getType()}'`)
  }
}

class TabbedBrowserWindow {
  constructor(options) {
    this.session = options.session || session.defaultSession
    this.extensions = options.extensions
    this.identityManager = options.identityManager

    // Can't inheret BrowserWindow
    // https://github.com/electron/electron/issues/23#issuecomment-19613241
    this.window = new BrowserWindow(options.window)
    this.id = this.window.id
    this.webContents = this.window.webContents

    const webuiUrl = `chrome-extension://${webuiExtensionId}/webui.html`
    this.webContents.loadURL(webuiUrl)

    this.tabs = new Tabs(this.window, this.identityManager)

    const self = this

    // For lazy tabs we wait for materialization before registering with the
    // Chrome extensions API (which keys tabs by webContents.id).
    this.tabs.on('tab-created', function onTabCreated(tab) {
      // If a URL wasn't pre-supplied, queue the new-tab page so it loads
      // on first materialization.
      if (!tab.pendingUrl && !tab.isMaterialized()) {
        tab.pendingUrl = options.urls.newtab
      }
      // Notify sidebar
      if (self.window?.webContents && !self.window.webContents.isDestroyed()) {
        self.window.webContents.send('oz:tabs:updated', {
          kind: 'created',
          tab: { ...tab.serialize(), windowId: self.id },
        })
      }
    })

    this.tabs.on('tab-materialized', function onTabMaterialized(tab) {
      // The Chrome extensions API was constructed with the default session.
      // Tabs whose Identity uses a partition session must NOT be registered
      // there (would throw "Invalid WebContents argument"). Per-Identity
      // extension support comes in Bloque 1.5.
      if (tab.webContents.session === self.session) {
        self.extensions.addTab(tab.webContents, tab.window)
      }
      // Notify sidebar
      if (self.window?.webContents && !self.window.webContents.isDestroyed()) {
        self.window.webContents.send('oz:tabs:updated', {
          kind: 'materialized',
          tabId: tab.id,
          tab: { ...tab.serialize(), windowId: self.id },
        })
      }
    })

    this.tabs.on('tab-updated', function onTabUpdated(tab, info) {
      if (self.window?.webContents && !self.window.webContents.isDestroyed()) {
        self.window.webContents.send('oz:tabs:updated', {
          kind: 'updated',
          tabId: tab.id,
          tab: { ...info, windowId: self.id },
        })
      }
    })

    this.tabs.on('tab-selected', function onTabSelected(tab) {
      // Selection always materializes via Tab.show().
      if (tab.webContents && tab.webContents.session === self.session) {
        self.extensions.selectTab(tab.webContents)
      }
      if (self.window?.webContents && !self.window.webContents.isDestroyed()) {
        self.window.webContents.send('oz:tabs:updated', {
          kind: 'selected',
          tabId: tab.id,
        })
      }
    })

    this.tabs.on('tab-destroyed', function onTabDestroyed(tab) {
      if (self.window?.webContents && !self.window.webContents.isDestroyed()) {
        self.window.webContents.send('oz:tabs:updated', {
          kind: 'removed',
          tabId: tab.id,
        })
      }
    })

    queueMicrotask(() => {
      // First tab is always eager so the window has something to display.
      const tab = this.tabs.create({
        url: options.initialUrl || options.urls.newtab,
        materialize: true,
      })
      this.tabs.select(tab.id)
    })
  }

  destroy() {
    this.tabs.destroy()
    this.window.destroy()
  }

  getFocusedTab() {
    return this.tabs.selected
  }
}

class Browser {
  windows = []

  urls = {
    newtab: 'about:blank',
  }

  // Active identity used when a tab is created without specifying one
  // (e.g. via the Chrome tabs.create() API from inside a regular page).
  // The sidebar UI updates this when the user picks an Identity.
  activeIdentityId = null

  constructor() {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })

    // IdentityManager needs app.getPath('userData') which is available before whenReady,
    // but to be safe we instantiate inside init().
    this.identityManager = null

    app.whenReady().then(this.init.bind(this))

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        this.destroy()
      }
    })

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) this.createInitialWindow()
    })

    app.on('web-contents-created', this.onWebContentsCreated.bind(this))
  }

  destroy() {
    app.quit()
  }

  /**
   * Broadcast an event to all WebUI webContents (the browser chrome of every
   * window). Used to notify the sidebar UI when identities change.
   */
  broadcastToWebUI(channel, ...args) {
    for (const win of this.windows) {
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }

  registerIpcHandlers() {
    // Logging from renderer
    ipcMain.handle('oz:log', (_e, level, source, message, args) => {
      const fn = (log[String(level).toLowerCase()] || log.info)
      fn(`renderer/${source || 'unknown'}`, message, ...(args || []))
      return true
    })

    // Error reports from renderer
    ipcMain.handle('oz:report-error', (_e, detail) => {
      log.error('renderer', detail.message || 'Renderer error', detail)
      const title = `Renderer error: ${detail.message || 'unknown'}`
      const body =
        (detail.stack || detail.reason || detail.message || JSON.stringify(detail)) +
        (detail.filename ? `\n\nat ${detail.filename}:${detail.lineno}:${detail.colno}` : '')
      showErrorDialog(title, body)
      return true
    })

    // Identities CRUD
    ipcMain.handle('oz:identities:list', () => this.identityManager.list())
    ipcMain.handle('oz:identities:get', (_e, id) => this.identityManager.get(id))
    ipcMain.handle('oz:identities:getActive', () => this.activeIdentityId)
    ipcMain.handle('oz:identities:setActive', (_e, id) => {
      const ident = this.identityManager.get(id)
      if (!ident) return false
      this.activeIdentityId = id
      this.broadcastToWebUI('oz:identities:active-changed', id)
      return true
    })
    ipcMain.handle('oz:identities:create', (_e, opts) => {
      const ident = this.identityManager.create(opts || {})
      this.broadcastToWebUI('oz:identities:changed')
      return ident
    })
    ipcMain.handle('oz:identities:rename', (_e, id, name) => {
      const ident = this.identityManager.rename(id, name)
      if (ident) this.broadcastToWebUI('oz:identities:changed')
      return ident
    })
    ipcMain.handle('oz:identities:setColor', (_e, id, color) => {
      const ident = this.identityManager.setColor(id, color)
      if (ident) this.broadcastToWebUI('oz:identities:changed')
      return ident
    })
    ipcMain.handle('oz:identities:remove', (_e, id) => {
      // If removing the active identity, fall back to default first.
      if (this.activeIdentityId === id) {
        this.activeIdentityId = this.identityManager.getDefault().id
        this.broadcastToWebUI('oz:identities:active-changed', this.activeIdentityId)
      }
      const ok = this.identityManager.remove(id)
      if (ok) this.broadcastToWebUI('oz:identities:changed')
      return ok
    })

    // Tabs ↔ Identity binding & sidebar API
    ipcMain.handle('oz:tabs:list', () => {
      // Return all OZ tabs across windows. Sidebar UI uses this on first paint.
      const result = []
      for (const win of this.windows) {
        for (const t of win.tabs.tabList) {
          result.push({ ...t.serialize(), windowId: win.id })
        }
      }
      return result
    })
    ipcMain.handle('oz:tabs:getIdentity', (_e, tabId) => {
      for (const win of this.windows) {
        const tab = win.tabs.get(tabId)
        if (tab) return tab.identityId
      }
      return null
    })
    ipcMain.handle('oz:tabs:openInIdentity', (_e, identityId, url) => {
      const win = this.getFocusedWindow()
      if (!win) return null
      // Lazy by default: just queues the URL; renderer process is created on click.
      const tab = win.tabs.create({ identityId, url })
      this.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...tab.serialize(), windowId: win.id },
      })
      return tab.id
    })
    ipcMain.handle('oz:tabs:select', (_e, tabId) => {
      for (const win of this.windows) {
        const tab = win.tabs.get(tabId)
        if (tab) {
          win.tabs.select(tabId)
          return true
        }
      }
      return false
    })
    ipcMain.handle('oz:tabs:close', (_e, tabId) => {
      for (const win of this.windows) {
        const tab = win.tabs.get(tabId)
        if (tab) {
          win.tabs.remove(tabId)
          this.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId })
          return true
        }
      }
      return false
    })
    // Navigation controls (operate on the focused window's selected tab)
    const focusedTab = () => {
      const win = this.getFocusedWindow()
      return win && win.tabs && win.tabs.selected ? win.tabs.selected : null
    }
    ipcMain.handle('oz:nav:back', () => {
      const t = focusedTab()
      if (!t || !t.webContents) return false
      if (t.webContents.navigationHistory.canGoBack()) {
        t.webContents.navigationHistory.goBack()
        return true
      }
      return false
    })
    ipcMain.handle('oz:nav:forward', () => {
      const t = focusedTab()
      if (!t || !t.webContents) return false
      if (t.webContents.navigationHistory.canGoForward()) {
        t.webContents.navigationHistory.goForward()
        return true
      }
      return false
    })
    ipcMain.handle('oz:nav:reload', () => {
      const t = focusedTab()
      if (!t) return false
      t.reload()
      return true
    })
    ipcMain.handle('oz:nav:loadURL', (_e, url) => {
      const t = focusedTab()
      if (!t) return false
      t.loadURL(url)
      return true
    })

    ipcMain.handle('oz:tabs:bulkCreateLazy', (_e, count, identityId, urlTemplate) => {
      // Useful for stress testing: create N lazy tabs at once.
      const win = this.getFocusedWindow()
      if (!win) return 0
      const ids = []
      for (let i = 0; i < count; i++) {
        const url = urlTemplate ? urlTemplate.replace('{i}', String(i)) : 'about:blank'
        const tab = win.tabs.create({ identityId, url })
        ids.push(tab.id)
      }
      this.broadcastToWebUI('oz:tabs:updated', { kind: 'bulk-created', count })
      return ids.length
    })
  }

  getFocusedWindow() {
    return this.windows.find((w) => w.window.isFocused()) || this.windows[0]
  }

  getWindowFromBrowserWindow(window) {
    return !window.isDestroyed() ? this.windows.find((win) => win.id === window.id) : null
  }

  getWindowFromWebContents(webContents) {
    let window

    if (this.popup && webContents === this.popup.browserWindow?.webContents) {
      window = this.popup.parent
    } else {
      window = getParentWindowOfTab(webContents)
    }

    return window ? this.getWindowFromBrowserWindow(window) : null
  }

  async init() {
    log.info('browser', 'Browser.init() starting')
    this.initSession()
    this.identityManager = new IdentityManager()
    log.info('browser', 'IdentityManager loaded', {
      identitiesCount: this.identityManager.list().length,
    })
    this.activeIdentityId = this.identityManager.getDefault().id
    this.registerIpcHandlers()
    setupMenu(this)
    log.info('browser', 'IPC handlers + menu registered')

    if ('registerPreloadScript' in this.session) {
      this.session.registerPreloadScript({
        id: 'shell-preload',
        type: 'frame',
        filePath: PATHS.PRELOAD,
      })
    } else {
      // TODO(mv3): remove
      this.session.setPreloads([PATHS.PRELOAD])
    }

    this.extensions = new ElectronChromeExtensions({
      license: 'internal-license-do-not-use',
      session: this.session,

      createTab: async (details) => {
        await this.ready

        const win =
          typeof details.windowId === 'number' &&
          this.windows.find((w) => w.id === details.windowId)

        if (!win) {
          throw new Error(`Unable to find windowId=${details.windowId}`)
        }

        // Chrome extensions API needs a webContents back synchronously, so
        // tabs created via this path must be materialized eagerly.
        const tab = win.tabs.create({
          identityId: this.activeIdentityId,
          url: details.url,
          materialize: true,
        })
        if (typeof details.active === 'boolean' ? details.active : true) {
          win.tabs.select(tab.id)
        }

        return [tab.webContents, tab.window]
      },
      selectTab: (tab, browserWindow) => {
        const win = this.getWindowFromBrowserWindow(browserWindow)
        if (!win) return
        // Map Chrome's webContents.id to our stable OZ tab id.
        const ozTab = win.tabs.getByWebContentsId(tab.id)
        if (ozTab) win.tabs.select(ozTab.id)
      },
      removeTab: (tab, browserWindow) => {
        const win = this.getWindowFromBrowserWindow(browserWindow)
        if (!win) return
        const ozTab = win.tabs.getByWebContentsId(tab.id)
        if (ozTab) win.tabs.remove(ozTab.id)
      },

      createWindow: async (details) => {
        await this.ready

        const win = this.createWindow({
          initialUrl: details.url,
        })
        // if (details.active) tabs.select(tab.id)
        return win.window
      },
      removeWindow: (browserWindow) => {
        const win = this.getWindowFromBrowserWindow(browserWindow)
        win?.destroy()
      },
    })

    // Display <browser-action-list> extension icons.
    ElectronChromeExtensions.handleCRXProtocol(this.session)

    this.extensions.on('browser-action-popup-created', (popup) => {
      this.popup = popup
    })

    // Allow extensions to override new tab page
    this.extensions.on('url-overrides-updated', (urlOverrides) => {
      if (urlOverrides.newtab) {
        this.urls.newtab = urlOverrides.newtab
      }
    })

    const webuiExtension = await this.session.extensions.loadExtension(PATHS.WEBUI)
    webuiExtensionId = webuiExtension.id

    // Wait for web store extensions to finish loading as they may change the
    // newtab URL.
    await installChromeWebStore({
      session: this.session,
      async beforeInstall(details) {
        if (!details.browserWindow || details.browserWindow.isDestroyed()) return

        const title = `Add “${details.localizedName}”?`

        let message = `${title}`
        if (details.manifest.permissions) {
          const permissions = (details.manifest.permissions || []).join(', ')
          message += `\n\nPermissions: ${permissions}`
        }

        const returnValue = await dialog.showMessageBox(details.browserWindow, {
          title,
          message,
          icon: details.icon,
          buttons: ['Cancel', 'Add Extension'],
        })

        return { action: returnValue.response === 0 ? 'deny' : 'allow' }
      },
    })

    if (!app.isPackaged) {
      await loadAllExtensions(this.session, PATHS.LOCAL_EXTENSIONS, {
        allowUnpacked: true,
      })
    }

    await Promise.all(
      this.session.extensions.getAllExtensions().map(async (extension) => {
        const manifest = extension.manifest
        if (manifest.manifest_version === 3 && manifest?.background?.service_worker) {
          await this.session.serviceWorkers.startWorkerForScope(extension.url).catch((error) => {
            console.error(error)
          })
        }
      }),
    )

    this.createInitialWindow()
    this.resolveReady()
    log.info('browser', 'Browser.init() done — initial window created')
  }

  initSession() {
    this.session = session.defaultSession

    // Remove Electron and App details to closer emulate Chrome's UA
    const userAgent = this.session
      .getUserAgent()
      .replace(/\sElectron\/\S+/, '')
      .replace(new RegExp(`\\s${app.getName()}/\\S+`), '')
    this.session.setUserAgent(userAgent)

    this.session.serviceWorkers.on('running-status-changed', (event) => {
      console.info(`service worker ${event.versionId} ${event.runningStatus}`)
    })

    if (process.env.SHELL_DEBUG) {
      this.session.serviceWorkers.once('running-status-changed', () => {
        const tab = this.windows[0]?.getFocusedTab()
        if (tab) {
          tab.webContents.inspectServiceWorker()
        }
      })
    }
  }

  createWindow(options) {
    const win = new TabbedBrowserWindow({
      ...options,
      urls: this.urls,
      extensions: this.extensions,
      identityManager: this.identityManager,
      window: {
        width: 1280,
        height: 720,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          height: 31,
          color: '#39375b',
          symbolColor: '#ffffff',
        },
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          enableRemoteModule: false,
          contextIsolation: true,
          worldSafeExecuteJavaScript: true,
        },
      },
    })
    this.windows.push(win)

    if (process.env.SHELL_DEBUG) {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    return win
  }

  createInitialWindow() {
    this.createWindow()
  }

  async onWebContentsCreated(event, webContents) {
    const type = webContents.getType()
    const url = webContents.getURL()
    console.log(`'web-contents-created' event [type:${type}, url:${url}]`)

    if (process.env.SHELL_DEBUG && ['backgroundPage', 'remote'].includes(webContents.getType())) {
      webContents.openDevTools({ mode: 'detach', activate: true })
    }

    webContents.setWindowOpenHandler((details) => {
      switch (details.disposition) {
        case 'foreground-tab':
        case 'background-tab':
        case 'new-window': {
          return {
            action: 'allow',
            outlivesOpener: true,
            createWindow: ({ webContents: guest, webPreferences }) => {
              const win = this.getWindowFromWebContents(webContents)
              // window.open() must return a webContents synchronously, so
              // materialize eagerly using the supplied guest webContents.
              const tab = win.tabs.create({
                webContents: guest,
                webPreferences,
                identityId: this.activeIdentityId,
                url: details.url,
              })
              return tab.webContents
            },
          }
        }
        default:
          return { action: 'allow' }
      }
    })

    webContents.on('context-menu', (event, params) => {
      const menu = buildChromeContextMenu({
        params,
        webContents,
        extensionMenuItems: this.extensions.getContextMenuItems(webContents, params),
        openLink: (url, disposition) => {
          const win = this.getFocusedWindow()

          switch (disposition) {
            case 'new-window':
              this.createWindow({ initialUrl: url })
              break
            default: {
              // Open in a new lazy tab using the active Identity.
              const tab = win.tabs.create({
                identityId: this.activeIdentityId,
                url,
              })
              win.tabs.select(tab.id)
            }
          }
        },
      })

      menu.popup()
    })
  }
}

module.exports = Browser
