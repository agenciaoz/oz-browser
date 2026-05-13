// OZ Browser — Sync Bootstrap (D-3c-3c).
//
// Orchestrator que vive entre las primitivas de sync (D-3a→D-4 mini b) y
// main.js. Expone una superficie chica (init/setEnabled/getStatus/pullNow/
// stop) que el IPC + Settings UI consumen sin saber nada del engine/puller
// por dentro.
//
// Decisiones (D-3c-3c, 2026-05-13):
//   - Default OFF. El sync arranca cuando el usuario tocó el toggle en
//     Settings ("Enable cross-device sync"). Persistido en settings.sync.enabled.
//   - Cold-start "push-all" la primera vez que enable() ocurre — enqueue todas
//     las identities/workspaces/bookmarks como upsert antes de start(). Marca
//     `firstEnableAt` en settings para que reruns no duplican el sweep.
//   - UI mínima: status + Sync Now button. No panel dedicado.
//   - Reusa el dropboxClient de setupCloudBackup (mismo token, mismo Keychain).
//     Si Dropbox no está autenticado → status='needs-reauth'.
//   - Si vault locked → start() no falla, pero el engine pausa internamente
//     (sync-record-store necesita masterKey). Cuando el user unlockea, el
//     siguiente drain reanuda.
//
// Doc: docs/modules/sync-bootstrap.md
// ADRs: 0026-sync-engine.md (engine arquitectura), 0025-cloud-backup.md
//
// Lifecycle:
//   1. main.js: const sync = createSyncBootstrap(browser); await sync.init()
//   2. Si settings.sync.enabled=true al boot AND dropbox connected → arranca
//      automático (resume desde sesión previa, NO re-cold-start).
//   3. Si user toca toggle → setEnabled(true) → cold-start si es first time
//      + start().
//   4. Si user toca toggle off → setEnabled(false) → stop() (queue preservada
//      en disk; al re-enable resume sin re-cold-start).
//   5. before-quit: stop() + engine.stop() + puller stop + queue flush
//      (la queue ya hace save tras cada enqueue, esto es belt + suspenders).

'use strict'

const { app } = require('electron')
const log = require('./logger')
const { setupSync } = require('./sync-setup')
const { BOOKMARKS_RECORD_ID } = require('./bookmark-manager-sync')

class SyncBootstrapError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'SYNC_BOOTSTRAP_ERROR'
    this.name = 'SyncBootstrapError'
  }
}

/**
 * Build a sync bootstrap bound to a Browser instance.
 *
 * @param {object} browser Browser instance with:
 *   - accountVault          required
 *   - dropboxClient         optional (null if Dropbox not configured)
 *   - identityManager       required
 *   - workspaceManager      optional
 *   - bookmarkManager       optional
 *   - deviceInfo            required when sync enabled
 *   - settingsManager       required
 *   - alertManager          optional (surfaces paused/needs-reauth alerts)
 *   - broadcastToWebUI(ch)  function
 *
 * @returns {object} api
 */
function createSyncBootstrap(browser, opts = {}) {
  if (!browser) throw new SyncBootstrapError('browser required', 'BAD_ARG')
  if (!browser.settingsManager) {
    throw new SyncBootstrapError('settingsManager required', 'BAD_ARG')
  }
  if (!browser.identityManager) {
    throw new SyncBootstrapError('identityManager required', 'BAD_ARG')
  }
  if (!browser.accountVault) {
    throw new SyncBootstrapError('accountVault required', 'BAD_ARG')
  }

  const userDataDir = opts.userDataDir || app.getPath('userData')
  // Test injection point — replace setupSync to avoid real Dropbox / fs.
  const setupSyncImpl = opts.setupSync || setupSync
  // Optional clock for "lastPullAt"/"lastPushAt" determinism in tests.
  const now = opts.now || (() => new Date().toISOString())

  // -------- state --------
  let sync = null // the object returned by setupSync (engine/puller/queue/start/stop/pullNow)
  let lastPullAt = null
  let lastPushAt = null
  let lastError = null // { code, message } from most recent push-failed / pull
  let needsReauth = false
  let initialized = false

  // -------- helpers --------

  function _getSettings() {
    return browser.settingsManager.get('sync') || { enabled: false, firstEnableAt: null }
  }

  function _setSetting(key, value) {
    const result = browser.settingsManager.set('sync', { [key]: value })
    // settings-manager.set returns either { __error } on validation failure
    // or the updated section object on success. We only warn on the error path.
    if (result && result.__error) {
      log.warn('sync-bootstrap', 'settings.sync set failed', {
        key,
        value,
        reason: result.__error.reason,
      })
    }
    return result
  }

  function _broadcast() {
    if (browser.broadcastToWebUI) {
      try {
        browser.broadcastToWebUI('oz:sync:changed')
      } catch (err) {
        log.warn('sync-bootstrap', 'broadcast failed', { message: err.message })
      }
    }
  }

  function _alert(opts) {
    if (!browser.alertManager) return
    try {
      browser.alertManager.add(opts)
    } catch (err) {
      log.warn('sync-bootstrap', 'alert add failed', { message: err.message })
    }
  }

  /**
   * Build the sync object if we haven't yet. Idempotent — caller can invoke
   * multiple times; only the first call constructs.
   *
   * Returns the sync object on success, throws SyncBootstrapError if
   * preconditions aren't met (e.g. Dropbox not configured).
   */
  function _buildSync() {
    if (sync) return sync
    if (!browser.dropboxClient) {
      throw new SyncBootstrapError(
        'Dropbox client not configured (set OZ_DROPBOX_APP_KEY at build time)',
        'NEEDS_DROPBOX_APP',
      )
    }
    if (!browser.deviceInfo) {
      throw new SyncBootstrapError(
        'deviceInfo missing — cloud backup setup never ran',
        'NO_DEVICE',
      )
    }
    const deviceRecord = browser.deviceInfo.ensureDeviceInfo()
    sync = setupSyncImpl({
      vault: browser.accountVault,
      dropbox: browser.dropboxClient,
      identityManager: browser.identityManager,
      workspaceManager: browser.workspaceManager || null,
      bookmarkManager: browser.bookmarkManager || null,
      userDataDir,
      deviceFolder: deviceRecord.deviceFolder,
    })

    // Wire observability — engine + puller events surface as alerts + broadcasts.
    sync.engine.on('pushed', (evt) => {
      lastPushAt = now()
      lastError = null
      log.debug('sync-bootstrap', 'pushed', {
        recordType: evt.op && evt.op.recordType,
        recordId: evt.op && evt.op.recordId,
      })
      _broadcast()
    })
    sync.engine.on('push-failed', (evt) => {
      const code = evt && evt.code
      lastError = { code: code || 'PUSH_FAILED', message: evt.message }
      // 401 from Dropbox surfaces as NEEDS_REAUTH from dropbox-client.
      if (code === 'NEEDS_REAUTH') {
        needsReauth = true
        _alert({
          type: 'sync',
          severity: 'urgent',
          title: 'Sync needs Dropbox re-auth',
          message: 'Your Dropbox session expired. Reconnect from Cloud Backup settings.',
        })
      }
      _broadcast()
    })
    sync.puller.on('remote-apply', (evt) => {
      lastPullAt = now()
      lastError = null
      log.debug('sync-bootstrap', 'remote-apply', {
        recordType: evt.recordType,
        recordId: evt.recordId,
        action: evt.action,
      })
      _broadcast()
    })
    sync.puller.on('paused', (evt) => {
      lastError = { code: 'PAUSED', message: (evt && evt.reason) || 'paused' }
      _broadcast()
    })

    return sync
  }

  /**
   * Iterate every existing record (identities, workspaces, bookmarks) and
   * enqueue as upsert. Required the first time sync is enabled on a fresh
   * device so the OTHER device can hydrate from Dropbox.
   *
   * Subsequent enables (after disable→re-enable) skip cold-start — the queue
   * + sync-state cursor already cover what changed in between.
   *
   * Returns { identities, workspaces, bookmarks } counts.
   */
  function _coldStart() {
    if (!sync) {
      throw new SyncBootstrapError('cannot cold-start before build', 'NOT_BUILT')
    }
    const counts = { identities: 0, workspaces: 0, bookmarks: 0 }

    // Identities — every record gets an upsert with its current updatedAt.
    for (const ident of browser.identityManager.list()) {
      try {
        sync.queue.enqueue({
          op: 'upsert',
          recordType: 'identity',
          recordId: ident.id,
          updatedAt: ident.updatedAt || now(),
        })
        counts.identities += 1
      } catch (err) {
        log.warn('sync-bootstrap', 'cold-start identity enqueue failed', {
          id: ident.id,
          message: err.message,
        })
      }
    }

    // Workspaces — same pattern, optional manager.
    if (browser.workspaceManager) {
      for (const ws of browser.workspaceManager.list()) {
        try {
          sync.queue.enqueue({
            op: 'upsert',
            recordType: 'workspace',
            recordId: ws.id,
            updatedAt: ws.updatedAt || now(),
          })
          counts.workspaces += 1
        } catch (err) {
          log.warn('sync-bootstrap', 'cold-start workspace enqueue failed', {
            id: ws.id,
            message: err.message,
          })
        }
      }
    }

    // Bookmarks — single record. Only enqueue if there's at least one bookmark.
    if (browser.bookmarkManager) {
      try {
        const rec = browser.bookmarkManager.getSyncRecord()
        if (rec && Array.isArray(rec.bookmarks) && rec.bookmarks.length > 0) {
          sync.queue.enqueue({
            op: 'upsert',
            recordType: 'bookmark',
            recordId: BOOKMARKS_RECORD_ID,
            updatedAt: rec.updatedAt || now(),
          })
          counts.bookmarks = 1
        }
      } catch (err) {
        log.warn('sync-bootstrap', 'cold-start bookmark enqueue failed', {
          message: err.message,
        })
      }
    }

    log.info('sync-bootstrap', 'cold-start enqueued', counts)
    return counts
  }

  // -------- public API --------

  /**
   * Wire at boot. If settings.sync.enabled === true AND Dropbox is connected,
   * builds sync + starts it (resume — NO cold-start, that already happened the
   * first time the user toggled enable). If Dropbox isn't authenticated yet,
   * leaves sync null; setEnabled() will re-try once the user reconnects.
   */
  async function init() {
    initialized = true
    const s = _getSettings()
    if (!s.enabled) {
      log.info('sync-bootstrap', 'init — sync disabled in settings')
      return { ok: true, running: false }
    }
    if (!browser.dropboxClient) {
      log.warn('sync-bootstrap', 'init — sync enabled but Dropbox app not configured')
      _broadcast()
      return { ok: false, reason: 'NEEDS_DROPBOX_APP' }
    }
    if (!browser.dropboxClient.isAuthenticated()) {
      needsReauth = true
      log.warn('sync-bootstrap', 'init — sync enabled but Dropbox not authenticated')
      _broadcast()
      return { ok: false, reason: 'NEEDS_REAUTH' }
    }
    try {
      _buildSync()
      sync.start()
      log.info('sync-bootstrap', 'sync resumed at boot')
      _broadcast()
      return { ok: true, running: true }
    } catch (err) {
      log.error('sync-bootstrap', 'init failed to start sync', { message: err.message })
      lastError = { code: err.code || 'INIT_FAILED', message: err.message }
      _broadcast()
      return { ok: false, reason: err.code || 'INIT_FAILED', message: err.message }
    }
  }

  /**
   * Toggle the sync. Persists to settings.
   *   - enable: builds sync if needed, cold-starts on first-ever enable,
   *     calls start(). Errors out if Dropbox not configured/authenticated.
   *   - disable: stops sync, preserves queue + cursor on disk for next enable.
   */
  function setEnabled(enabled) {
    const wasEnabled = _getSettings().enabled
    if (
      enabled === wasEnabled &&
      initialized &&
      (enabled ? !!(sync && sync.isRunning && sync.isRunning()) : true)
    ) {
      return { ok: true, noop: true, enabled }
    }

    if (enabled) {
      if (!browser.dropboxClient) {
        return { ok: false, reason: 'NEEDS_DROPBOX_APP' }
      }
      if (!browser.dropboxClient.isAuthenticated()) {
        needsReauth = true
        _broadcast()
        return { ok: false, reason: 'NEEDS_REAUTH' }
      }
      try {
        _buildSync()
      } catch (err) {
        return { ok: false, reason: err.code || 'BUILD_FAILED', message: err.message }
      }
      const settings = _getSettings()
      let coldStartCounts = null
      if (!settings.firstEnableAt) {
        coldStartCounts = _coldStart()
        _setSetting('firstEnableAt', now())
      }
      _setSetting('enabled', true)
      sync.start()
      needsReauth = false
      lastError = null
      _alert({
        type: 'sync',
        severity: 'info',
        title: 'Cross-device sync enabled',
        message: coldStartCounts
          ? `Initial push: ${coldStartCounts.identities} identities, ${coldStartCounts.workspaces} workspaces` +
            (coldStartCounts.bookmarks ? `, bookmarks` : '')
          : 'Resumed from previous session',
      })
      _broadcast()
      return {
        ok: true,
        enabled: true,
        coldStart: !!coldStartCounts,
        counts: coldStartCounts,
      }
    }

    // disable
    if (sync) sync.stop()
    _setSetting('enabled', false)
    _broadcast()
    return { ok: true, enabled: false }
  }

  /**
   * Manual "Sync Now" — runs pullOnce immediately. Returns the puller's
   * result keyed by recordType, plus a snapshot of status afterward.
   */
  async function pullNow() {
    if (!sync) {
      return { ok: false, reason: 'NOT_RUNNING' }
    }
    try {
      const result = await sync.pullNow()
      lastPullAt = now()
      lastError = null
      _broadcast()
      return { ok: true, result }
    } catch (err) {
      lastError = { code: err.code || 'PULL_FAILED', message: err.message }
      if (err.code === 'NEEDS_REAUTH') needsReauth = true
      _broadcast()
      return { ok: false, reason: err.code || 'PULL_FAILED', message: err.message }
    }
  }

  /**
   * Returns a flat status snapshot for UI + IPC consumers.
   *   - configured: dropbox app key is set at build time
   *   - dropboxConnected: dropboxClient.isAuthenticated()
   *   - enabled: settings.sync.enabled (user intent)
   *   - running: sync.isRunning() (actual runtime state)
   *   - queueDepth: queue.size() (pending push ops)
   *   - vaultUnlocked: vault.isUnlocked
   *   - needsReauth: most recent Dropbox call returned 401
   *   - lastPullAt / lastPushAt: ISO timestamps or null
   *   - lastError: { code, message } or null
   */
  function getStatus() {
    const settings = _getSettings()
    const dropboxConfigured = !!browser.dropboxClient
    const dropboxConnected = dropboxConfigured
      ? browser.dropboxClient.isAuthenticated()
      : false
    const running = !!(sync && sync.isRunning && sync.isRunning())
    const queueDepth = sync && sync.queue ? sync.queue.size() : 0
    const vaultUnlocked = !!(browser.accountVault && browser.accountVault.isUnlocked)
    return {
      configured: dropboxConfigured,
      dropboxConnected,
      enabled: !!settings.enabled,
      running,
      queueDepth,
      vaultUnlocked,
      needsReauth,
      firstEnableAt: settings.firstEnableAt || null,
      lastPullAt,
      lastPushAt,
      lastError,
    }
  }

  /**
   * Called from main.js before-quit. Best-effort stop + flush.
   */
  function stop() {
    if (sync) {
      try {
        sync.stop()
      } catch (err) {
        log.warn('sync-bootstrap', 'stop threw', { message: err.message })
      }
    }
  }

  return {
    init,
    setEnabled,
    pullNow,
    getStatus,
    stop,
    // Test-only escape hatches — keep prefixed with _ so they're easy to find.
    _resetForTest: () => {
      sync = null
      lastPullAt = null
      lastPushAt = null
      lastError = null
      needsReauth = false
      initialized = false
    },
    _getSync: () => sync,
  }
}

module.exports = { createSyncBootstrap, SyncBootstrapError }
