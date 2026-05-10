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
const { AntiLogout } = require('./anti-logout')
const { BackupManager } = require('./backup-manager')
const { BookmarkManager } = require('./bookmark-manager')
const { ProxyManager } = require('./proxy-manager')
const { ProxyAssignment } = require('./proxy-assignment')
const { ProxyHealth } = require('./proxy-health')
const { FingerprintEngine } = require('./fingerprint-engine')
const { SettingsManager } = require('./settings-manager')
const { DownloadManager } = require('./download-manager')
const { HistoryManager } = require('./history-manager')
const { TabDiscardDaemon } = require('./tab-discard-daemon')
const { setupAutoUpdate } = require('./auto-update')
const { setupMenu } = require('./menu')

let _Notification = null
function getNotification() {
  if (_Notification) return _Notification
  // Lazy require to avoid pulling Notification before app is ready in tests.
  _Notification = require('electron').Notification
  return _Notification
}
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
  bookmarkManager = null
  proxyManager = null
  proxyAssignment = null
  proxyHealth = null
  fingerprintEngine = null
  settingsManager = null
  downloadManager = null
  historyManager = null
  tabDiscardDaemon = null
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
      // 1.6: pre-quit snapshot — solo si vault está unlocked (no podemos
      // forzar Keychain prompt al apagar, sería intrusivo). Si está locked,
      // skip silently. El user ya tiene snapshots de pre-destructive +
      // daily + manual cubriendo el caso normal.
      if (this.accountVault && this.accountVault.isUnlocked && this.backupManager) {
        try {
          this.backupManager.createSnapshot({ reason: 'pre-quit' })
        } catch (err) {
          log.warn('browser', 'pre-quit snapshot skipped', { message: err.message })
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
      // Stop the daily snapshot timer.
      if (this._backupCronTimer) {
        clearInterval(this._backupCronTimer)
        this._backupCronTimer = null
      }
      // 1.8c: Stop the proxy health daemon.
      if (this.proxyHealth) {
        try {
          this.proxyHealth.stopDaemon()
        } catch (err) {
          log.warn('browser', 'proxyHealth.stopDaemon failed', {
            message: err.message,
          })
        }
      }
      // 1.10d: Stop the tab discard daemon.
      if (this.tabDiscardDaemon) {
        try {
          this.tabDiscardDaemon.stopDaemon()
        } catch (err) {
          log.warn('browser', 'tabDiscardDaemon.stopDaemon failed', {
            message: err.message,
          })
        }
      }
      // 1.10b: Flush history (throttled save → ensure last entries persist).
      if (this.historyManager) {
        try {
          this.historyManager.flush()
        } catch (err) {
          log.warn('browser', 'historyManager.flush failed', {
            message: err.message,
          })
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
    // Hotfix HX2: defensive — even after the 'closed' splice, there's a
    // tick where the listener hasn't run yet. Skip any zombie whose
    // BrowserWindow was destroyed before calling isFocused().
    const live = this.windows.filter((w) => w.window && !w.window.isDestroyed())
    return live.find((w) => w.window.isFocused()) || live[0] || null
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

  /**
   * 1.6b: daily snapshot cron. Checks every 60 minutes whether the local
   * hour is 3 (3am-3:59am window) AND we haven't snapshotted today already.
   * If both true and vault is unlocked, takes a 'daily-3am' snapshot +
   * runs retention. If vault is locked at 3am, skips silently (we don't
   * force Keychain prompts in the background).
   *
   * Trade-offs vs a real cron: if OZ is closed at 3am the snapshot is
   * skipped that day; the next 3am attempt picks it up. For a v1 that's
   * acceptable — pre-quit + manual + pre-destructive cover the common
   * cases. A "daily-on-launch-if-stale" enhancement can come later.
   */
  _installBackupCron() {
    const HOUR_MS = 60 * 60 * 1000
    let lastSnapshotDate = null // 'YYYY-MM-DD' — tracked to avoid duplicates
    const tick = () => {
      try {
        const now = new Date()
        const today = now.toISOString().slice(0, 10)
        if (now.getHours() !== 3) return // not in the 3am window
        if (lastSnapshotDate === today) return // already done today
        if (!this.accountVault || !this.accountVault.isUnlocked) {
          log.debug('browser', 'daily snapshot skipped — vault locked')
          return
        }
        this.backupManager.createSnapshot({
          reason: 'daily-3am',
          label: `Daily ${today}`,
        })
        this.backupManager.applyRetention()
        lastSnapshotDate = today
        this.broadcastToWebUI('oz:timemachine:changed')
      } catch (err) {
        log.error('browser', 'daily snapshot cron failed', { message: err.message })
      }
    }
    this._backupCronTimer = setInterval(tick, HOUR_MS)
    // Also run once at boot so testing / manual-launch-after-3am still gets one
    setTimeout(tick, 5000)
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

    // 1.5d: anti-logout — instala cookie hooks por identity para extender
    // session cookies de redes sociales a 1 año. Detección de logout via
    // cookie absence (flag account as needs_relogin + system notification).
    // Wireado post-IdentityManager para que las identities existentes
    // queden hookeadas. Identities nuevas se hookean en IdentityManager.create.
    this.antiLogout = new AntiLogout({
      identityManager: this.identityManager,
      accountVault: this.accountVault,
    })
    this.antiLogout.install()
    log.info('browser', 'AntiLogout installed', {
      identitiesHooked: this.identityManager.list().length,
    })

    // 1.6: Time Machine — snapshots cifrados con la master key del Vault.
    // El BackupManager se instancia siempre (no necesita unlock) pero crear
    // un snapshot SÍ requiere vault unlocked porque cifra con la master key.
    this.backupManager = new BackupManager({
      userDataDir: app.getPath('userData'),
      vault: this.accountVault,
      appVersion: app.getVersion(),
    })
    this._installBackupCron()
    log.info('browser', 'BackupManager loaded', {
      snapshotsDir: this.backupManager.snapshotsDir,
      existingCount: this.backupManager.listSnapshots().length,
    })

    // 1.10a: SettingsManager — global user preferences (settings.json) con
    // schema versionado para futuras migraciones. Cargado temprano para que
    // otros subsistemas puedan consultarlo (ej. logger.setLevel).
    this.settingsManager = new SettingsManager()
    log.info('browser', 'SettingsManager loaded', {
      version: this.settingsManager.getAll().version,
      onboarded: this.settingsManager.get('onboarding').completed,
    })

    // 1.9a: FingerprintEngine — generates per-identity fingerprint profiles
    // deterministicamente desde identity.fingerprintSeed. Profile is cached
    // in fingerprints.json (NO regenerates per session — consistency).
    this.fingerprintEngine = new FingerprintEngine()
    log.info('browser', 'FingerprintEngine loaded', {
      cachedProfiles: Object.keys(this.fingerprintEngine.cache).length,
    })

    // 1.9b: sync IPC handler used by preload-fingerprint.js to fetch the FP
    // for the current identity. Sync because the preload must apply overrides
    // BEFORE the page runs its first JS. Local IPC < 1ms, no perf concern.
    // Resolved via event.sender.session — renderer cannot impersonate other
    // identity's FP (same anti-spoof pattern as 1.5c).
    const { ipcMain } = require('electron')
    ipcMain.on('oz:fingerprint:request', (event) => {
      try {
        const identityId = this.identityManager.identityIdForSession(event.sender.session)
        if (!identityId) {
          event.returnValue = null
          return
        }
        const ident = this.identityManager.get(identityId)
        if (!ident) {
          event.returnValue = null
          return
        }
        const fp = this.fingerprintEngine.getOrCreate(identityId, ident.fingerprintSeed)
        event.returnValue = fp
      } catch (err) {
        log.warn('browser', 'fingerprint sync request failed', { message: err.message })
        event.returnValue = null
      }
    })

    // 1.9b: register session init hook for fingerprint application. Runs
    // AFTER the 1.8b proxy hook (registration order guaranteed). Two layers:
    //   (a) session.setUserAgent — defense in depth at network layer.
    //       Chrome's network stack uses this for fetch headers even if a
    //       renderer somehow bypasses our preload.
    //   (b) registerPreloadScript — content-world overrides via webFrame
    //       executeJavaScript (see preload-fingerprint.js).
    // Both layers must agree to defeat fingerprinting tools that compare
    // navigator.userAgent vs request UA (a classic mismatch detection).
    const fpPreloadPath = require('path').join(
      app.getAppPath(),
      'browser',
      'preload-fingerprint.js',
    )
    this.identityManager.addSessionInitHook((identityId, session) => {
      const ident = this.identityManager.get(identityId)
      if (!ident) return
      const fp = this.fingerprintEngine.getOrCreate(identityId, ident.fingerprintSeed)
      if (fp && fp.ua) {
        session.setUserAgent(fp.ua, fp.language || 'en-US')
        log.debug('browser', 'session UA set from FP', {
          identityId,
          ua: fp.ua,
        })
      }
      if (typeof session.registerPreloadScript === 'function') {
        session.registerPreloadScript({
          type: 'frame',
          id: 'oz-fingerprint-preload',
          filePath: fpPreloadPath,
        })
      }
    })

    // 1.10b: Download + History managers. Both per-identity, persisted in
    // separate JSON files. DownloadManager hooks every identity session via
    // a session-init hook; HistoryManager hooks every TabbedBrowserWindow's
    // tabs via the createWindow path.
    this.downloadManager = new DownloadManager({
      broadcast: (channel) => this.broadcastToWebUI(channel),
    })
    this.historyManager = new HistoryManager({
      broadcast: (channel) => this.broadcastToWebUI(channel),
    })

    // 1.10d: TabDiscardDaemon — Apple Silicon perf pass. Auto-discards
    // materialized tabs idle >N min (configurable from Settings). The
    // daemon respects settings.performance.autoTabDiscard at every scan,
    // so toggling the setting takes effect on the next tick (no restart).
    this.tabDiscardDaemon = new TabDiscardDaemon({
      browser: this,
      settingsManager: this.settingsManager,
    })
    this.tabDiscardDaemon.startDaemon()
    log.info('browser', 'TabDiscardDaemon started (5 min interval)')
    log.info('browser', 'DownloadManager + HistoryManager loaded', {
      downloads: this.downloadManager.list().length,
      historyEntries: this.historyManager.list({ limit: 1 }).length,
    })

    // Wire DownloadManager to every identity session at creation.
    this.identityManager.addSessionInitHook((identityId, session) => {
      this.downloadManager.hookSession(identityId, session)
    })

    // 1.7b: Bookmark Manager — flat list per-identity, unencrypted (URLs/titles
    // are not secret like vault contents). Page UI lands in 1.10; for now the
    // tab context menu adds entries via addFromTab.
    this.bookmarkManager = new BookmarkManager()
    log.info('browser', 'BookmarkManager loaded', {
      bookmarksCount: this.bookmarkManager.list().length,
    })

    // 1.8a/1.8b: Proxy Manager + Assignment — proxies live unencrypted (auth
    // creds are already plaintext in URLs / setProxy rules). Per-identity and
    // per-workspace assignments resolved with hierarchy Identity > Workspace
    // > defaultStrategy. Per-tab proxy not supported in v1 (ADR 0017).
    this.proxyManager = new ProxyManager()
    this.proxyAssignment = new ProxyAssignment({ proxyManager: this.proxyManager })
    log.info('browser', 'ProxyManager + ProxyAssignment loaded', {
      proxiesCount: this.proxyManager.list().length,
    })

    // 1.8b: hook the proxy resolution into IdentityManager so any newly
    // created session immediately gets its proxy applied (no restart needed
    // for first-launch identities). Late binding via setter keeps
    // IdentityManager unaware of ProxyManager (loose coupling).
    const { toProxyRulesString } = require('./proxy-assignment')
    this.identityManager.setProxyResolutionHook((identityId, session) => {
      const proxy = this.proxyAssignment.resolve({ identityId })
      const rules = proxy ? toProxyRulesString(proxy) : 'direct://'
      session
        .setProxy({ proxyRules: rules })
        .then(() =>
          log.debug('browser', 'session proxy applied on create', {
            identityId,
            proxyId: proxy && proxy.id,
            rules,
          }),
        )
        .catch((err) =>
          log.error('browser', 'session.setProxy failed on create', {
            identityId,
            message: err.message,
          }),
        )
    })

    // 1.8c: Health daemon — tests assignable proxies every 30 min,
    // auto-disables after 3 fails. Notification on auto-disable.
    this.proxyHealth = new ProxyHealth({
      proxyManager: this.proxyManager,
      broadcast: (channel) => this.broadcastToWebUI(channel),
      notify: (title, body) => {
        try {
          const N = getNotification()
          if (N && N.isSupported && N.isSupported()) {
            new N({ title, body }).show()
          }
        } catch (err) {
          log.warn('browser', 'proxy health notification failed', {
            message: err.message,
          })
        }
      },
    })
    this.proxyHealth.startDaemon()
    log.info('browser', 'ProxyHealth daemon started (30 min interval)')

    // app.on('login') handler — when a proxy challenges with HTTP 407, look up
    // which proxy is currently bound to the requesting webContents' session
    // and provide its credentials. ADR 0004: HTTPS proxies preferred (the
    // login event fires reliably for them; SOCKS5 auth is in-band so this
    // event doesn't fire there).
    app.on('login', (event, webContents, _request, authInfo, callback) => {
      if (!authInfo || !authInfo.isProxy) return // We only handle proxy auth
      try {
        const session = webContents && webContents.session
        if (!session) return
        const identityId = this.identityManager.identityIdForSession(session)
        // Resolve which proxy this identity is using (incl. workspace context).
        const win = this.windows.find((w) =>
          w.tabs?.tabList?.some((t) => t.identityId === identityId),
        )
        const workspaceId = win && win.workspaceId
        const proxy = this.proxyAssignment.resolve({ identityId, workspaceId })
        if (!proxy || !proxy.username) return
        event.preventDefault()
        log.info('browser', 'proxy login challenge → providing creds', {
          host: authInfo.host,
          port: authInfo.port,
          identityId,
          proxyId: proxy.id,
        })
        callback(proxy.username, proxy.password || '')
      } catch (err) {
        log.error('browser', 'proxy login handler crashed', { message: err.message })
      }
    })

    registerIpcHandlers(this)
    setupMenu(this)

    this.extensions = buildChromeExtensions(this)
    await loadExtensions(this)
    log.info('browser', `WebUI extension loaded id=${this.webuiExtensionId}`)

    this.createInitialWindow()

    // Start MCP server if env-enabled OR the user toggled it on in Settings.
    // Off by default — see ADR 0012. H2 wired the settings-manager fallback
    // (HX0 found it missing — `automation.mcpEnabled` had no effect at boot).
    const mcpFromEnv =
      process.env.OZ_MCP_ENABLED === '1' || process.env.OZ_MCP_ENABLED === 'true'
    const automationSection =
      this.settingsManager && this.settingsManager.get('automation')
    const mcpFromSettings = !!(automationSection && automationSection.mcpEnabled)
    if (mcpFromEnv || mcpFromSettings) {
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

    // Etapa 3d: wire auto-update. Skipea con WARN si no estamos packaged
    // (dev mode), si platform != darwin, o si OZ_UPDATE_BASE_URL no está
    // seteado. NO crashea el browser bajo ninguna circunstancia. Runtime
    // real bloqueado por Etapas 3b (firma) + 3c (notarización) — ver
    // ADR 0021. Aún así llamamos siempre porque el WARN deja rastro útil
    // en logs de "intenté pero falté X".
    setupAutoUpdate({ logger: log })

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
      historyManager: this.historyManager, // 1.10b: hooked in window-manager._wireTabEvents
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

    // Hotfix HX2: splice the TabbedBrowserWindow OUT of `this.windows` once
    // the underlying BrowserWindow is fully destroyed. Without this, every
    // closed window lingered in the array as a zombie with `w.window`
    // pointing at a destroyed native handle. `getFocusedWindow` iterated
    // those zombies and called `w.window.isFocused()` → "Object has been
    // destroyed" thrown synchronously from any IPC handler downstream
    // (workspaces:getActive, workspaces:setActive after creating a new
    // workspace, etc). Listen on 'closed' (final, non-cancelable) rather
    // than 'close' (preventable + already used for the snapshot path in
    // window-manager.js).
    win.window.on('closed', () => {
      const idx = this.windows.indexOf(win)
      if (idx >= 0) this.windows.splice(idx, 1)
      log.info('browser', 'window removed from active list', {
        windowId: win.id,
        remaining: this.windows.length,
      })
    })

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
