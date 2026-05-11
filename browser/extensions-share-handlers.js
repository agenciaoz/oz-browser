// OZ Browser — Extension Share handlers (E2-C-7).
//
// Handler map shared by IPC + MCP. Pure adapter — delegates to
// ExtensionShareManager.
//
// Doc: docs/modules/extensions-share-handlers.md

function buildExtensionShareHandlers(browser) {
  const sm = () => browser.extensionShareManager

  return {
    listInstalled() {
      if (!sm()) return []
      return sm().listInstalledInDefault()
    },
    listEnabled(identityId) {
      if (!sm()) return []
      return sm().listEnabledForIdentity(identityId)
    },
    report(identityId) {
      if (!sm()) return []
      return sm().reportForIdentity(identityId)
    },
    async enable(identityId, extensionId) {
      if (!sm()) return { ok: false, reason: 'no-manager' }
      const r = await sm().enableForIdentity(identityId, extensionId)
      if (r && r.ok && browser && typeof browser.broadcastToWebUI === 'function') {
        browser.broadcastToWebUI('oz:extensions:changed', { identityId, extensionId })
      }
      return r
    },
    disable(identityId, extensionId) {
      if (!sm()) return { ok: false, reason: 'no-manager' }
      const r = sm().disableForIdentity(identityId, extensionId)
      if (r && r.ok && browser && typeof browser.broadcastToWebUI === 'function') {
        browser.broadcastToWebUI('oz:extensions:changed', { identityId, extensionId })
      }
      return r
    },
  }
}

module.exports = { buildExtensionShareHandlers }
