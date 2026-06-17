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
   * Workspaces to show in the switcher list — archived hidden unless toggled,
   * stable createdAt order (clicking switches active; never reshuffles).
   */
  function visibleWorkspaces(workspaces, showArchived) {
    return (workspaces || [])
      .filter((w) => showArchived || !w.isArchived)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
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
   * Filter identities by a free-text query against the name (case-insensitive).
   * Empty / whitespace query returns all. (Ghost: "search identities".)
   */
  function filterIdentities(identities, query) {
    const q = (query || '').trim().toLowerCase()
    if (!q) return (identities || []).slice()
    return (identities || []).filter((i) => (i.name || '').toLowerCase().includes(q))
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
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  }
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.SidebarView = api
  }
})()
