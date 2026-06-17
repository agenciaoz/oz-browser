// OZ Browser — App Dock pure helpers (alpha.44).
//
// The quick-access bar becomes a user-configurable "App Dock" (Ghost parity:
// launcher of favourite links, add/remove/reorder). These pure functions own
// the merge/order/build logic so they are unit-testable with no DOM/Electron
// (ADR 0005). DOM wiring lives in quick-access-bar.js; persistence in
// app-dock-state.js.

;(function () {
  'use strict'

  /** Random-ish stable key for a user-added link. */
  function makeKey() {
    return 'dock-' + Math.random().toString(36).slice(2, 9)
  }

  /** 1–2 char abbreviation derived from a label (fallback icon text). */
  function abbrevFromLabel(label) {
    const s = String(label || '').trim()
    if (!s) return '•'
    const words = s.split(/\s+/)
    if (words.length >= 2 && words[0] && words[1]) {
      return (words[0][0] + words[1][0]).toUpperCase()
    }
    return s.slice(0, 2).toUpperCase()
  }

  /** Add https:// when the user omits the scheme. Empty → ''. */
  function normalizeUrl(url) {
    const s = String(url || '').trim()
    if (!s) return ''
    if (/^https?:\/\//i.test(s)) return s
    return 'https://' + s
  }

  /**
   * Build a custom-link entry from user input. Returns null if the URL is
   * empty/invalid (caller should ignore).
   */
  function buildCustomLink(label, url) {
    const u = normalizeUrl(url)
    if (!u) return null
    const name = String(label || '').trim() || u
    return {
      key: makeKey(),
      label: name,
      url: u,
      abbrev: abbrevFromLabel(name),
      bg: 'linear-gradient(135deg, #64748b, #334155)',
      custom: true,
    }
  }

  /**
   * Merge built-in defaults + custom links into the visible, ordered dock.
   *   defaults : built-in entries [{key,...}]
   *   custom   : user entries [{key,...,custom:true}]
   *   order    : desired key order (unknown keys ignored; missing appended)
   *   hidden   : keys to hide (built-ins the user removed)
   * Stable: entries without an explicit order keep defaults-before-custom order.
   */
  function mergeDock(defaults, custom, order, hidden) {
    const hiddenSet = new Set(hidden || [])
    const all = [...(defaults || []), ...(custom || [])].filter(
      (e) => e && !hiddenSet.has(e.key),
    )
    const rank = new Map((order || []).map((k, i) => [k, i]))
    return all
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ra = rank.has(a.e.key) ? rank.get(a.e.key) : Infinity
        const rb = rank.has(b.e.key) ? rank.get(b.e.key) : Infinity
        if (ra !== rb) return ra - rb
        return a.i - b.i // stable tiebreak on original index
      })
      .map((x) => x.e)
  }

  /**
   * Reorder helper — remove draggedKey and re-insert relative to targetKey
   * (before by default, after when placeAfter). Pure; returns a new array.
   */
  function reorderDock(order, draggedKey, targetKey, placeAfter) {
    const all = (order || []).slice()
    if (draggedKey === targetKey) return all
    const arr = all.filter((k) => k !== draggedKey)
    let idx = arr.indexOf(targetKey)
    if (idx < 0) {
      arr.push(draggedKey)
      return arr
    }
    if (placeAfter) idx += 1
    arr.splice(idx, 0, draggedKey)
    return arr
  }

  const api = {
    makeKey,
    abbrevFromLabel,
    normalizeUrl,
    buildCustomLink,
    mergeDock,
    reorderDock,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.AppDockUtils = api
  }
})()
