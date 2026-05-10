// OZ Browser — WebUI bootloader. Boots TabStrip + IdentitySidebar after the
// dependencies (oz-utils.js, tabstrip.js, identity-editor.js, sidebar.js) have
// been loaded.
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const tabstrip = new window.OZ.TabStrip()
  const sidebar = new window.OZ.IdentitySidebar()
  const wsSwitcher = window.OZ.WorkspaceSwitcher
    ? new window.OZ.WorkspaceSwitcher()
    : null
  // 1.8d: Proxy Manager modal — instantiate so the sidebar button wire works.
  const proxyManagerUI = window.OZ.ProxyManagerUI ? new window.OZ.ProxyManagerUI() : null
  window.tabstrip = tabstrip
  window.ozsidebar = sidebar
  window.ozWsSwitcher = wsSwitcher
  window.ozProxyManagerUI = proxyManagerUI
  ;(async () => {
    await tabstrip.init()
    await sidebar.init()
    if (wsSwitcher) await wsSwitcher.init()
  })().catch((err) => {
    console.error('[oz/webui] boot failed:', err)
    if (window.oz && window.oz.log) {
      window.oz.log.reportError({
        source: 'webui/boot',
        message: err.message || String(err),
        stack: err.stack,
      })
    }
  })
})()
