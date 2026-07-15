// OZ Browser — proxy boot wiring (extracted from main.js per ADR 0005, 500 LOC).
// Doc: docs/modules/proxy-boot-setup.md
//
// Constructs the StickyRotation, imports + auto-assigns the license proxy
// bundle (with fail-closed enforcement), and installs the identity proxy
// resolution hook so every new session gets its proxy applied on create.

const { toProxyRulesString } = require('./proxy-assignment')
const { StickyRotation } = require('./proxy-sticky-rotation')
const { bootstrapForBoot } = require('./license-proxies')

/**
 * @param {object} browser - the Browser instance (has proxyAssignment,
 *   identityManager, proxyManager). Sets browser.stickyRotation + enforceProxy.
 * @param {object} licenseManager
 * @param {object} log
 */
function wireProxyBoot(browser, licenseManager, log) {
  browser.stickyRotation = new StickyRotation({
    proxyAssignment: browser.proxyAssignment,
    toProxyRulesString,
    identityManager: browser.identityManager,
    logger: log,
  })
  // alpha.100: import + auto-assign the license proxy bundle, decide fail-closed.
  bootstrapForBoot(browser, licenseManager, log)
  // alpha.101: auto-failover — si un tab falla la carga por el proxy (túnel
  // caído / no-exit del móvil), rotar a otro proxy sano y recargar.
  require('./proxy-failover').registerFailoverHandler((identityId, reason) =>
    require('./proxy-failover').rotateIdentityProxy(browser, identityId, reason),
  )
  browser.identityManager.setProxyResolutionHook((identityId, session) => {
    // applyForIdentity rotates if stale + setProxy in one call.
    browser.stickyRotation.applyForIdentity(identityId, session).catch((err) => {
      log.error('browser', 'sticky rotation apply failed', {
        identityId,
        message: err && err.message,
      })
    })
  })
}

module.exports = { wireProxyBoot }
