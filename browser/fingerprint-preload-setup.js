// OZ Browser — Fingerprint preload session-init hook setup (1.9b extracted).
//
// Extraído de main.js en v1.4.3 para mantener main.js ≤500 LOC budget (ADR 0005),
// sin cambios de lógica — exactamente el mismo bloque que vivía inline en
// `Browser.init()` post-`fingerprintEngine = new FingerprintEngine()`.
//
// Wirea un session-init hook en IdentityManager que aplica el fingerprint
// profile a cada session de identity nueva en dos capas (defense-in-depth):
//
//   (a) session.setUserAgent — defense at network layer. Chrome's network
//       stack uses this for fetch headers even if a renderer somehow bypasses
//       our preload.
//   (b) registerPreloadScript — content-world overrides via webFrame
//       executeJavaScript (see preload-fingerprint.js).
//
// Both layers must agree to defeat fingerprinting tools that compare
// navigator.userAgent vs request UA (a classic mismatch detection).

const path = require('path')
const { app } = require('electron')
const log = require('./logger')

function setupFingerprintPreload(browser) {
  if (!browser || !browser.identityManager || !browser.fingerprintEngine) return false
  const fpPreloadPath = path.join(app.getAppPath(), 'browser', 'preload-fingerprint.js')
  browser.identityManager.addSessionInitHook((identityId, session) => {
    const ident = browser.identityManager.get(identityId)
    if (!ident) return
    const fp = browser.fingerprintEngine.getOrCreate(identityId, ident.fingerprintSeed)
    if (fp && fp.ua) {
      session.setUserAgent(fp.ua, fp.language || 'en-US')
      log.debug('fingerprint-preload-setup', 'session UA set from FP', {
        identityId,
        ua: fp.ua,
      })
    }
    if (typeof session.registerPreloadScript === 'function') {
      session.registerPreloadScript({
        type: 'frame',
        id: 'oz-fingerprint-preload',
        filePath: fpPreloadPath,
      })
    }
  })
  return true
}

module.exports = { setupFingerprintPreload }
