// OZ Browser — Protocol handler oz:// (Bloque B-1).
//
// Qué hace: registra el `oz://` custom scheme + escucha apertures desde
// otras apps (típicamente: un browser externo que vuelve de un OAuth flow).
//
// Doc: docs/modules/protocol-handler.md
// ADR: docs/architecture/0023b-protocol-handler.md (pendiente)
//
// URL pattern soportado:
//   oz://auth/<provider>/callback?code=...&state=...
//   oz://team/invite?token=...
//   oz://billing/{success,cancel}?...
//
// Architecture:
//   - installProtocolHandler(browser) registra `oz://` + monta los listeners
//     globales (app.on('open-url') + app.on('second-instance')).
//   - registerProtocolDispatch(browser, namespace, callback) — cada feature
//     (auth provider, team mode, billing) registra su handler bajo un
//     namespace ('auth/dropbox', 'auth/supabase', 'team', 'billing').
//   - handleProtocolUrl(browser, url) parsea el URL y rutea al callback.
//
// macOS principal path: `app.on('open-url', (e, url) => ...)` fires si el
// .app ya está abierto. Si está cerrado, el OS abre el .app + el URL llega
// pre-ready via `process.argv` (Electron lo procesa) y termina disparando
// el mismo event después de whenReady. No necesitamos parsear argv directo
// en macOS.
//
// Windows / Linux path (futuro Etapa 3-Q): `app.requestSingleInstanceLock()`
// + `app.on('second-instance', (e, argv) => ...)` — el OS abre una segunda
// instancia con el URL en argv; el lock asegura que esa segunda instancia
// muera + el URL llegue al proceso original. Listo desde ahora aunque
// no se prueba live hasta el Windows port.

const { app } = require('electron')
const log = require('./logger')

const PROTOCOL = 'oz'

/**
 * Internal registry of namespace → callback. Populated by feature modules
 * via registerProtocolDispatch().
 */
const dispatchers = new Map()

/**
 * Register a dispatcher for a namespace path (e.g. 'auth/dropbox', 'team').
 * Path matching is prefix-based — the most-specific registered prefix wins.
 *
 * Callback signature:
 *   (browser, {host, pathSegments, query, raw}) => void
 *
 * Returns an unregister function so callers can clean up if needed.
 */
function registerProtocolDispatch(_browser, namespace, callback) {
  if (typeof namespace !== 'string' || !namespace) {
    throw new Error('registerProtocolDispatch: namespace must be a string')
  }
  if (typeof callback !== 'function') {
    throw new Error('registerProtocolDispatch: callback must be a function')
  }
  dispatchers.set(namespace, callback)
  log.info('protocol-handler', 'dispatcher registered', { namespace })
  return () => {
    dispatchers.delete(namespace)
    log.info('protocol-handler', 'dispatcher unregistered', { namespace })
  }
}

/**
 * Resolve a request to the most-specific registered dispatcher. Looks up
 * the full path first, then progressively trims the trailing segment.
 *
 * Example: incoming path 'auth/dropbox/callback' tries:
 *   'auth/dropbox/callback' → 'auth/dropbox' → 'auth' → null
 */
function resolveDispatcher(pathKey) {
  let probe = pathKey
  while (probe) {
    if (dispatchers.has(probe)) return { key: probe, callback: dispatchers.get(probe) }
    const idx = probe.lastIndexOf('/')
    if (idx < 0) break
    probe = probe.slice(0, idx)
  }
  return null
}

/**
 * Parse an oz:// URL into structured components + invoke the matching
 * dispatcher. Exported for unit tests.
 */
function handleProtocolUrl(browser, rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    log.warn('protocol-handler', 'handleProtocolUrl: invalid url', { rawUrl })
    return { ok: false, reason: 'invalid-url' }
  }
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (err) {
    log.warn('protocol-handler', 'handleProtocolUrl: URL parse failed', {
      rawUrl,
      message: err.message,
    })
    return { ok: false, reason: 'parse-failed', message: err.message }
  }
  if (parsed.protocol !== `${PROTOCOL}:`) {
    log.warn('protocol-handler', 'handleProtocolUrl: wrong protocol', {
      rawUrl,
      protocol: parsed.protocol,
    })
    return { ok: false, reason: 'wrong-protocol', protocol: parsed.protocol }
  }

  // URL parsing for custom schemes is finicky: `oz://auth/foo/bar?x=1` parses
  // as { host: 'auth', pathname: '/foo/bar', search: '?x=1' }. We normalize
  // into a single "namespace path" = host + pathSegments.
  const host = parsed.host || ''
  const pathSegments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  const pathKey = [host, ...pathSegments].join('/')
  const query = Object.fromEntries(parsed.searchParams.entries())

  const match = resolveDispatcher(pathKey)
  if (!match) {
    log.warn('protocol-handler', 'no dispatcher matched', {
      rawUrl,
      pathKey,
      registered: Array.from(dispatchers.keys()),
    })
    return { ok: false, reason: 'no-dispatcher', pathKey }
  }

  log.info('protocol-handler', 'dispatching', {
    pathKey,
    dispatcherKey: match.key,
    queryKeys: Object.keys(query),
  })
  try {
    match.callback(browser, { host, pathSegments, query, raw: rawUrl })
    return { ok: true, dispatcher: match.key }
  } catch (err) {
    log.error('protocol-handler', 'dispatcher callback threw', {
      pathKey,
      dispatcherKey: match.key,
      message: err.message,
      stack: err.stack,
    })
    return { ok: false, reason: 'dispatcher-error', message: err.message }
  }
}

/**
 * Install the protocol handler at app startup. Idempotent. Must be called
 * after `app.whenReady()` because `app.on('open-url')` requires the app
 * to be initialized.
 *
 * Behavior on each OS:
 *   - macOS: `open-url` fires both when the .app is open and on cold-start
 *     (Electron buffers the URL and re-fires after `app.whenReady()`).
 *   - Windows/Linux: relies on single-instance lock + 'second-instance' event,
 *     which is wired here defensively even though OZ ships macOS-first.
 */
function installProtocolHandler(browser) {
  // 1) Register the scheme. In a packaged app, electron-forge / Squirrel
  // also writes Info.plist + Windows registry; the API call is idempotent
  // and required so the dev mode (`npm start`) registers it too.
  const registered = app.setAsDefaultProtocolClient(PROTOCOL)
  log.info('protocol-handler', 'scheme registered', {
    scheme: PROTOCOL,
    registered,
  })

  // 2) macOS: 'open-url' on the app singleton.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    log.info('protocol-handler', 'open-url received', { url })
    handleProtocolUrl(browser, url)
  })

  // 3) Windows/Linux: 'second-instance' fires when another invocation tries
  // to start while we already own the single-instance lock. The URL arrives
  // in argv. We only enforce single-instance in PACKAGED builds — in dev
  // (`npm start`) Jose runs multiple instances regularly for testing, and
  // killing them silently would be confusing. macOS routes oz:// URLs via
  // open-url which doesn't need the lock either.
  if (app.isPackaged) {
    if (!app.requestSingleInstanceLock()) {
      log.warn('protocol-handler', 'second instance — quitting (lock held)')
      app.quit()
      return
    }
    app.on('second-instance', (_event, argv) => {
      const ozUrl = argv.find(
        (a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`),
      )
      if (ozUrl) {
        log.info('protocol-handler', 'second-instance url received', { url: ozUrl })
        handleProtocolUrl(browser, ozUrl)
      }
      // Bring the existing window to the front (Windows / Linux UX).
      if (browser && browser.windows && browser.windows.length > 0) {
        const win = browser.windows[0].window
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
      }
    })
  } else {
    log.info(
      'protocol-handler',
      'dev build — skipping single-instance lock (multi-instance allowed)',
    )
  }

  log.info('protocol-handler', 'install complete')
}

module.exports = {
  PROTOCOL,
  installProtocolHandler,
  registerProtocolDispatch,
  handleProtocolUrl,
  // Exposed for tests only — DO NOT USE in production code.
  _internals: { dispatchers, resolveDispatcher },
}
