// OZ Browser — proxy auto-failover (v2.0.0-alpha.101).
//
// Los proxies móviles (Decodo) a veces devuelven un fallo transitorio de túnel
// ("no suitable exit node" → ERR_TUNNEL_CONNECTION_FAILED) que deja la página
// en blanco. En vez de que el usuario quede trabado, rotamos la identidad a
// OTRO proxy sano y recargamos el tab automáticamente. `rotateIdentityProxy`
// es el núcleo reutilizable (auto + acción manual futura = botón/tool).
//
// Pure-ish: recibe el `browser` como arg. Sin loops: cooldown por identidad.

const log = require('./logger')

// errorDescription strings de Electron did-fail-load que indican fallo de
// proxy/conexión (no un 404 legítimo del sitio).
const PROXY_ERR =
  /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_PROXY_CERTIFICATE_INVALID|ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/i

const COOLDOWN_MS = 12000 // no rotar la misma identidad más de una vez/12s
const _lastRotate = new Map() // identityId -> ts

let _handler = null

/** main.js registra el rotador real (que tiene acceso al browser). */
function registerFailoverHandler(fn) {
  _handler = fn
}

function isProxyError(desc) {
  return PROXY_ERR.test(String(desc || ''))
}

/**
 * Llamado desde Tab en 'did-fail-load'. Si es fallo de proxy, dispara la
 * rotación (con cooldown) y recarga el tab cuando termina.
 */
async function onNavFail(tab, _errorCode, errorDesc) {
  if (!tab || !tab.identityId || !isProxyError(errorDesc)) return
  const now = Date.now()
  if (now - (_lastRotate.get(tab.identityId) || 0) < COOLDOWN_MS) return
  _lastRotate.set(tab.identityId, now)
  log.warn('proxy-failover', 'nav failure → rotating proxy', {
    identityId: tab.identityId,
    errorDesc,
  })
  if (!_handler) return
  try {
    const r = await _handler(tab.identityId, 'auto')
    if (r && r.ok && typeof tab.reload === 'function') {
      setTimeout(() => {
        try {
          tab.reload()
        } catch (_e) {
          /* tab may be gone */
        }
      }, 300)
    }
  } catch (e) {
    log.error('proxy-failover', 'handler threw', { message: e && e.message })
  }
}

/** Elegí un proxy asignable sano distinto del actual (menor failureCount). */
function pickFailoverProxy(proxyManager, currentProxyId) {
  const list =
    (proxyManager.listAssignable ? proxyManager.listAssignable() : proxyManager.list()) ||
    []
  const healthy = list.filter(
    (p) => p && p.id !== currentProxyId && !p.isDisabled && p.isActive,
  )
  if (healthy.length === 0) return null
  healthy.sort((a, b) => (a.failureCount || 0) - (b.failureCount || 0))
  const best = healthy[0].failureCount || 0
  const pool = healthy.filter((p) => (p.failureCount || 0) === best)
  return pool[Math.floor(Math.random() * pool.length)].id
}

/**
 * Rota la identidad a otro proxy sano y lo aplica a su sesión. Núcleo
 * compartido por el auto-failover y la acción manual.
 * @returns {{ok:boolean, from?:string, to?:string, reason?:string}}
 */
async function rotateIdentityProxy(browser, identityId, reason = 'manual') {
  if (!browser || !identityId) return { ok: false, reason: 'bad_args' }
  const pa = browser.proxyAssignment
  const pm = browser.proxyManager
  if (!pa || !pm) return { ok: false, reason: 'no_managers' }

  const current = pa.resolve ? pa.resolve({ identityId }) : null
  const currentId = current && current.id
  const next = pickFailoverProxy(pm, currentId)
  if (!next) return { ok: false, reason: 'no_healthy_proxy' }

  pa.assignToIdentity(identityId, next)
  try {
    const resolved = browser.identityManager.resolve(identityId)
    if (browser.stickyRotation && resolved && resolved.session) {
      await browser.stickyRotation.applyForIdentity(
        resolved.identity.id,
        resolved.session,
      )
    }
  } catch (e) {
    log.warn('proxy-failover', 'apply failed', { message: e && e.message })
  }
  log.info('proxy-failover', 'rotated identity proxy', {
    identityId,
    from: currentId,
    to: next,
    reason,
  })
  return { ok: true, from: currentId, to: next }
}

module.exports = {
  registerFailoverHandler,
  onNavFail,
  rotateIdentityProxy,
  pickFailoverProxy,
  isProxyError,
}
