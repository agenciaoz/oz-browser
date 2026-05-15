// OZ Browser — i18n module (v1.1.0).
//
// Lightweight in-house i18n. NO runtime deps (i18next overkill for ~300 strings).
//
// Cómo se usa:
//   - HTML: <button data-i18n="settings.nav.general">General</button>
//     ↳ Si el catalog tiene settings.nav.general='Configuración general', se
//        reemplaza el textContent en translatePage().
//   - HTML attrs: <input data-i18n-attr="placeholder:settings.search.placeholder">
//     ↳ Reemplaza el atributo placeholder.
//   - JS: window.OZ.i18n.t('settings.nav.general')
//     ↳ Retorna el string traducido o el key si no existe.
//
// Locale flow:
//   1. Boot: lee window.oz.settings.get('general').locale (default 'auto')
//   2. Si 'auto' → window.oz.app.getSystemLocale() → 'es-XX' o 'en-XX'
//   3. Normaliza prefix: 'es-EC' → 'es', 'en-US' → 'en'
//   4. fetch('./locales/<lang>.json') con fallback a en.json
//   5. translatePage() pasa por todo data-i18n + data-i18n-attr en DOM
//   6. Cambio via window.OZ.i18n.setLocale('es') re-fetch + re-render

;(function () {
  const SUPPORTED = ['en', 'es']
  const FALLBACK = 'en'

  class I18n {
    constructor() {
      this.locale = FALLBACK
      this.preference = 'auto' // 'auto' | 'en' | 'es'
      this.catalog = {}
      this.fallback = {} // 'en' catalog always loaded for fallback
      this._listeners = new Set()
      this._initPromise = null
    }

    // Init flow — called once by settings.js at boot. Idempotent.
    async init() {
      if (this._initPromise) return this._initPromise
      this._initPromise = (async () => {
        await this._loadFallback()
        const pref = await this._readPreference()
        this.preference = pref
        const resolved = await this._resolveLocale(pref)
        this.locale = resolved
        await this._loadCatalog(resolved)
        this.translatePage()
      })()
      return this._initPromise
    }

    async _readPreference() {
      try {
        if (!window.oz || !window.oz.settings) return 'auto'
        const gen = await window.oz.settings.get('general')
        return (gen && gen.locale) || 'auto'
      } catch (_e) {
        return 'auto'
      }
    }

    async _resolveLocale(pref) {
      if (pref === 'en' || pref === 'es') return pref
      // 'auto' — ask main process
      try {
        const sysLoc =
          window.oz && window.oz.app && window.oz.app.getSystemLocale
            ? await window.oz.app.getSystemLocale()
            : 'en-US'
        const short = String(sysLoc || 'en')
          .toLowerCase()
          .slice(0, 2)
        return SUPPORTED.includes(short) ? short : FALLBACK
      } catch (_e) {
        return FALLBACK
      }
    }

    async _loadFallback() {
      if (Object.keys(this.fallback).length > 0) return
      try {
        const res = await fetch('./locales/en.json')
        this.fallback = await res.json()
      } catch (_e) {
        this.fallback = {}
      }
    }

    async _loadCatalog(loc) {
      if (loc === FALLBACK) {
        this.catalog = this.fallback
        return
      }
      try {
        const res = await fetch(`./locales/${loc}.json`)
        this.catalog = await res.json()
      } catch (_e) {
        // fall back to en
        this.catalog = this.fallback
      }
    }

    // t('namespace.key', {count: 3}) — leaf lookup with {{var}} interpolation
    // Falls back to en, then to the key itself. Never throws.
    t(key, params) {
      const lookup = (obj) => {
        if (!obj) return undefined
        let cur = obj
        for (const part of String(key).split('.')) {
          if (cur && typeof cur === 'object' && part in cur) cur = cur[part]
          else return undefined
        }
        return typeof cur === 'string' ? cur : undefined
      }
      let str = lookup(this.catalog) || lookup(this.fallback) || key
      if (params && typeof str === 'string') {
        for (const [k, v] of Object.entries(params)) {
          str = str.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v))
        }
      }
      return str
    }

    // setLocale('auto' | 'en' | 'es') — persist preference + re-render.
    // 'auto' resolves to system locale at this moment.
    async setLocale(pref) {
      if (!['auto', 'en', 'es'].includes(pref)) return
      this.preference = pref
      // Persist (best-effort)
      try {
        if (window.oz && window.oz.settings) {
          await window.oz.settings.set('general', { locale: pref })
        }
      } catch (_e) {
        // ignore persist failure
      }
      const resolved = await this._resolveLocale(pref)
      this.locale = resolved
      await this._loadCatalog(resolved)
      this.translatePage()
      for (const cb of this._listeners) {
        try {
          cb({ locale: resolved, preference: pref })
        } catch (_e) {
          // ignore listener errors — never abort the locale switch
        }
      }
    }

    onChange(cb) {
      this._listeners.add(cb)
      return () => this._listeners.delete(cb)
    }

    // Walk DOM and replace data-i18n + data-i18n-attr instances.
    translatePage(root) {
      const r = root || document
      // textContent replacement
      r.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n')
        if (!key) return
        const val = this.t(key)
        // Only update if non-empty translation
        if (val) el.textContent = val
      })
      // attribute replacement: data-i18n-attr="placeholder:k1,title:k2"
      r.querySelectorAll('[data-i18n-attr]').forEach((el) => {
        const spec = el.getAttribute('data-i18n-attr')
        if (!spec) return
        for (const pair of spec.split(',')) {
          const [attr, key] = pair.split(':').map((s) => s && s.trim())
          if (!attr || !key) continue
          const val = this.t(key)
          if (val) el.setAttribute(attr, val)
        }
      })
    }

    // Helper: list of supported locales for UI dropdowns.
    listSupported() {
      return [
        { value: 'auto', label: 'Auto (system)' },
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
      ]
    }
  }

  function init() {
    window.OZ = window.OZ || {}
    if (window.OZ.i18n) return
    const i = new I18n()
    window.OZ.i18n = i
    // Expose a global t() shortcut for terse JS calls.
    window.OZ.t = (key, params) => i.t(key, params)
    // Auto-init — load catalog + translate the page once DOM is ready.
    // Other modules can also call window.OZ.i18n.init() — idempotent.
    i.init().catch(() => {
      // swallow — fallback to en stays in DOM
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
