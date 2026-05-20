// OZ Browser — Quick Access Bar (v1.6.4, extended v1.7.3 con actions).
//
// Horizontal toolbar de iconos chicos debajo del URL bar. Click → abre la URL
// en la identity activa via oz.tabs.openInIdentity, OR dispara una acción
// interna (v1.7.3 — session-token shortcut). Hardcoded el preset "Agencia full"
// por ahora (whatsmyip + IG + X + FB + TT + YT + LinkedIn + Threads + 🍪
// Session) — si se necesita customización, mover a settings.quickAccess.urls
// y exponer panel en Settings.
//
// Pattern: IIFE registra window.OZ.quickAccessBar para consistencia con el
// resto de UI singletons (settingsMcpPane, scheduledActionsUI, etc).

;(function () {
  // Each entry: {key, label (i18n), url | action, abbrev, bg}.
  //  - `key`: stable id for i18n + DOM data-attribute.
  //  - `label`: i18n key (full descriptor for accessibility / tooltip).
  //  - `url`: target URL opened in the active identity. Exclusive con `action`.
  //  - `action`: internal action id (v1.7.3 — 'session-token' dispatches to
  //    window.OZ.AccountManager.openSessionShortcut()). Exclusive con `url`.
  //  - `abbrev`: 1-3 char fallback shown when icon SVG is not used (avoids
  //    bundling third-party logos that have trademark restrictions). Para
  //    'action' entries puede ser emoji (no trademark issue).
  //  - `bg`: brand-colored background so the user recognizes by color.
  const SITES = [
    // 1.7.3: Session-token shortcut FIRST so it's always visible regardless
    // of sidebar width (the bar truncates last entries when it overflows).
    // NO url — dispatches to AccountManager.openSessionShortcut() which
    // opens AM directly on the session view with active identity selected.
    {
      key: 'session-token',
      label: 'quickAccess.tooltipSessionToken',
      action: 'session-token',
      abbrev: '🍪',
      bg: 'linear-gradient(135deg, #f59e0b, #c2410c)',
    },
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
        // 1.7.3: entries are mutually exclusive — `url` (open in identity)
        // or `action` (dispatch internal handler). We set whichever the
        // entry provides; click handler routes based on which dataset prop
        // is present.
        if (site.url) btn.dataset.url = site.url
        if (site.action) btn.dataset.action = site.action
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
        // 1.7.3: action entries take precedence — internal dispatch.
        const action = btn.dataset.action
        if (action) {
          this._dispatchAction(action, btn)
          return
        }
        const url = btn.dataset.url
        if (!url) return
        this._openInActiveIdentity(url, btn)
      })
    }

    _dispatchAction(action, btn) {
      // 1.7.3: internal action dispatcher. Adding new actions = new
      // case here + new SITES entry with {action} instead of {url}.
      // Visual feedback (click flash) mirrors the URL path for parity.
      if (action === 'session-token') {
        if (
          window.OZ &&
          window.OZ.AccountManager &&
          typeof window.OZ.AccountManager.openSessionShortcut === 'function'
        ) {
          window.OZ.AccountManager.openSessionShortcut().catch((err) => {
            window.oz &&
              window.oz.log &&
              window.oz.log.warn('quick-access', 'session-token failed', {
                message: err && err.message,
              })
          })
          btn.classList.add('clicked')
          setTimeout(() => btn.classList.remove('clicked'), 250)
        }
        return
      }
      window.oz &&
        window.oz.log &&
        window.oz.log.warn('quick-access', 'unknown action', { action })
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
