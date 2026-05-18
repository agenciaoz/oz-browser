// OZ Browser — Quick Access Bar (v1.6.4).
//
// Horizontal toolbar de iconos chicos debajo del URL bar. Click → abre la URL
// en la identity activa via oz.tabs.openInIdentity. Hardcoded el preset
// "Agencia full" por ahora (whatsmyip + IG + X + FB + TT + YT + LinkedIn +
// Threads) — si se necesita customización, mover a settings.quickAccess.urls
// y exponer panel en Settings.
//
// Pattern: IIFE registra window.OZ.quickAccessBar para consistencia con el
// resto de UI singletons (settingsMcpPane, scheduledActionsUI, etc).

;(function () {
  // Each entry: {key, label (i18n), url, abbrev, bg}.
  //  - `key`: stable id for i18n + DOM data-attribute.
  //  - `label`: i18n key (full descriptor for accessibility / tooltip).
  //  - `url`: target URL opened in the active identity.
  //  - `abbrev`: 1-3 char fallback shown when icon SVG is not used (avoids
  //    bundling third-party logos that have trademark restrictions).
  //  - `bg`: brand-colored background so the user recognizes by color.
  const SITES = [
    {
      key: 'whatsmyip',
      label: 'quickAccess.tooltipWhatsmyip',
      url: 'https://whatsmyip.com/',
      abbrev: 'IP',
      bg: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
    },
    {
      key: 'instagram',
      label: 'quickAccess.tooltipInstagram',
      url: 'https://www.instagram.com/',
      abbrev: 'IG',
      bg: 'linear-gradient(135deg, #feda75, #fa7e1e 30%, #d62976 60%, #962fbf 80%, #4f5bd5)',
    },
    {
      key: 'x',
      label: 'quickAccess.tooltipX',
      url: 'https://x.com/',
      abbrev: 'X',
      bg: '#0f1419',
    },
    {
      key: 'facebook',
      label: 'quickAccess.tooltipFacebook',
      url: 'https://www.facebook.com/',
      abbrev: 'f',
      bg: '#1877f2',
    },
    {
      key: 'tiktok',
      label: 'quickAccess.tooltipTiktok',
      url: 'https://www.tiktok.com/',
      abbrev: 'TT',
      bg: 'linear-gradient(135deg, #25f4ee, #000 50%, #fe2c55)',
    },
    {
      key: 'youtube',
      label: 'quickAccess.tooltipYoutube',
      url: 'https://www.youtube.com/',
      abbrev: '▶',
      bg: '#ff0000',
    },
    {
      key: 'linkedin',
      label: 'quickAccess.tooltipLinkedin',
      url: 'https://www.linkedin.com/',
      abbrev: 'in',
      bg: '#0a66c2',
    },
    {
      key: 'threads',
      label: 'quickAccess.tooltipThreads',
      url: 'https://www.threads.net/',
      abbrev: '@',
      bg: '#000',
    },
  ]

  function t(key) {
    if (window.oz && window.oz.i18n && typeof window.oz.i18n.t === 'function') {
      return window.oz.i18n.t(key)
    }
    return key
  }

  class QuickAccessBar {
    constructor() {
      this.$bar = document.getElementById('oz-quick-access-bar')
      if (!this.$bar) return
      this._render()
      this._wire()
    }

    _render() {
      this.$bar.innerHTML = ''
      for (const site of SITES) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'oz-qab-btn'
        btn.dataset.siteKey = site.key
        btn.dataset.url = site.url
        btn.style.background = site.bg
        btn.setAttribute('aria-label', t(site.label))
        btn.title = t(site.label)
        // Abbreviation as visible content. White text reads well over every
        // brand color in SITES (verified by hand).
        const span = document.createElement('span')
        span.className = 'oz-qab-abbrev'
        span.textContent = site.abbrev
        btn.appendChild(span)
        this.$bar.appendChild(btn)
      }
    }

    _wire() {
      this.$bar.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.oz-qab-btn')
        if (!btn) return
        const url = btn.dataset.url
        if (!url) return
        this._openInActiveIdentity(url, btn)
      })
    }

    async _openInActiveIdentity(url, btn) {
      if (!window.oz || !window.oz.identities || !window.oz.tabs) return
      try {
        const activeId = await window.oz.identities.getActive()
        if (!activeId) {
          window.oz.log && window.oz.log.warn('quick-access', 'no active identity')
          return
        }
        await window.oz.tabs.openInIdentity(activeId, url)
        // Brief visual feedback on the button to confirm the click registered.
        btn.classList.add('clicked')
        setTimeout(() => btn.classList.remove('clicked'), 250)
      } catch (err) {
        window.oz.log &&
          window.oz.log.error('quick-access', 'open failed', {
            url,
            message: err.message,
          })
      }
    }

    refreshTooltips() {
      // Called on locale change so tooltip strings re-render. Cheap — just
      // rewrites titles, no DOM rebuild.
      for (const btn of this.$bar.querySelectorAll('.oz-qab-btn')) {
        const site = SITES.find((s) => s.key === btn.dataset.siteKey)
        if (!site) continue
        const label = t(site.label)
        btn.title = label
        btn.setAttribute('aria-label', label)
      }
    }
  }

  function init() {
    window.OZ = window.OZ || {}
    if (window.OZ.quickAccessBar) return
    window.OZ.quickAccessBar = new QuickAccessBar()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
