// OZ Browser — Auto-Update wiring (Etapa 3d).
//
// Doc: docs/modules/auto-update.md
// ADR: docs/architecture/0021-auto-update-strategy.md
// Bloque: Etapa 3d
//
// Wrapper sobre `update-electron-app` (oficial Electron team encima de
// `electron-updater`). Configurado para usar `StaticStorage` apuntando a un
// bucket Cloudflare R2 (S3-compatible) por la URL en `OZ_UPDATE_BASE_URL`.
// El repo es privado, así que el default `update.electronjs.org` (que
// requiere repo público para pollear GitHub Releases con la API pública) no
// nos sirve — ver ADR 0021 para alternativas consideradas.
//
// Skip conditions (todas con WARN, ninguna crashea el browser):
//   - !app.isPackaged (estamos en `npm start`, no build packaged)
//   - process.platform !== 'darwin' (Windows en Etapa 8)
//   - process.env.OZ_UPDATE_DISABLED === '1' (escape hatch para testing)
//   - process.env.OZ_UPDATE_BASE_URL no seteado (Jose no terminó de armar el bucket)
//
// Runtime real bloqueado por Etapas 3b (firma) + 3c (notarización). Sin
// notarizar, `update-electron-app` falla en silencio en macOS Catalina+ —
// el download corre, el restart se ejecuta, pero Squirrel.Mac no acepta el
// nuevo .app porque su firma no matchea o falta. NO hay error visible al
// usuario. **NO probar 3d hasta que 3b/3c estén cerrados.**
//
// Exports:
//   - setupAutoUpdate(opts) — wire en main.js post-init.
//   - _testHelpers — internals para tests (no usar en runtime).
//
// IPC: none (no UI custom — usamos el dialog nativo de update-electron-app).

const SOURCE = 'auto-update'

// Defaults consistentes con el plan (PLAN-MAESTRO §ETAPA 3 UX). El minimum
// del lib es 5 min; 1 hora es el balance razonable: lo suficientemente
// frecuente para detectar updates en horas hábiles, lo suficientemente
// poco para no thrashear ancho de banda del usuario.
const DEFAULT_UPDATE_INTERVAL = '1 hour'

/**
 * Wire auto-update en el Electron main process.
 *
 * @param {object} opts
 * @param {object} opts.logger - OZ logger module (from browser/logger.js).
 *   Debe exponer: info(src, msg, ...meta), warn(...), error(...).
 * @param {object} [opts.app] - Electron app object (default: require('electron').app).
 *   Inyectable para tests (necesitamos mockear isPackaged).
 * @param {object} [opts.env] - Env vars (default: process.env). Inyectable.
 * @param {string} [opts.platform] - process.platform (default: process.platform). Inyectable.
 * @param {function} [opts.updateElectronApp] - El export del lib (default: require).
 *   Inyectable para tests.
 * @param {string} [opts.updateInterval] - Override del default '1 hour'.
 * @returns {object} { configured: boolean, reason?: string }
 *   `configured: true` ⇒ el lib fue llamado.
 *   `configured: false` ⇒ skipeado, `reason` explica por qué.
 */
function setupAutoUpdate(opts = {}) {
  const {
    logger,
    app = require('electron').app,
    env = process.env,
    platform = process.platform,
    updateElectronApp,
    updateInterval = DEFAULT_UPDATE_INTERVAL,
  } = opts

  if (!logger) {
    // Falla loud — un wire sin logger sería invisible silenciosa.
    throw new Error('setupAutoUpdate: logger is required')
  }

  // Skip 1: dev mode. update-electron-app explícitamente refuses to run in
  // unpackaged apps (su own assert), pero adelantamos el chequeo para WARN
  // claro en logs en vez de stack trace.
  if (!app.isPackaged) {
    logger.warn(SOURCE, 'skipped: app is not packaged (dev mode)')
    return { configured: false, reason: 'not-packaged' }
  }

  // Skip 2: escape hatch. Útil para QA / debugging del browser sin que el
  // updater interfiera (chequeos, downloads, restart prompts).
  if (env.OZ_UPDATE_DISABLED === '1') {
    logger.warn(SOURCE, 'skipped: OZ_UPDATE_DISABLED=1')
    return { configured: false, reason: 'disabled-by-env' }
  }

  // Skip 3: Windows + Linux NOT supported v1. Etapa 8 abre Windows builds y
  // entonces relajamos esto. No skipeamos en linux porque podríamos querer
  // CI smoke tests en linux runners; pero por ahora explícito a darwin.
  if (platform !== 'darwin') {
    logger.warn(SOURCE, 'skipped: platform not supported in v1', { platform })
    return { configured: false, reason: 'unsupported-platform' }
  }

  // Skip 4: bucket no armado. Jose tiene que crear el R2 bucket + setear
  // la env var en el packaged build (via `extraMetadata` o env de signing).
  // Sin esto, el wire es ruido.
  const baseUrl = env.OZ_UPDATE_BASE_URL
  if (!baseUrl) {
    logger.warn(SOURCE, 'skipped: OZ_UPDATE_BASE_URL not set', {
      hint: 'Set this to the R2 bucket public URL once Etapa 3e is wired',
    })
    return { configured: false, reason: 'no-base-url' }
  }

  // Lib HTTPS-only assert; falla early si Jose pasa http://. Mejor que
  // descubrirlo via el assert genérico del lib.
  if (!/^https:\/\//.test(baseUrl)) {
    logger.error(SOURCE, 'OZ_UPDATE_BASE_URL must be HTTPS', { baseUrl })
    return { configured: false, reason: 'invalid-base-url' }
  }

  // Lazy require: el lib se intenta cargar SOLO si vamos a usarlo. En dev
  // mode evitamos cargar deps innecesarias al boot. Inyectable para tests.
  let updateAppFn = updateElectronApp
  if (!updateAppFn) {
    try {
      updateAppFn = require('update-electron-app').updateElectronApp
    } catch (err) {
      logger.error(SOURCE, 'require update-electron-app failed', {
        message: err.message,
      })
      return { configured: false, reason: 'require-failed' }
    }
  }

  // Adapter al interface que update-electron-app espera: `{ log: function }`.
  // Mapeamos a INFO de nuestro logger (todos los mensajes del updater son
  // operacionales — no hay distinción WARN/ERROR en su output).
  const updaterLogger = {
    log: (...args) => {
      logger.info(SOURCE, args.map((a) => String(a)).join(' '))
    },
  }

  try {
    // UpdateSourceType.StaticStorage es numeric `1` en el lib; lo dejamos
    // hardcodeado en vez de require('update-electron-app').UpdateSourceType
    // para no double-require. Si el lib cambia el enum, los tests lo
    // atrapan (revisamos updateSource.type === 1).
    updateAppFn({
      updateSource: {
        type: 1, // UpdateSourceType.StaticStorage
        baseUrl,
      },
      updateInterval,
      logger: updaterLogger,
      notifyUser: true, // dialog nativo del OS al user, opciones Restart now / Later
    })
    logger.info(SOURCE, 'configured', {
      baseUrl,
      updateInterval,
      notifyUser: true,
    })
    return { configured: true }
  } catch (err) {
    // Nunca crashear el browser por update-electron-app. Si falla acá, el
    // usuario puede seguir usando OZ; lo peor que pasa es que no recibe
    // updates hasta el próximo restart.
    logger.error(SOURCE, 'updateElectronApp call failed', {
      message: err.message,
    })
    return { configured: false, reason: 'lib-error' }
  }
}

module.exports = {
  setupAutoUpdate,
  _testHelpers: { DEFAULT_UPDATE_INTERVAL, SOURCE },
}
