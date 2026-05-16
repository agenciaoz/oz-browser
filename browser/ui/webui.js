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
  // v1.4.6: 5-step action wizard (workspace → proxies → identities → assign → test).
  const onboardingWizard = window.OZ.OnboardingWizard
    ? new window.OZ.OnboardingWizard()
    : null
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
  window.ozOnboardingWizard = onboardingWizard
  window.ozBrowsingDataUI = browsingDataUI
  window.ozCommandPaletteUI = commandPaletteUI
  window.ozBulkOpenerUI = bulkOpenerUI
  ;(async () => {
    await tabstrip.init()
    await sidebar.init()
    if (wsSwitcher) await wsSwitcher.init()

    // C-8: wire the new Health Check button (toolbar footer). The other
    // toolbar buttons hook themselves up via document.getElementById in
    // their own modules (account-manager.js, time-machine.js, etc).
    // Health is a singleton self-instantiated in health-modal.js but its
    // open() takes an identityId — we pass the active one.
    const healthBtn = document.getElementById('oz-health-button')
    if (healthBtn) {
      healthBtn.addEventListener('click', async () => {
        const activeId = await window.oz.identities.getActive()
        if (window.OZ && window.OZ.HealthCheck && activeId) {
          window.OZ.HealthCheck.open(activeId)
        }
      })
    }

    // 1.10c: trigger onboarding if first run. Must run after sidebar init so
    // the WebUI is ready to receive setContentVisible IPC properly.
    let welcomeShown = false
    if (onboardingUI) {
      welcomeShown = await onboardingUI.maybeOpen()
    }
    // v1.4.6: open the action wizard if user hasn't already completed it
    // AND welcome modal isn't currently showing (avoid stacking modals).
    // Independent flag so users can re-trigger from Settings without
    // re-seeing the welcome info screens. If welcome IS showing, the wizard
    // auto-opens on the NEXT boot once welcome is dismissed — keeps the
    // UX linear instead of overlapping.
    if (
      !welcomeShown &&
      onboardingWizard &&
      window.oz &&
      window.oz.settings
    ) {
      try {
        const wiz = await window.oz.settings.get('onboardingWizard')
        if (!wiz || !wiz.completed) {
          onboardingWizard.open()
        }
      } catch (_e) {
        // settings get failed — skip silently. Wizard is launchable from Settings.
      }
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
