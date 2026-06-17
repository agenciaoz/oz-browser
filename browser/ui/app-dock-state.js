// OZ Browser — App Dock localStorage state (alpha.44).
//
// UI-only persistence for the App Dock (custom links + order + hidden built-in
// keys). No backend / sync, consistent with sidebar-state.js. Defensive reads
// (corrupt JSON / disabled storage → safe empty state).

;(function () {
  'use strict'

  const KEY = 'oz-app-dock'

  function read() {
    const empty = { custom: [], order: [], hidden: [] }
    try {
      const raw = localStorage.getItem(KEY)
      const v = raw ? JSON.parse(raw) : null
      if (!v || typeof v !== 'object') return empty
      return {
        custom: Array.isArray(v.custom) ? v.custom : [],
        order: Array.isArray(v.order) ? v.order : [],
        hidden: Array.isArray(v.hidden) ? v.hidden : [],
      }
    } catch (_e) {
      return empty
    }
  }

  function write(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state || {}))
    } catch (_e) {
      /* quota exceeded / disabled — ignore */
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.AppDockState = { read, write }
})()
