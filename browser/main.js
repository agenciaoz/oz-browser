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
const licenseManager = require('./license-manager')
const { setupErrorHandlers } = require('./error-handler')

// Initialize logger and global error handlers as early as possible.
log.init()
setupErrorHandlers()

// =============================================================================
// v1.9.0 — Mac performance flags. Must be set BEFORE app.whenReady().
//
// Target: M1/M2/M3/M4 arm64 Macs (Jose's use case). These improve rendering
// smoothness and lift artificial caps that hurt heavy social/marketing
// tools (TikTok Studio, Meta Ads Manager, Canva, Photoshop Web, etc).
//
// Each flag is documented with WHY — these are tradeoffs, not free wins.
// =============================================================================

// GPU rasterization moves layer painting to the GPU (Metal on macOS). For
// media-heavy social apps with lots of scrolling video this is a noticeable
// smoothness improvement. Default-off in Chromium because of historical
// driver bugs; safe on modern macOS Metal.
app.commandLine.appendSwitch('enable-gpu-rasterization')

// Zero-copy lets the GPU consume tiles directly from the renderer without an
// intermediate copy through main memory. Cuts CPU usage during scroll and
// reduces frame jitter on long feeds.
app.commandLine.appendSwitch('enable-zero-copy')

// 2D canvas acceleration — relevant for sites that draw to <canvas> for
// graphs / video controls / photo editors. Big win on Canva, Photopea, etc.
app.commandLine.appendSwitch('enable-accelerated-2d-canvas')

// Some macOS GPU/driver combinations are still on the historical blocklist
// inherited from Chromium. On Apple Silicon Macs the blocklist is overly
// conservative — overriding it gives us full hardware acceleration on every
// Apple Silicon machine in the wild.
app.commandLine.appendSwitch('ignore-gpu-blocklist')

// V8 heap cap. Electron's default is ~1.4GB per renderer, which heavy
// marketing tools (TikTok Studio, Meta Ads Manager with several open
// campaigns, Canva with large designs) routinely blow through — the
// symptom is a sudden tab crash with no clear cause. 4GB is generous for
// arm64 Macs with 16GB+ RAM and still well below total system RAM.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')

// Disable features that just add idle overhead for a multi-identity
// browser with many session-isolated tabs:
//  - HardwareMediaKeyHandling: we don't intercept the Now Playing widget /
//    F7/F8/F9 media keys (those should pass through to Music/Spotify).
//  - MediaSessionService: per-tab "now playing" metadata is wasted work
//    when most tabs are dashboards / feeds, not media players.
app.commandLine.appendSwitch(
  'disable-features',
  'HardwareMediaKeyHandling,MediaSessionService',
)

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
const { wireIdentityWorkspaceSync } = require('./identity-workspace-sync')
const { installProtocolHandler } = require('./protocol-handler')
const { setupCloudBackup } = require('./cloud-backup-setup')
const { setupTeamMode } = require('./team-setup')
const autoUpdaterSetup = require('./auto-updater-setup')
const syncBootstrapSetup = require('./sync-bootstrap-setup')
const scheduledSetup = require('./scheduled-setup')
const bulkRunnerSetup = require('./bulk-runner-setup')
const ghostMigrationSetup = require('./ghost-migration-setup')
const { setupCrashRecovery } = require('./crash-recovery-setup')
const { AlertManager } = require('./alert-manager')
const { buildProxyHealthNotify } = require('./proxy-health-notify')
const { setupExtensionShare } = require('./extensions-share-setup')
// E2-C-5: getNotification helper removed — only consumer was the inline
// proxy-health notify, now extracted to proxy-health-notify.js.

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
const { setupMcpServer } = require('./mcp-server-setup')

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
  crashDetector = null
  windowSnapshot = null
  alertManager = null

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
      // I-2 (v1.6.0): teardown auto-updater poll FIRST. It's an
      // independent setInterval; stopping it avoids spurious checks
      // landing mid-shutdown.
      try {
        autoUpdaterSetup.teardown()
      } catch (err) {
        log.warn('browser', 'autoUpdaterSetup.teardown failed', {
          message: err.message,
        })
      }
      // F-4a: Stop scheduled-actions runner FIRST so its in-flight handlers
      // drain before sync/vault tear down. stop() awaits the in-flight set
      // — handlers that need vault.unlock observe an unlocked vault for the
      // full duration of their fire.
      await scheduledSetup.stopScheduledActions(this)
      // D-3c-3c: Stop sync engine + pull poll BEFORE other flushes. Queue
      // already persists per enqueue, so stop() just halts the loops — avoids
      // 'getMasterKey on locked vault' noise during teardown.
      syncBootstrapSetup.stopSyncBootstrap(this)
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
      // H-2e (v1.1.3): clear the diagnostics scan interval.
      if (this._proxyDiagnosticsTimer) {
        require('./proxy-diagnostics-setup').stopProxyDiagnosticsScan(
          this._proxyDiagnosticsTimer,
        )
        this._proxyDiagnosticsTimer = null
      }
      // K1-extras (v1.4.2): power monitor teardown.
      require('./power-monitor-setup').teardownPowerMonitorFromBrowser(this)
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
      // E2-C-5: flush AlertManager pending throttled save.
      if (this.alertManager) {
        try {
          this.alertManager.flush()
        } catch (err) {
          log.warn('browser', 'alertManager.flush failed', { message: err.message })
        }
      }
      // E2-C-2: capture final window topology + mark clean shutdown. Order
      // matters: snapshot.flush() FIRST so the on-disk state reflects what
      // was open right before quit (used by next-boot restore IF this quit
      // turns out to have been a crash for some reason). markCleanShutdown
      // LAST so it's the very last thing on disk — anything between init()
      // and this point that crashes the process will leave the lockfile
      // behind and trigger crash recovery on next boot.
      if (this.windowSnapshot) {
        try {
          this.windowSnapshot.flush()
          this.windowSnapshot.stopDaemon()
        } catch (err) {
          log.warn('browser', 'windowSnapshot.flush failed', {
            message: err.message,
          })
        }
      }
      if (this.crashDetector) {
        try {
          this.crashDetector.markCleanShutdown()
        } catch (err) {
          log.warn('browser', 'crashDetector.markCleanShutdown failed', {
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
        // E2-C-5: alert log entry (success). No OS notif for daily snapshots
        // (would be noise) — panel-only.
        if (this.alertManager) {
          this.alertManager.add({
            type: 'snapshot',
            severity: 'success',
            title: 'Daily snapshot created',
            message: `Time Machine snapshot "${today}" saved successfully.`,
            action: { kind: 'open-modal', payload: { modal: 'timeMachine' } },
          })
        }
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

    // Activation gate (pre-SaaS test builds): if this install isn't activated,
    // show ONLY the activation window and halt the rest of boot. Bypass with
    // OZ_LICENSE_DISABLED=1. See license-manager.js + activation-server/.
    if (await licenseManager.gate()) return

    // B-1: register the oz:// protocol scheme + listeners. Done as the very
    // first init step so that any URL queued by the OS during cold-start
    // (macOS open-url) lands once the dispatchers are registered later by
    // individual features (Dropbox auth, Supabase auth, team invites, etc).
    installProtocolHandler(this)

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

    // H3a: wire the Identity ↔ Workspace sync hooks (delegated to
    // identity-workspace-sync.js for clarity + LOC budget).
    wireIdentityWorkspaceSync(this)

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
      // E2-C-5: alertManager + settingsManager are wired LATER in init() so
      // the late-set fields below propagate via property reassignment. AntiLogout
      // will pick them up at flag time via this.alertManager / this.settingsManager.
    })
    // v1.4.5 fix: defer .install() to AFTER setupFingerprintPreload + setupHud
    // register their session-init hooks. AntiLogout.install() calls
    // identityManager.getSession() for every identity, which caches the session
    // (and fires any registered hooks). If install() runs BEFORE FP + HUD hooks
    // are added, those sessions get cached without FP UA override — observable
    // as `navigator.userAgent` still showing the default OZBrowser/Electron UA.

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

    // D-1: Cloud Backup (Dropbox) + DeviceInfo. Delegated to cloud-backup-setup.js
    // per ADR 0005 (LOC budget). Idempotent: works even if OZ_DROPBOX_APP_KEY
    // is missing (cloud backup just stays disabled).
    setupCloudBackup(this)

    // E: Team mode (Curve25519 key-sharing). Depends on dropboxClient from
    // setupCloudBackup. If Dropbox isn't configured, team mode reports
    // NOT_CONFIGURED via the IPC handler.
    setupTeamMode(this)

    // 1.10a: SettingsManager — global user preferences (settings.json) con
    // schema versionado para futuras migraciones. Cargado temprano para que
    // otros subsistemas puedan consultarlo (ej. logger.setLevel).
    this.settingsManager = new SettingsManager()
    log.info('browser', 'SettingsManager loaded', {
      version: this.settingsManager.getAll().version,
      onboarded: this.settingsManager.get('onboarding').completed,
    })

    // E2-C-5: AlertManager — persistent in-app alert log. Loaded BEFORE
    // anti-logout / proxy-health / backup-manager so those producers can
    // emit alerts to it from their first tick. Convives con las OS
    // notifications (settings.notifications.showOSAlert toggle).
    this.alertManager = new AlertManager({
      userDataDir: app.getPath('userData'),
      broadcast: (channel) => this.broadcastToWebUI(channel),
    })
    // Late-bind alertManager + settingsManager into AntiLogout (created earlier
    // before either existed). Property assignment is fine — AntiLogout reads
    // both lazily inside _onCookieRemoved (no constructor-time wiring needed).
    if (this.antiLogout) {
      this.antiLogout.alertManager = this.alertManager
      this.antiLogout.settingsManager = this.settingsManager
    }
    log.info('browser', 'AlertManager loaded', {
      existingAlerts: this.alertManager.list().length,
      unread: this.alertManager.unreadCount(),
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

    // 1.9b: register session init hook for fingerprint application.
    // Extracted to fingerprint-preload-setup.js in v1.4.3 (LOC budget).
    require('./fingerprint-preload-setup').setupFingerprintPreload(this)

    // K1-extras (v1.4.3): In-page identity HUD. Register HUD preload via
    // session-init hook + wrap broadcastToWebUI for live updates.
    require('./hud-setup').setupHud(this)

    // v1.4.5 fix: NOW it's safe to install AntiLogout cookie hooks — sessions
    // created from inside install() will fire the FP + HUD hooks registered
    // above. Without this defer, FP UA override was silently inert because
    // sessions were cached pre-hook.
    this.antiLogout.install()
    log.info('browser', 'AntiLogout installed', {
      identitiesHooked: this.identityManager.list().length,
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

    // D-3c-3c: cross-device sync bootstrap. Deps already wired by this point:
    // identityManager + workspaceManager + bookmarkManager + accountVault +
    // dropboxClient (cloud-backup) + deviceInfo (cloud-backup) + settingsManager
    // + alertManager. Default OFF — user opts in from Settings → Sync.
    syncBootstrapSetup.setupSyncBootstrap(this)

    // v2 sub-bloque 1: Bulk Runner. Setup ANTES de registerIpcHandlers para
    // que `browser.handlers.bulk` quede wired al registrar las rutas IPC.
    // Sin lifecycle start() — el runner ejecuta on-demand cuando UI/MCP
    // llaman `oz.bulk.run`. Setup BEFORE scheduledActions so the bulk
    // handler (v2 Etapa 2.1) is registered when _buildDeps reads
    // browser.bulkRunner.
    bulkRunnerSetup.setupBulkRunner(this)

    // v2 Etapa 4.2 — native OS notifications on bulk run completion.
    // Thin wrapper in browser/bulk-notifications-setup.js (ADR 0005 LOC).
    require('./bulk-notifications-setup').setupBulkNotifications(this)

    // F-4a: Scheduled Actions (cron-lite v1). Setup BEFORE registerIpcHandlers
    // so browser.handlers.scheduled is wired when IPC routes register. The
    // runner is NOT started here — startScheduledActions runs AFTER IPC + sync
    // are ready so the first tick can broadcast / use sync surfaces if needed.
    // Handlers registered: open-workspace (via workspaceManager), sync-push
    // (via syncBootstrap.pullNow), backup-snapshot (via backupManager),
    // session-warmer (via identityManager), bulk (via bulkRunner — v2 Etapa 2.1).
    scheduledSetup.setupScheduledActions(this)

    // G-3: Ghost Browser migration handlers. One-shot per click, no
    // lifecycle. setup() just attaches browser.handlers.ghostMigration so
    // ipc-handlers-extra.js can register the IPC channels.
    ghostMigrationSetup.setupGhostMigration(this)

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
    //
    // alpha.30: StickyRotation interpose para regenerar sessid Oxylabs cuando
    // expira el sticky window (30 min). Mantiene IP estable mientras está
    // dentro del window; rota al re-activar identity DESPUÉS del window.
    // El ephemeral sessid no persiste — boot fresh = sessid fresh.
    const { toProxyRulesString } = require('./proxy-assignment')
    const { StickyRotation } = require('./proxy-sticky-rotation')
    this.stickyRotation = new StickyRotation({
      proxyAssignment: this.proxyAssignment,
      toProxyRulesString,
      identityManager: this.identityManager,
      logger: log,
    })
    this.identityManager.setProxyResolutionHook((identityId, session) => {
      // applyForIdentity rotates if stale + setProxy en una sola llamada.
      this.stickyRotation.applyForIdentity(identityId, session).catch((err) => {
        log.error('browser', 'sticky rotation apply failed', {
          identityId,
          message: err && err.message,
        })
      })
    })

    // 1.8c: Health daemon — tests assignable proxies every 30 min,
    // auto-disables after 3 fails. Notification on auto-disable.
    this.proxyHealth = new ProxyHealth({
      proxyManager: this.proxyManager,
      broadcast: (channel) => this.broadcastToWebUI(channel),
      // E2-C-5: notify factory wraps the OS Notification call + alert log
      // entry. Extracted to keep main.js under 500 LOC (ADR 0005).
      notify: buildProxyHealthNotify(this),
    })
    this.proxyHealth.startDaemon()
    log.info('browser', 'ProxyHealth daemon started (30 min interval)')

    // H-2e (v1.1.3): diagnostics scan loop — extracted per ADR 0005.
    const { startProxyDiagnosticsScan } = require('./proxy-diagnostics-setup')
    this._proxyDiagnosticsTimer = startProxyDiagnosticsScan(this)

    // K1-extras (v1.4.2): re-test proxies on Mac wake from sleep.
    require('./power-monitor-setup').wirePowerMonitorOntoBrowser(this)

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

    // D-3c-3c: init() resumes sync engine if user already opted-in + Dropbox
    // is authenticated. Runs AFTER registerIpcHandlers so handlers.sync exists.
    // Non-blocking — sync surface logs + broadcasts failures.
    syncBootstrapSetup.startSyncBootstrap(this)

    // F-4a: kick the scheduled-actions runner loop (60s default tick).
    // Runs AFTER startSyncBootstrap so sync-push handler can land on a
    // ready bootstrap if a scheduled push happens to be due immediately.
    scheduledSetup.startScheduledActions(this)

    this.extensions = buildChromeExtensions(this)
    await loadExtensions(this)
    log.info('browser', `WebUI extension loaded id=${this.webuiExtensionId}`)

    // E2-C-7: Per-identity extension sharing. Delegated to setup module per
    // ADR 0005 (main.js LOC budget).
    setupExtensionShare(this)

    // I-2 (v1.6.0): auto-updater via electron-updater + GitHub Releases.
    // Skip en dev mode salvo OZ_FORCE_AUTO_UPDATER=1. Skip si el build no
    // está firmado (electron-updater rechaza unsigned updates en macOS).
    // El setup wirea events → broadcastToWebUI, programa initial check +
    // periodic poll. Settings toggle (settings.autoUpdate.enabled) respetado.
    autoUpdaterSetup.setupAutoUpdater(this)

    // E2-C-2: crash recovery (delegated to crash-recovery-setup.js for LOC
    // budget). Order: init crash-detector + window-snapshot, prompt restore
    // if applicable, then start the snapshot daemon AFTER windows exist so
    // the first tick captures the live state.
    const { restored } = await setupCrashRecovery(this)
    if (!restored) {
      this.createInitialWindow()
    }
    this.windowSnapshot.startDaemon()

    // ADR 0012: MCP off by default — env var OZ_MCP_ENABLED=1 or Settings →
    // Automation → mcpEnabled flips it on. Delegated to setup per ADR 0005.
    await setupMcpServer(this)

    // Etapa 3d: wire auto-update. Skipea con WARN si no estamos packaged
    // (dev mode), si platform != darwin, o si OZ_UPDATE_BASE_URL no está
    // seteado. NO crashea el browser bajo ninguna circunstancia. Runtime
    // real bloqueado por Etapas 3b (firma) + 3c (notarización) — ver
    // ADR 0021. Aún así llamamos siempre porque el WARN deja rastro útil
    // en logs de "intenté pero falté X".
    setupAutoUpdate({ logger: log })

    this.resolveReady()
    log.info('browser', 'Browser.init() done — initial window created')

    // V3-D: headless invocation (oz --headless --identity --recipe ...). Runs
    // the recipe over page-handlers then exits. Guarded by the flag → zero
    // effect on a normal GUI launch.
    if (require('./headless-cli').isHeadlessInvocation(process.argv)) {
      await require('./headless-setup').runHeadless(this, process.argv)
    }
  }

  createWindow(options = {}) {
    // E2-C-2: defaults can be overridden by callers (session-restore passes
    // x/y/width/height from the persisted snapshot so windows reopen exactly
    // where they were). Frame, titleBar, webPreferences are always our hardcoded
    // defaults — the caller can ONLY override geometry-style fields.
    const defaultWindowOpts = {
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
    }
    const callerWindowOpts = (options && options.window) || {}
    const mergedWindowOpts = { ...defaultWindowOpts, ...callerWindowOpts }

    const win = new TabbedBrowserWindow({
      ...options,
      urls: this.urls,
      extensions: this.extensions,
      identityManager: this.identityManager,
      browser: this, // 1.4b: needed for workspace switch logic
      webuiExtensionId: this.webuiExtensionId,
      historyManager: this.historyManager, // 1.10b: hooked in window-manager._wireTabEvents
      window: mergedWindowOpts,
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
      // E2-C-2: capture the new (smaller) window topology immediately so a
      // crash before the next daemon tick (~2s) doesn't restore the closed
      // window. flush() is dedupe-aware so back-to-back closes write once.
      if (this.windowSnapshot) {
        try {
          this.windowSnapshot.flush()
        } catch (err) {
          log.warn('browser', 'windowSnapshot.flush on close failed', {
            message: err.message,
          })
        }
      }
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
