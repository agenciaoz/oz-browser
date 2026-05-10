// OZ Browser — main process entry point.
//
// This file is the orchestrator only. Heavy lifting lives in:
//   - logger.js              unified file logger
//   - error-handler.js       uncaught exception popup with email
//   - identity-manager.js    Identity CRUD + sessions
//   - tabs.js                Tab + Tabs (lazy materialization)
//   - window-manager.js      TabbedBrowserWindow class + tab event wiring
//   - ipc-handlers.js        all ipcMain.handle() calls
//   - extensions-setup.js    ChromeExtensions, Web Store, webContents handlers
//   - paths.js               PATHS + small helpers
//   - menu.js                app menu (mac top menubar)

const { app, BrowserWindow } = require('electron')

const log = require('./logger')
const { setupErrorHandlers } = require('./error-handler')

// Initialize logger and global error handlers as early as possible.
log.init()
setupErrorHandlers()

const { IdentityManager } = require('./identity-manager')
const { WorkspaceManager } = require('./workspace-manager')
const { Vault } = require('./account-vault')
const { setupMenu } = require('./menu')
const { TabbedBrowserWindow } = require('./window-manager')
const { registerIpcHandlers } = require('./ipc-handlers')
const {
  initSession,
  registerPreload,
  buildChromeExtensions,
  loadExtensions,
  setupWebContentsCreatedHandler,
} = require('./extensions-setup')
const { getParentWindowOfTab } = require('./paths')
const { MCPServer } = require('./mcp-server')

class Browser {
  windows = []
  urls = { newtab: 'about:blank' }
  activeIdentityId = null
  identityManager = null
  workspaceManager = null
  accountVault = null
  webuiExtensionId = null

  constructor() {
    this.ready = new Promise((resolve) => (this.resolveReady = resolve))
    this.mcpServer = null
    app.whenReady().then(() => this.init())

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') this.destroy()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) this.createInitialWindow()
    })

    app.on('before-quit', async (e) => {
      // Flush any pending throttled workspace writes (1.4b switch logic).
      if (this.workspaceManager) {
        try {
          this.workspaceManager.flush()
        } catch (err) {
          log.error('browser', 'workspaceManager.flush failed', {
            message: err.message,
          })
        }
      }
      // 1.5b: lock vault on quit so the master key buffer is wiped before
      // the process tears down. The Keychain entry is untouched.
      if (this.accountVault && this.accountVault.isUnlocked) {
        try {
          this.accountVault.lock()
        } catch (err) {
          log.error('browser', 'accountVault.lock failed', { message: err.message })
        }
      }
      if (this.mcpServer) {
        e.preventDefault()
        await this.mcpServer.stop()
        this.mcpServer = null
        app.quit()
      }
    })

    setupWebContentsCreatedHandler(this)
  }

  destroy() {
    if (this.mcpServer) this.mcpServer.stop().finally(() => app.quit())
    else app.quit()
  }

  /** Broadcast an event to all WebUI webContents (every window's chrome). */
  broadcastToWebUI(channel, ...args) {
    for (const win of this.windows) {
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }

  getFocusedWindow() {
    return this.windows.find((w) => w.window.isFocused()) || this.windows[0]
  }

  getWindowFromBrowserWindow(window) {
    return !window.isDestroyed() ? this.windows.find((w) => w.id === window.id) : null
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

    initSession(this)
    registerPreload(this.session)

    this.identityManager = new IdentityManager()
    this.activeIdentityId = this.identityManager.getDefault().id
    log.info('browser', 'IdentityManager loaded', {
      identitiesCount: this.identityManager.list().length,
    })

    // 1.4b: enable throttled save (2s debounce). Bursts of tab-updated events
    // coalesce into one disk write. Snapshot path (switchWorkspace) calls
    // flush() explicitly to bypass throttle on critical writes.
    this.workspaceManager = new WorkspaceManager({ saveDelayMs: 2000 })
    log.info('browser', 'WorkspaceManager loaded', {
      workspacesCount: this.workspaceManager.list().length,
      defaultId: this.workspaceManager.getDefault().id,
    })

    // 1.5b: instantiate Vault but do NOT auto-unlock at boot. UX choice:
    // first Keychain access prompts user permission on macOS — we want that
    // prompt to happen when the user explicitly opens Account Manager, not
    // silently at every cold start. The vault.unlock() call is triggered by
    // the user via UI or by auto-fill (1.5c) when login page is detected.
    this.accountVault = new Vault()
    log.info('browser', 'Account Vault instantiated (locked, lazy unlock)')

    registerIpcHandlers(this)
    setupMenu(this)

    this.extensions = buildChromeExtensions(this)
    await loadExtensions(this)
    log.info('browser', `WebUI extension loaded id=${this.webuiExtensionId}`)

    this.createInitialWindow()

    // Start MCP server if env-enabled. Off by default — see ADR 0012.
    if (process.env.OZ_MCP_ENABLED === '1' || process.env.OZ_MCP_ENABLED === 'true') {
      try {
        this.mcpServer = new MCPServer(this)
        await this.mcpServer.start()
        log.info('browser', 'MCP server enabled', {
          port: this.mcpServer.port,
          endpoint: `http://127.0.0.1:${this.mcpServer.port}/mcp`,
        })
      } catch (err) {
        log.error('browser', 'MCP server failed to start', {
          message: err.message,
          stack: err.stack,
        })
        // Don't crash the browser — just leave MCP off.
        this.mcpServer = null
      }
    }

    this.resolveReady()
    log.info('browser', 'Browser.init() done — initial window created')
  }

  createWindow(options = {}) {
    const win = new TabbedBrowserWindow({
      ...options,
      urls: this.urls,
      extensions: this.extensions,
      identityManager: this.identityManager,
      browser: this, // 1.4b: needed for workspace switch logic
      webuiExtensionId: this.webuiExtensionId,
      window: {
        width: 1280,
        height: 720,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          height: 31,
          color: '#1f1f2e',
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
}

module.exports = Browser
