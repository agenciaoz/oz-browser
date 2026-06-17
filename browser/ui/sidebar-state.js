// OZ Browser — Sidebar localStorage state (alpha.33).
//
// UI-only persistence for the sidebar, split out of sidebar.js to keep it under
// the 500-LOC budget (ADR 0005). No backend / sync — pure renderer state:
//   - expanded tree nodes (per identity)
//   - identity sort mode (created / alpha / frequency)
//   - per-identity use counts (drives the "Most used" sort)
//
// All getters are defensive (corrupt JSON / disabled storage → safe default).

;(function () {
  'use strict'

  const EXPANDED_KEY = 'oz-tree-expanded'
  const SORT_KEY = 'oz-id-sort'
  const USE_KEY = 'oz-id-use'
  // alpha.43 — user-defined workspace order (array of workspace ids). Ghost
  // lets you drag workspaces to reorder; ids absent from this list fall back
  // to createdAt order (see sidebar-view.visibleWorkspaces).
  const WS_ORDER_KEY = 'oz-ws-order'

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (_e) {
      return fallback
    }
  }
  function writeRaw(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (_e) {
      /* quota exceeded / disabled — ignore */
    }
  }

  const SidebarState = {
    loadExpanded: () => readJSON(EXPANDED_KEY, {}),
    saveExpanded: (state) => writeRaw(EXPANDED_KEY, JSON.stringify(state)),
    loadIdSort: () => {
      try {
        return localStorage.getItem(SORT_KEY) || 'created'
      } catch (_e) {
        return 'created'
      }
    },
    saveIdSort: (mode) => writeRaw(SORT_KEY, mode),
    loadIdUse: () => readJSON(USE_KEY, {}),
    saveIdUse: (map) => writeRaw(USE_KEY, JSON.stringify(map)),
    loadWsOrder: () => {
      const v = readJSON(WS_ORDER_KEY, [])
      return Array.isArray(v) ? v : []
    },
    saveWsOrder: (ids) => writeRaw(WS_ORDER_KEY, JSON.stringify(ids || [])),
  }

  window.OZ = window.OZ || {}
  window.OZ.SidebarState = SidebarState
})()
