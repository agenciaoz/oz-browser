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
  // Fase 7: medidor real de bandwidth por proxy. Acumula bytes por proxyId y
  // los vuelca al proxy-manager cada 30s (flush en batch, no por request).
  const { BandwidthAccumulator, attachBandwidthMeter } = require('./proxy-bandwidth')
  browser.bandwidthAccumulator = new BandwidthAccumulator({
    sink: (batch) => {
      for (const [pid, bytes] of batch) {
        browser.proxyManager.addBandwidth(pid, bytes, { persist: false })
      }
      if (typeof browser.proxyManager._save === 'function') browser.proxyManager._save()
    },
  })
  browser._bandwidthFlushTimer = setInterval(() => {
    try {
      browser.bandwidthAccumulator.flush()
    } catch (_e) {
      /* best-effort */
    }
  }, 30000)
  if (browser._bandwidthFlushTimer.unref) browser._bandwidthFlushTimer.unref()
  const _bwAttached = new WeakSet()

  browser.identityManager.setProxyResolutionHook((identityId, session) => {
    // applyForIdentity rotates if stale + setProxy in one call.
    browser.stickyRotation.applyForIdentity(identityId, session).catch((err) => {
      log.error('browser', 'sticky rotation apply failed', {
        identityId,
        message: err && err.message,
      })
    })
    // Fase 7: enganchar el medidor de bandwidth a esta sesión una sola vez.
    if (session && !_bwAttached.has(session)) {
      const ok = attachBandwidthMeter({
        session,
        identityId,
        resolveProxyId: (id) => {
          try {
            const p = browser.proxyAssignment.resolve({ identityId: id })
            return p && p.id ? p.id : null
          } catch (_e) {
            return null
          }
        },
        accumulator: browser.bandwidthAccumulator,
      })
      if (ok) _bwAttached.add(session)
    }
  })

  // alpha.109: resolver de política WebRTC por identity. Usa resolveRouting
  // (alpha.108) + el flag enforce del install para decidir. tabs.js lo llama
  // al materializar cada webContents. Cierra el leak de IP real por WebRTC en
  // la fuente (complementa "todo proxiado siempre").
  try {
    const { decideWebRtcPolicy } = require('./webrtc-policy')
    const { setWebRtcPolicyResolver } = require('./tabs')
    setWebRtcPolicyResolver((identityId) => {
      let routingMode = 'none'
      try {
        const pa = browser.proxyAssignment
        if (pa && typeof pa.resolveRouting === 'function') {
          const ident =
            browser.identityManager && browser.identityManager.get
              ? browser.identityManager.get(identityId)
              : null
          routingMode = pa.resolveRouting({
            identityId,
            workspaceId: ident && ident.workspaceId,
          }).mode
        }
      } catch (_e) {
        /* default routingMode */
      }
      const override =
        browser.settingsManager && browser.settingsManager.get
          ? (browser.settingsManager.get('privacy') || {}).webrtcPolicy
          : undefined
      return decideWebRtcPolicy({
        routingMode,
        enforce: !!browser.enforceProxy,
        override,
      })
    })
  } catch (e) {
    log.warn('proxy-boot-setup', 'webrtc policy resolver wiring failed', {
      message: e && e.message,
    })
  }
}

module.exports = { wireProxyBoot }
