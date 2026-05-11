// OZ Browser — Extensions per-identity setup glue (E2-C-7).
//
// Extraído de main.js para respetar ADR 0005 (≤500 LOC). Encapsula:
//   - instanciación del ExtensionShareManager
//   - wiring del session-init hook que carga las extensions enabled en
//     cada partition de identity custom al primer hit
//
// Doc: docs/modules/extensions-share.md

const log = require('./logger')
const { ExtensionShareManager } = require('./extensions-share')

/**
 * Wires per-identity extension sharing into the Browser instance. Called
 * from main.js right after loadExtensions() has populated defaultSession
 * with Web Store + local extensions.
 *
 * @param {Browser} browser
 * @returns {ExtensionShareManager} the instance attached to browser
 */
function setupExtensionShare(browser) {
  browser.extensionShareManager = new ExtensionShareManager({
    identityManager: browser.identityManager,
  })

  // fire-and-forget — loadExtension is async but we don't block session
  // creation on it (extensions can finish loading after the first page
  // navigation; pages re-load after extension fully ready).
  browser.identityManager.addSessionInitHook((identityId, ses) => {
    browser.extensionShareManager.hookSessionInit(identityId, ses).catch((err) =>
      log.error('browser', 'extensionShareManager.hookSessionInit failed', {
        identityId,
        message: err.message,
      }),
    )
  })

  log.info('browser', 'ExtensionShareManager loaded', {
    installedCount: browser.extensionShareManager.listInstalledInDefault().length,
  })

  return browser.extensionShareManager
}

module.exports = { setupExtensionShare }
