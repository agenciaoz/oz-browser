// OZ Browser — Sidebar view-model helpers (alpha.32).
//
// Pure functions (no DOM / Electron) that compute what the sidebar shows.
// Extracted so the "only render the ACTIVE workspace" logic is unit-testable
// (ADR 0005 — pure helpers + smoke test), and to keep sidebar.js under the
// 500-LOC budget.
//
// Ghost parity (research 2026-06-16, support.ghostbrowser.com/article/321):
// Ghost opens ONE workspace at a time; the sidebar lists workspaces to switch
// between, and only the active workspace's tabs/identities are shown. OZ used
// to render every workspace's tabs at once (tabs.list() aggregates ALL windows)
// which leaked the previous workspace's tabs into view after a switch. These
// helpers scope the view to the active workspace.
//
// Doc: docs/modules/sidebar-view.md
//
// API:
//   visibleWorkspaces(workspaces, showArchived) -> sorted workspaces to list
//   identitiesForWorkspace(identities, workspaceId) -> identities in that ws
//   scopeTabsToWorkspace(tabs, identities, workspaceId) -> only that ws's tabs

;(function () {
  'use strict'

  /**
   * Workspaces to show in the switcher list — archived hidden unless toggled.
   * Order (alpha.43): the user-defined `order` array (workspace ids) wins; any
   * workspace not in `order` (new / archived / first run) falls back to a
   * stable createdAt order after the ordered ones. No `order` → pure createdAt
   * order (the pre-alpha.43 behaviour).
   */
  function visibleWorkspaces(workspaces, showArchived, order) {
    const rank = new Map((order || []).map((id, i) => [id, i]))
    return (workspaces || [])
      .filter((w) => showArchived || !w.isArchived)
      .sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Infinity
        const rb = rank.has(b.id) ? rank.get(b.id) : Infinity
        if (ra !== rb) return ra - rb
        return (a.createdAt || 0) - (b.createdAt || 0)
      })
  }

  /**
   * alpha.43 — compute the new workspace id order after a drag-reorder. Removes
   * `draggedId` and re-inserts it relative to `targetId` (before by default,
   * after when `placeAfter`). Pure; returns a new array. No-ops on self-drop or
   * unknown ids.
   */
  function reorderWorkspaceIds(ids, draggedId, targetId, placeAfter) {
    const all = (ids || []).slice()
    if (!all.includes(draggedId) || draggedId === targetId) return all
    const arr = all.filter((id) => id !== draggedId)
    let idx = arr.indexOf(targetId)
    if (idx < 0) return all
    if (placeAfter) idx += 1
    arr.splice(idx, 0, draggedId)
    return arr
  }

  /** Identities belonging to a given workspace (identity.workspaceId model). */
  function identitiesForWorkspace(identities, workspaceId) {
    if (!workspaceId) return []
    return (identities || []).filter((i) => i.workspaceId === workspaceId)
  }

  /** Tabs of a single identity. */
  function tabsForIdentity(tabs, identityId) {
    return (tabs || []).filter((t) => t.identityId === identityId)
  }

  /**
   * alpha.42 — the single global Default identity (Ghost parity: the "normal
   * browsing" jar). ADR 0035 supersedes ADR 0023 D2: instead of living only in
   * the 'general' workspace, the Default identity is now pinned at the top of
   * EVERY workspace. Returns null if there is no default (shouldn't happen).
   */
  function globalDefaultIdentity(identities) {
    return (identities || []).find((i) => i.isDefault) || null
  }

  /**
   * alpha.42 — tabs to list under the global Default identity row, scoped to
   * the CURRENT window. The Default jar is global, but its tabs are still
   * per-window (each OZ window = one workspace, ADR 0015). Scoping by windowId
   * keeps Default tabs from other windows from leaking in (the alpha.32 fix,
   * now extended to the always-visible Default row). When windowId is unknown
   * (null), fall back to the caller's choice — this helper returns [] so the
   * caller can decide; sidebar.js falls back to the unscoped list in that case.
   */
  function defaultTabsForWindow(tabs, defaultId, windowId) {
    if (!defaultId || windowId == null) return []
    return (tabs || []).filter(
      (t) => t.identityId === defaultId && t.windowId === windowId,
    )
  }

  /**
   * Filter identities by a free-text query against the name (case-insensitive).
   * Empty / whitespace query returns all. (Ghost: "search identities".)
   */
  function filterIdentities(identities, query) {
    const q = (query || '').trim().toLowerCase()
    if (!q) return (identities || []).slice()
    return (identities || []).filter((i) => {
      if ((i.name || '').toLowerCase().includes(q)) return true
      // alpha.40: also match tags so the search box doubles as a tag filter.
      return (i.tags || []).some((t) => String(t).toLowerCase().includes(q))
    })
  }

  /**
   * Sort identities by mode (Ghost: created / alphabetical / frequency).
   *   - 'alpha'     : name A→Z (locale-aware)
   *   - 'frequency' : most-used first (useCounts[id] desc), tiebreak A→Z
   *   - 'created'   : creation order (createdAt asc) — default
   * Pure: returns a new array, never mutates the input.
   */
  function sortIdentities(identities, mode, useCounts) {
    const arr = (identities || []).slice()
    const counts = useCounts || {}
    const byName = (a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, {
        sensitivity: 'base',
      })
    if (mode === 'alpha') {
      arr.sort(byName)
    } else if (mode === 'frequency') {
      arr.sort((a, b) => {
        const d = (counts[b.id] || 0) - (counts[a.id] || 0)
        return d !== 0 ? d : byName(a, b)
      })
    } else {
      arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    }
    return arr
  }

  /**
   * Cross-workspace isolation: of all live tabs (tabs.list() aggregates every
   * open window), keep only those whose identity lives in the active workspace.
   * This is the core fix for "old workspace tabs stay visible after switch".
   */
  function scopeTabsToWorkspace(tabs, identities, workspaceId) {
    const ids = new Set(identitiesForWorkspace(identities, workspaceId).map((i) => i.id))
    return (tabs || []).filter((t) => ids.has(t.identityId))
  }

  const api = {
    visibleWorkspaces,
    identitiesForWorkspace,
    tabsForIdentity,
    scopeTabsToWorkspace,
    filterIdentities,
    sortIdentities,
    globalDefaultIdentity,
    defaultTabsForWindow,
    reorderWorkspaceIds,
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  }
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.SidebarView = api
  }
})()
