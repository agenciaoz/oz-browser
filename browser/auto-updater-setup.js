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

const fs = require('fs')
const path = require('path')
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

  // v1.6.2: Skip si app-update.yml no existe. Este archivo solo lo genera
  // `electron-forge publish` cuando hay publisher GitHub + Apple signing
  // configurados. Una build local con `npm run make` (sin publish, sin
  // OZ_APPLE_* env vars) produce un .app empaquetado pero SIN el yml — y
  // cuando autoUpdater.checkForUpdates() corre, electron-updater intenta
  // leer el yml y throws ENOENT como unhandled promise rejection (el
  // error handler global lo agarra y muestra un dialog molesto al user).
  //
  // Cubre el path "DMG buildeado para uso interno mientras Apple approval
  // pending" — sin esto, cada launch popea un error dialog.
  //
  // Cuando Apple firme + corramos `npm run publish` → el yml viaja con el
  // .app y este guard pasa.
  try {
    const ymlPath = path.join(process.resourcesPath || '', 'app-update.yml')
    if (!fs.existsSync(ymlPath)) {
      log.warn(
        'auto-updater-setup',
        'app-update.yml not found in Resources/ — skip (build sin publisher)',
        { ymlPath },
      )
      return null
    }
  } catch (err) {
    log.warn('auto-updater-setup', 'app-update.yml existence check failed', {
      message: err.message,
    })
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

  // alpha.114: desactivar descarga diferencial. electron-updater intenta bajar
  // un `<zip>.blockmap` para hacer updates incrementales, pero el pipeline de
  // publish (electron-forge + publish-yml.js) NO genera blockmaps → 404 y un
  // ERROR ruidoso en el log (visto en smoke alpha.112) antes de caer a la
  // descarga completa. Con differential OFF va directo a la descarga completa
  // (que ya funciona), sin el 404. Generar blockmaps reales queda como mejora
  // futura (requiere app-builder-bin, hoy no está en deps).
  autoUpdater.disableDifferentialDownload = true

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
    if (_updaterRef) _safeCheck(_updaterRef)
  } catch (err) {
    log.warn('auto-updater', 'scheduled check threw', { message: err.message })
  }
}

/**
 * Call `updater.checkForUpdates()` and swallow the promise rejection.
 *
 * electron-updater surfaces a failed check TWICE: once via the `'error'`
 * event (wired above → logged + broadcast to the WebUI) and once via the
 * promise returned by checkForUpdates(). If that promise rejection isn't
 * caught it bubbles to the global `unhandledRejection` handler, which pops
 * the scary "Unhandled promise rejection (main process)" dialog at the user
 * — aunque el único "problema" sea estar offline o volver de sleep
 * (net::ERR_INTERNET_DISCONNECTED). El try/catch sincrónico del call site NO
 * atrapa esto, porque el rechazo es async.
 *
 * El evento `'error'` ya hace el logging/broadcast real, así que acá solo
 * absorbemos el rechazo (breadcrumb debug-level). Exportado para testing —
 * el offline path es de otro modo imposible de assertear.
 *
 * @param {{checkForUpdates: function}} updater
 * @returns {Promise<void>} siempre resuelve
 */
function _safeCheck(updater) {
  try {
    const p = updater && updater.checkForUpdates()
    if (p && typeof p.catch === 'function') {
      return p.catch((err) => {
        log.debug('auto-updater', 'check rejected (handled via error event)', {
          message: (err && err.message) || String(err),
        })
      })
    }
  } catch (err) {
    log.warn('auto-updater', 'checkForUpdates threw synchronously', {
      message: err && err.message,
    })
  }
  return Promise.resolve()
}

/**
 * Force a check now ignoring the auto-update enabled toggle. Used by the
 * Settings → "Check for updates" button. Returns true if a check was
 * dispatched, false if the updater isn't available (dev mode, no Electron).
 */
function checkForUpdatesManual() {
  if (!_updaterRef) return false
  _safeCheck(_updaterRef)
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
  _safeCheck,
}
