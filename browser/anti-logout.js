// OZ Browser — Anti-logout: extender session cookies de redes sociales (1.5d).
//
// Doc: docs/modules/anti-logout.md
// Bloque: 1.5d (CORE)
//
// Problema que resolvemos: Ghost Browser (y la mayoría de browsers) deja que
// las "session cookies" (las que tienen Expires=session, sin fecha) se
// borren cuando cierra el navegador. Para 50+ cuentas de redes sociales que
// querés mantener logoneadas indefinidamente, eso significa re-loguear cada
// vez. NO es lo que querés.
//
// Solución (1.5d v1):
//   1. Hook a session.cookies.onChanged por cada identity session.
//   2. Cuando se setea una session cookie de un host whitelisted (X, IG, FB,
//      etc.), la re-setiamos con expirationDate = now + 1 año.
//   3. Loop guard (Map de cookie key → lastExtendedAt) evita re-extender la
//      misma cookie más de 1 vez por hora.
//   4. Detección de logout: si una cookie session crítica se borra (removed=
//      true), buscamos el account asociado y marcamos status='needs_relogin'
//      + system notification.
//
// Out of scope para v1:
//   - Health check daemon (cron passive navigation cada 6 días) — agregable
//     en sub-bloque futuro. Por ahora, la detección via cookie absence en
//     onChanged ya cubre el 80% de casos sin overhead de tabs background.
//   - Auto-relogin — cuando el user navega manualmente al /login, el
//     auto-fill de 1.5c rellena las credentials. No automático en background.
//
// Hosts whitelist: viene del array de site-templates.js. Cada template tiene
// `hosts` — los unimos todos.

const log = require('./logger')
const { TEMPLATES } = require('./site-templates')

// 1 año en ms.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

// 1 hora — cooldown entre re-extensiones de la misma cookie.
const REEXTEND_COOLDOWN_MS = 60 * 60 * 1000

// Hosts whitelist desde site-templates. Normalizamos sin www.
const SOCIAL_HOSTS = (() => {
  const set = new Set()
  for (const t of TEMPLATES) {
    for (const h of t.hosts) {
      const norm = h.toLowerCase().replace(/^www\./, '')
      set.add(norm)
      // También agregamos con prefix . para subdomain matching
      // (cookie.domain often is ".x.com" not "x.com")
      set.add('.' + norm)
    }
  }
  return set
})()

/** Returns true if cookie.domain belongs to a known social host. */
function isSocialCookie(cookie) {
  if (!cookie || !cookie.domain) return false
  const d = cookie.domain.toLowerCase()
  if (SOCIAL_HOSTS.has(d)) return true
  // Match por suffix (.x.com matchea x.com, www.x.com, mobile.x.com)
  for (const h of SOCIAL_HOSTS) {
    if (h.startsWith('.') && d.endsWith(h)) return true
  }
  return false
}

/** Returns true if cookie is a session cookie (no explicit expiry). */
function isSessionCookie(cookie) {
  // Electron cookie API uses session: true OR no expirationDate.
  return cookie.session === true || !cookie.expirationDate
}

/**
 * AntiLogout — install per-identity cookie hooks + global health check.
 *
 * Inyectable deps para tests:
 *   - identityManager: source of identity sessions
 *   - accountVault: optional. If null, skip needs_relogin status updates.
 *   - notificationFactory: function that returns a Notification-like object
 *     when called. Default: lazy require('electron').Notification.
 */
class AntiLogout {
  constructor({ identityManager, accountVault, notificationFactory } = {}) {
    this.identityManager = identityManager
    this.accountVault = accountVault || null
    this.notificationFactory = notificationFactory || _defaultNotification
    this._installed = new Map() // identityId → unhook function
    this._lastExtended = new Map() // `${identityId}:${name}@${domain}` → ts
  }

  /**
   * Install cookie hooks for all currently-cached sessions. New identities
   * created later need explicit installForIdentity() calls (or just call
   * install() again — it's idempotent).
   */
  install() {
    if (!this.identityManager) {
      log.warn('anti-logout', 'install called without identityManager — skip')
      return
    }
    for (const ident of this.identityManager.list()) {
      this.installForIdentity(ident.id)
    }
  }

  installForIdentity(identityId) {
    if (this._installed.has(identityId)) return // idempotent
    const session = this.identityManager.getSession(identityId)
    if (!session || !session.cookies || !session.cookies.on) {
      log.warn('anti-logout', 'session.cookies.on not available — skip', {
        identityId,
      })
      return
    }
    const listener = (_event, cookie, cause, removed) => {
      this._handleCookieChange(identityId, session, cookie, cause, removed)
    }
    session.cookies.on('changed', listener)
    this._installed.set(identityId, () => {
      try {
        session.cookies.removeListener('changed', listener)
      } catch (_e) {
        // best-effort
      }
    })
    log.info('anti-logout', 'cookie hook installed', {
      identityId,
      hostsCount: SOCIAL_HOSTS.size,
    })
  }

  uninstall() {
    for (const [_id, unhook] of this._installed) {
      unhook()
    }
    this._installed.clear()
    this._lastExtended.clear()
    log.info('anti-logout', 'all cookie hooks uninstalled')
  }

  /**
   * Cookie changed callback. Two paths:
   *   - !removed + isSocial + isSession: re-set with 1-year expiry (if
   *     cooldown allows).
   *   - removed + isSocial + cause is auth-relevant: try to flag account as
   *     needs_relogin.
   */
  _handleCookieChange(identityId, session, cookie, cause, removed) {
    if (!isSocialCookie(cookie)) return

    if (!removed && isSessionCookie(cookie)) {
      const key = `${identityId}:${cookie.name}@${cookie.domain}`
      const last = this._lastExtended.get(key) || 0
      const now = Date.now()
      if (now - last < REEXTEND_COOLDOWN_MS) {
        return // cooldown — already extended recently
      }
      this._lastExtended.set(key, now)
      this._extendCookieExpiry(identityId, session, cookie)
      return
    }

    // Removed path — detect logout. Cause 'expired' or 'expired-overwrite'
    // happens for the cookies WE extend, so skip those (loop guard).
    // 'explicit' is when site/JS explicitly clears (logout button).
    if (removed && (cause === 'explicit' || cause === 'overwrite')) {
      this._maybeFlagNeedsRelogin(identityId, cookie)
    }
  }

  _extendCookieExpiry(identityId, session, cookie) {
    const newExpiry = (Date.now() + ONE_YEAR_MS) / 1000 // Electron uses seconds
    // Reconstruct the URL from cookie domain (cookie.domain may start with .)
    const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`
    const setCookieDetails = {
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: newExpiry,
    }
    Promise.resolve(session.cookies.set(setCookieDetails))
      .then(() => {
        log.debug('anti-logout', 'cookie expiry extended', {
          identityId,
          name: cookie.name,
          domain: cookie.domain,
          newExpiryUnix: Math.floor(newExpiry),
        })
      })
      .catch((err) => {
        log.warn('anti-logout', 'failed to extend cookie expiry', {
          identityId,
          name: cookie.name,
          domain: cookie.domain,
          message: err.message,
        })
      })
  }

  _maybeFlagNeedsRelogin(identityId, cookie) {
    if (!this.accountVault) return // vault not wired (tests / no vault unlocked)
    if (!this.accountVault.isUnlocked) return // can't read accounts

    // Heuristic: only flag if the cookie name is a known session-marker for
    // the platform. v1 — flag any social cookie removal as candidate.
    // Refinement (futuro): per-template list of "critical session cookies"
    // (e.g. X uses 'auth_token', FB uses 'c_user').
    const accounts = this.accountVault.getAccounts()
    const matches = accounts.filter((a) => {
      const aHost = a.site && a.site.toLowerCase().replace(/^www\./, '')
      const cHost = cookie.domain.toLowerCase().replace(/^\./, '')
      return aHost && (cHost === aHost || cHost.endsWith('.' + aHost))
    })
    if (matches.length === 0) return

    let flagged = 0
    for (const a of matches) {
      if (a.identityId !== identityId) continue
      if (a.status === 'needs_relogin') continue
      a.status = 'needs_relogin'
      a.updatedAt = Date.now()
      flagged++
    }
    if (flagged > 0) {
      this.accountVault.setAccounts(accounts)
      log.warn('anti-logout', 'flagged accounts as needs_relogin', {
        identityId,
        count: flagged,
        cookieName: cookie.name,
        domain: cookie.domain,
      })
      this._notify(
        'OZ Browser',
        `${flagged} account(s) need re-login. Open Account Manager to fix.`,
      )
    }
  }

  _notify(title, body) {
    try {
      const Notification = this.notificationFactory()
      if (!Notification) return
      const n = new Notification({ title, body })
      if (typeof n.show === 'function') n.show()
    } catch (err) {
      log.warn('anti-logout', 'notification failed', { message: err.message })
    }
  }
}

function _defaultNotification() {
  try {
    const electron = require('electron')
    return electron.Notification
  } catch (_e) {
    return null
  }
}

module.exports = {
  AntiLogout,
  SOCIAL_HOSTS,
  isSocialCookie,
  isSessionCookie,
  ONE_YEAR_MS,
  REEXTEND_COOLDOWN_MS,
}
