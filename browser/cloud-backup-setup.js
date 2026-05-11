// OZ Browser — Cloud Backup setup (Bloque D-1.7).
//
// Doc: docs/modules/cloud-backup-setup.md
// Bloque: D-1.7
//
// Extraído de main.js (ADR 0005 — 500-LOC rule). Encapsula la inicialización
// de:
//   - DeviceInfo (genera/lee userData/device-info.json)
//   - DropboxClient (necesita OZ_DROPBOX_APP_KEY al build time)
//   - CloudBackupManager (orquesta backup remoto + auto-upload hook)
//   - Protocol dispatcher para oz://auth/dropbox/callback
//
// Idempotente. Si OZ_DROPBOX_APP_KEY falta, deja todo en `null` y el .app
// arranca normal — los handlers IPC devuelven NOT_CONFIGURED.

const { app } = require('electron')
const log = require('./logger')
const { createDeviceInfo } = require('./device-info')
const { createDropboxClient } = require('./dropbox-client')
const { createCloudBackupManager } = require('./cloud-backup-manager')
const { registerProtocolDispatch } = require('./protocol-handler')

/**
 * Wires DeviceInfo + (optionally) Cloud Backup into a Browser instance.
 * Returns the deviceInfo (always) and a flag for cloud backup readiness.
 *
 * Expectations:
 *   - browser.backupManager already instantiated
 *   - protocol-handler already installed (so dispatch registration sticks)
 */
function setupCloudBackup(browser) {
  // DeviceInfo is always needed — both for cloud backup folder paths AND
  // for future cross-device features (team mode, sync engine).
  browser.deviceInfo = createDeviceInfo({ userDataDir: app.getPath('userData') })
  const deviceRecord = browser.deviceInfo.ensureDeviceInfo()
  log.info('cloud-backup-setup', 'DeviceInfo loaded', {
    shortId: deviceRecord.shortId,
    deviceFolder: deviceRecord.deviceFolder,
  })

  const dropboxAppKey = process.env.OZ_DROPBOX_APP_KEY
  if (!dropboxAppKey) {
    log.warn('cloud-backup-setup', 'OZ_DROPBOX_APP_KEY missing — cloud backup disabled')
    browser.cloudBackupManager = null
    browser.dropboxClient = null
    return { deviceInfo: browser.deviceInfo, cloudBackupEnabled: false }
  }

  browser.dropboxClient = createDropboxClient({ clientId: dropboxAppKey })
  browser.cloudBackupManager = createCloudBackupManager({
    userDataDir: app.getPath('userData'),
    deviceInfo: browser.deviceInfo,
    dropboxClient: browser.dropboxClient,
    backupManager: browser.backupManager,
  })
  browser.cloudBackupManager.init() // wires auto-upload listener

  // Protocol dispatcher: handles oz://auth/dropbox/callback redirects.
  // Most-specific path so we don't accidentally swallow other auth flows.
  registerProtocolDispatch(browser, 'auth/dropbox/callback', (_b, parsed) => {
    const code = parsed.query.code
    const state = parsed.query.state
    if (!code) {
      log.warn('cloud-backup-setup', 'auth/dropbox/callback missing code', {
        queryKeys: Object.keys(parsed.query),
      })
      return
    }
    browser.cloudBackupManager
      .completeConnect({ code, state })
      .then(() => {
        browser.broadcastToWebUI('oz:cloud-backup:changed')
        log.info('cloud-backup-setup', 'Dropbox OAuth completed via redirect')
      })
      .catch((err) => {
        log.error('cloud-backup-setup', 'Dropbox completeConnect failed', {
          message: err.message,
        })
        browser.broadcastToWebUI('oz:cloud-backup:changed')
      })
  })

  log.info('cloud-backup-setup', 'CloudBackupManager initialized', {
    connected: browser.cloudBackupManager.getStatus().connected,
    autoUpload: browser.cloudBackupManager.getStatus().autoUpload,
  })

  return { deviceInfo: browser.deviceInfo, cloudBackupEnabled: true }
}

module.exports = { setupCloudBackup }
