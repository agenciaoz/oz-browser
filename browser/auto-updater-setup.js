// OZ Browser — auto-updater setup (Bloque I-2 v1.6.0).
//
// Wirea electron-updater para chequear releases en
// https://github.com/agenciaoz/oz-browser/releases y notificar al user
// cuando hay una version nueva.
//
// Doc: docs/modules/auto-updater.md (TODO post-v1.6.0)
// ADR: docs/architecture/0028-auto-updater.md (TODO)
//
// Flujo:
//   1. App boot → setupAutoUpdater(browser) wirea eventos.
//   2. autoUpdater.checkForUpdates() corre al inicio + cada 4 horas.
//   3. Eventos broadcasted al WebUI via oz:auto-updater:* channels:
//      - 'checking' — comenzó un check
//      - 'available' { version, releaseNotes } — hay update
//      - 'not-available' — no hay update
//      - 'download-progress' { percent, bytesPerSecond }
//      - 'downloaded' { version } — listo para instalar
//      - 'error' { message }
//   4. UI muestra notification con "Restart and install" button cuando
//      downloaded. Click → autoUpdater.quitAndInstall().
//
// Importante:
//   - electron-updater REQUIERE que la app esté firmada en macOS. Sin
//     signing, el chequeo de signatura del .zip downloadado falla y el
//     update se rechaza. Por eso esto activa solo en builds firmados.
//   - dev mode (`npm start`) NO corre auto-updater — solo packaged builds.
//
// Bypass para dev local:
//   - process.env.OZ_FORCE_AUTO_UPDATER=1 fuerza el setup incluso en dev,
//     útil para testing del wire-up sin shippear DMG.
//
// Settings opt-out:
//   - settings.autoUpdate.enabled (default true) — toggle desde Settings
//     → About → "Check for updates automatically".
//   - Si toggle off, no se programa el poll periódico pero el manual
//     "Check now" sigue funcionando.

const log = require('./logger')

// Período del poll: 4 horas. Compromiso entre "notar updates rápido" y
// "no thrashear la red". Apple recomienda 1+ día; GitHub Releases tolera
// fácil más frecuencia.
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000

let _intervalHandle = null
let _updaterRef = null

function setupAutoUpdater(browser) {
  if (!browser || !browser.broadcastToWebUI) {
    log.warn('auto-updater-setup', 'browser context missing — skip')
    return null
  }

  // Skip en dev mode salvo OZ_FORCE_AUTO_UPDATER=1.
  // electron-forge dev (`npm start`) tiene process.defaultApp = true.
  const isDev =
    process.defaultApp || /node_modules[\\/]electron[\\/]dist/.test(process.execPath)
  const force = process.env.OZ_FORCE_AUTO_UPDATER === '1'
  if (isDev && !force) {
    log.info(
      'auto-updater-setup',
      'dev mode — skip (set OZ_FORCE_AUTO_UPDATER=1 to test)',
    )
    return null
  }

  // Lazy require — electron-updater pulls in deps que rompen en test
  // contexts sin Electron. Solo cargamos en runtime real.
  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    log.warn('auto-updater-setup', 'electron-updater require failed', {
      message: err.message,
    })
    return null
  }

  _updaterRef = autoUpdater

  // Log channel: electron-updater tiene su propio logger. Lo redirigimos
  // al nuestro para que aparezca en oz-browser.log centralizado.
  autoUpdater.logger = {
    info: (msg) => log.info('auto-updater', String(msg)),
    warn: (msg) => log.warn('auto-updater', String(msg)),
    error: (msg) => log.error('auto-updater', String(msg)),
    debug: (msg) => log.debug('auto-updater', String(msg)),
  }

  // Config: autoDownload TRUE para que al detectar update arranque la
  // descarga en background sin pedirle al user. UX: notification appears
  // solo cuando downloaded (ready to install) — minimiza ruido si user
  // está en medio de algo.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // ------- Event wiring → WebUI broadcast -------

  autoUpdater.on('checking-for-update', () => {
    browser.broadcastToWebUI('oz:auto-updater:checking', {})
  })

  autoUpdater.on('update-available', (info) => {
    log.info('auto-updater', 'update available', {
      version: info && info.version,
      releaseDate: info && info.releaseDate,
    })
    browser.broadcastToWebUI('oz:auto-updater:available', {
      version: info && info.version,
      releaseDate: info && info.releaseDate,
      releaseNotes: info && info.releaseNotes,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    browser.broadcastToWebUI('oz:auto-updater:not-available', {
      currentVersion: info && info.version,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    browser.broadcastToWebUI('oz:auto-updater:download-progress', {
      percent: progress && progress.percent,
      bytesPerSecond: progress && progress.bytesPerSecond,
      transferred: progress && progress.transferred,
      total: progress && progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('auto-updater', 'update downloaded', { version: info && info.version })
    browser.broadcastToWebUI('oz:auto-updater:downloaded', {
      version: info && info.version,
      releaseNotes: info && info.releaseNotes,
    })
  })

  autoUpdater.on('error', (err) => {
    log.warn('auto-updater', 'error', { message: err && err.message })
    browser.broadcastToWebUI('oz:auto-updater:error', {
      message: (err && err.message) || 'unknown',
    })
  })

  // ------- Initial check + periodic poll -------

  // Pequeño delay del initial check para no interferir con boot. 30s da
  // tiempo a que la app levante UI antes de empezar background work.
  setTimeout(() => {
    _checkRespectingPref(browser)
  }, 30_000)

  _intervalHandle = setInterval(() => {
    _checkRespectingPref(browser)
  }, POLL_INTERVAL_MS)

  log.info('auto-updater-setup', 'installed', {
    pollIntervalMs: POLL_INTERVAL_MS,
    autoDownload: autoUpdater.autoDownload,
  })

  return autoUpdater
}

function _checkRespectingPref(browser) {
  // Respeta settings.autoUpdate.enabled. Si toggle off, no chequea.
  // El manual "Check now" usa checkForUpdatesManual() que ignora el pref.
  try {
    const settings = browser.settingsManager && browser.settingsManager.get('autoUpdate')
    if (settings && settings.enabled === false) {
      log.debug('auto-updater', 'auto-check disabled by user pref')
      return
    }
    if (_updaterRef) _updaterRef.checkForUpdates()
  } catch (err) {
    log.warn('auto-updater', 'scheduled check threw', { message: err.message })
  }
}

/**
 * Force a check now ignoring the auto-update enabled toggle. Used by the
 * Settings → "Check for updates" button. Returns true if a check was
 * dispatched, false if the updater isn't available (dev mode, no Electron).
 */
function checkForUpdatesManual() {
  if (!_updaterRef) return false
  _updaterRef.checkForUpdates()
  return true
}

/**
 * Quit + install the downloaded update. Called when user clicks "Restart
 * and install" in the update-downloaded notification.
 */
function quitAndInstall() {
  if (!_updaterRef) return false
  _updaterRef.quitAndInstall()
  return true
}

/**
 * Stop the periodic poll. Used in before-quit handler to avoid races
 * during shutdown (sync engine + vault.lock + interval all in flight).
 */
function teardown() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
}

module.exports = {
  setupAutoUpdater,
  checkForUpdatesManual,
  quitAndInstall,
  teardown,
}
