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
  // 1.10a: Settings modal.
  const settingsUI = window.OZ.SettingsUI ? new window.OZ.SettingsUI() : null
  // 1.10c: First-run onboarding modal.
  const onboardingUI = window.OZ.OnboardingUI ? new window.OZ.OnboardingUI() : null
  // 1.10.5: Browsing Data modal (Bookmarks/History/Downloads).
  const browsingDataUI = window.OZ.BrowsingDataUI ? new window.OZ.BrowsingDataUI() : null
  // C-1: Command Palette (Cmd+K).
  const commandPaletteUI = window.OZ.CommandPaletteUI
    ? new window.OZ.CommandPaletteUI()
    : null
  // C-4: Bulk multi-account opener (⌥⇧O / sidebar button / palette).
  const bulkOpenerUI = window.OZ.BulkOpenerUI ? new window.OZ.BulkOpenerUI() : null
  window.tabstrip = tabstrip
  window.ozsidebar = sidebar
  window.ozWsSwitcher = wsSwitcher
  window.ozProxyManagerUI = proxyManagerUI
  window.ozSettingsUI = settingsUI
  window.ozOnboardingUI = onboardingUI
  window.ozBrowsingDataUI = browsingDataUI
  window.ozCommandPaletteUI = commandPaletteUI
  window.ozBulkOpenerUI = bulkOpenerUI
  ;(async () => {
    await tabstrip.init()
    await sidebar.init()
    if (wsSwitcher) await wsSwitcher.init()
    // 1.10c: trigger onboarding if first run. Must run after sidebar init so
    // the WebUI is ready to receive setContentVisible IPC properly.
    if (onboardingUI) {
      await onboardingUI.maybeOpen()
    }
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
