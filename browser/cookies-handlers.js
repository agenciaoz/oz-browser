// OZ Browser — Cookies handlers (export / import) (1.7c, extended 1.7.0).
//
// Qué hace: handler map para exportar e importar cookies de una identity en
// los 5 formatos soportados (oz | netscape | adspower | multilogin | header).
//
// Doc: docs/modules/cookies-handlers.md
// ADR: docs/architecture/0016-tab-context-menu.md (sección Cookies I/O)
// ADR-1.7.0: docs/architecture/0031-session-token-login.md (to write)
//
// Exports: buildCookieHandlers(browser) -> Record<string, fn>
//
// Bridge a Electron: usa session.cookies.get({}) para leer y session.cookies.set()
// para escribir bulk. Toda la lógica de formato vive en cookies-io.js (puro,
// testeable sin GUI).
//
// IPC channels (registrados en ipc-handlers.js):
//   - oz:cookies:export(identityId, format)         → { ok, content }
//   - oz:cookies:exportToFile(identityId, format, filePath)
//   - oz:cookies:import(identityId, format, content, options?) → { ok, count }
//   - oz:cookies:importFromFile(identityId, format, filePath, options?)
//
// 1.7.0 — Session-token login: el formato 'header' acepta un options.defaultDomain
// para hidratar `name=value; name=value; ...` (DevTools Cookie header paste).

const fs = require('fs')
const log = require('./logger')
const { encode, decode, SUPPORTED_FORMATS } = require('./cookies-io')

function buildCookieHandlers(browser) {
  const im = () => browser.identityManager

  /**
   * Read all cookies of an identity's session.
   * Returns canonical cookie array (Electron's cookies.get({}) shape).
   */
  async function readJar(identityId) {
    const ident = im() && im().get(identityId)
    if (!ident) return null
    const ses = im().getSession(identityId)
    if (!ses || !ses.cookies) return null
    const all = await ses.cookies.get({})
    return all || []
  }

  /**
   * Write canonical cookies to an identity's session via session.cookies.set().
   * Returns { written, errors[] }.
   */
  async function writeJar(identityId, cookies) {
    const ses = im().getSession(identityId)
    if (!ses || !ses.cookies) return { written: 0, errors: ['no-session'] }
    let written = 0
    const errors = []
    for (const c of cookies || []) {
      // Build the URL the Electron set() API requires. domain ".x.com" → "https://x.com",
      // domain "x.com" → "https://x.com". Use https + secure flag if cookie is secure.
      const bareDomain = (c.domain || '').replace(/^\./, '')
      const scheme = c.secure ? 'https' : 'http'
      const path = c.path || '/'
      const url = `${scheme}://${bareDomain}${path}`
      try {
        await ses.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path,
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expirationDate,
          sameSite: c.sameSite || 'no_restriction',
        })
        written += 1
      } catch (err) {
        errors.push({ name: c.name, domain: c.domain, message: err.message })
      }
    }
    return { written, errors }
  }

  return {
    SUPPORTED_FORMATS,

    /** Export cookies → string content. Useful for piping or testing. */
    async exportContent(identityId, format) {
      if (!SUPPORTED_FORMATS.includes(format)) {
        return { ok: false, reason: 'unsupported-format', format }
      }
      const jar = await readJar(identityId)
      if (jar === null) {
        return { ok: false, reason: 'identity-not-found', identityId }
      }
      const content = encode(format, jar)
      log.info('cookies-handlers', 'exportContent ok', {
        identityId,
        format,
        cookieCount: jar.length,
        size: content.length,
      })
      return { ok: true, identityId, format, content, cookieCount: jar.length }
    },

    /** Export cookies → file. Returns { ok, filePath, cookieCount }. */
    async exportToFile(identityId, format, filePath) {
      const r = await this.exportContent(identityId, format)
      if (!r.ok) return r
      try {
        fs.writeFileSync(filePath, r.content, 'utf-8')
      } catch (err) {
        log.error('cookies-handlers', 'exportToFile write failed', {
          filePath,
          message: err.message,
        })
        return { ok: false, reason: 'write-failed', message: err.message }
      }
      log.info('cookies-handlers', 'exportToFile ok', {
        identityId,
        format,
        filePath,
        cookieCount: r.cookieCount,
      })
      return { ok: true, identityId, format, filePath, cookieCount: r.cookieCount }
    },

    /**
     * Import cookies from string content. Returns { ok, written, errors }.
     *
     * @param {string} identityId
     * @param {string} format     One of cookies-io's SUPPORTED_FORMATS.
     * @param {string} content
     * @param {object} [options]  Format-specific options. The 'header' format
     *   requires { defaultDomain: 'domain.tld' or '.domain.tld' } because
     *   the Cookie request header carries no domain info. The other formats
     *   ignore options.
     */
    async importContent(identityId, format, content, options) {
      if (!SUPPORTED_FORMATS.includes(format)) {
        return { ok: false, reason: 'unsupported-format', format }
      }
      const ident = im() && im().get(identityId)
      if (!ident) {
        return { ok: false, reason: 'identity-not-found', identityId }
      }
      let parsed
      try {
        parsed = decode(format, content, options || {})
      } catch (err) {
        log.warn('cookies-handlers', 'importContent decode failed', {
          format,
          message: err.message,
        })
        // Surface options-related errors with a distinct reason so callers
        // (UI, MCP) can prompt the user for a defaultDomain instead of
        // claiming the cookie string itself is malformed.
        const reason =
          err.code === 'COOKIES_FORMAT_ERROR' && /defaultDomain/.test(err.message)
            ? 'missing-default-domain'
            : 'parse-failed'
        return { ok: false, reason, message: err.message }
      }
      const { written, errors } = await writeJar(identityId, parsed)
      log.info('cookies-handlers', 'importContent ok', {
        identityId,
        format,
        parsedCount: parsed.length,
        written,
        errorCount: errors.length,
      })
      return {
        ok: true,
        identityId,
        format,
        parsedCount: parsed.length,
        written,
        errors,
      }
    },

    /** Import cookies from file. */
    async importFromFile(identityId, format, filePath, options) {
      let content
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        return { ok: false, reason: 'read-failed', message: err.message }
      }
      return this.importContent(identityId, format, content, options)
    },
  }
}

module.exports = { buildCookieHandlers }
