// OZ Browser — Proxy Dashboard bulk multi-select + bulk actions (H-2f, v1.1.3).
//
// Extraído de proxy-dashboard.js para mantener ese archivo bajo 500 LOC
// (ADR 0005). Mismo patrón que proxy-dashboard-alerts.js — expone
// `window.OZ_DashboardBulk` con state + helpers que el host dashboard llama.
//
// State module-level guardado por id (Set<id>) — persiste cross-pagination y
// cross-filter porque guardamos ids, no índices ni rows. Cuando re-renderizás
// la tabla, los checkboxes se marcan según el Set.

;(function () {
  const api = {
    state: {
      identSelected: new Set(),
      proxySelected: new Set(),
    },
  }

  // ---------------- selection mutation ----------------
  function toggleRow(kind, id, checked) {
    const set = kind === 'ident' ? api.state.identSelected : api.state.proxySelected
    if (checked) set.add(id)
    else set.delete(id)
  }

  function selectAllVisible(kind, visibleIds, checked) {
    const set = kind === 'ident' ? api.state.identSelected : api.state.proxySelected
    if (checked) {
      for (const id of visibleIds) set.add(id)
    } else {
      for (const id of visibleIds) set.delete(id)
    }
  }

  function clearSelection(kind) {
    if (kind === 'ident') api.state.identSelected.clear()
    else if (kind === 'proxy') api.state.proxySelected.clear()
    else {
      api.state.identSelected.clear()
      api.state.proxySelected.clear()
    }
  }

  function getSelectedIds(kind) {
    return Array.from(
      kind === 'ident' ? api.state.identSelected : api.state.proxySelected,
    )
  }

  // ---------------- row checkbox HTML ----------------
  function rowCheckboxHtml(kind, id) {
    const set = kind === 'ident' ? api.state.identSelected : api.state.proxySelected
    const checked = set.has(id) ? ' checked' : ''
    return `<input type="checkbox" class="bulk-row-cb" data-act="bulk-toggle-row" data-kind="${kind}" data-id="${id}"${checked}>`
  }

  // ---------------- update action bar visibility + counters ----------------
  function syncActionBar(kind, t) {
    const set = kind === 'ident' ? api.state.identSelected : api.state.proxySelected
    const bar = document.getElementById(kind + '-bulk-bar')
    const lbl = document.getElementById(kind + '-bulk-count')
    const headerCb = document.getElementById(kind + '-select-all')
    if (bar) bar.hidden = set.size === 0
    if (lbl) {
      const tmpl = t('proxyDashboard.bulk.selected', '{{n}} selected')
      lbl.textContent = tmpl.replace('{{n}}', String(set.size))
    }
    if (headerCb) {
      // tri-state: all visible checked → checked, some → indeterminate, none → unchecked
      const visibleIds = api._lastVisibleIds && api._lastVisibleIds[kind]
      if (Array.isArray(visibleIds) && visibleIds.length > 0) {
        let allIn = true
        let anyIn = false
        for (const id of visibleIds) {
          if (set.has(id)) anyIn = true
          else allIn = false
        }
        headerCb.checked = allIn
        headerCb.indeterminate = !allIn && anyIn
      } else {
        headerCb.checked = false
        headerCb.indeterminate = false
      }
    }
  }

  function setVisibleIds(kind, ids) {
    if (!api._lastVisibleIds) api._lastVisibleIds = {}
    api._lastVisibleIds[kind] = ids.slice()
  }

  // ---------------- delegated handlers ----------------
  // Returns true if the event was handled (caller should not run other delegation).
  function handleDelegatedClick(ev, deps) {
    const t = ev.target
    if (!t || !t.dataset) return false
    const act = t.dataset.act
    if (!act) return false

    if (act === 'bulk-toggle-row') {
      const kind = t.dataset.kind
      const id = t.dataset.id
      if (!id || !kind) return true
      toggleRow(kind, id, t.checked)
      syncActionBar(kind, deps.t)
      return true
    }
    if (act === 'bulk-select-all') {
      const kind = t.dataset.kind
      const visibleIds = (api._lastVisibleIds && api._lastVisibleIds[kind]) || []
      selectAllVisible(kind, visibleIds, t.checked)
      // Need a full re-render to update row checkboxes.
      if (deps.rerender) deps.rerender(kind)
      syncActionBar(kind, deps.t)
      return true
    }
    if (
      act === 'bulk-test' ||
      act === 'bulk-reset' ||
      act === 'bulk-disable' ||
      act === 'bulk-enable' ||
      act === 'bulk-delete' ||
      act === 'bulk-reload' ||
      act === 'bulk-reassign'
    ) {
      runBulk(act, deps)
      return true
    }
    return false
  }

  // ---------------- bulk action runner ----------------
  async function runBulk(act, deps) {
    const pab = window.oz && window.oz.proxyActionBulk
    const pa = window.oz && window.oz.proxyAction
    if (!pab) return
    const _t = deps.t
    if (act === 'bulk-reload') {
      const ids = getSelectedIds('ident')
      if (ids.length === 0) return
      await pab.reloadSessions(ids)
      await deps.refreshDashboard()
      return
    }
    if (act === 'bulk-reassign') {
      // Cross-feature 1:1 modal (H-2h). If module loaded, delegate; else
      // simple prompt with a single proxyId applied to all (1 proxy → N ids).
      const ids = getSelectedIds('ident')
      if (ids.length === 0) return
      if (window.OZ_BulkAssign && window.OZ_BulkAssign.openForIdentities) {
        window.OZ_BulkAssign.openForIdentities(ids)
        return
      }
      // Fallback: prompt + apply same proxy to all
      const value = window.prompt(
        _t(
          'proxyDashboard.bulk.bulkReassignPrompt',
          'Proxy id to apply to all selected identities (or "auto-random" / "auto-round-robin" / blank = none):',
        ),
        '',
      )
      if (value === null) return
      const v = value.trim() === '' ? null : value.trim()
      for (const id of ids) {
        try {
          await pa.reassign(id, v)
        } catch (_e) {
          /* ignore */
        }
      }
      await deps.refreshDashboard()
      return
    }
    const proxyIds = getSelectedIds('proxy')
    if (proxyIds.length === 0) return
    if (act === 'bulk-test') {
      await pab.test(proxyIds)
    } else if (act === 'bulk-reset') {
      await pab.reset(proxyIds)
    } else if (act === 'bulk-disable') {
      await pab.setDisabled(proxyIds, true)
    } else if (act === 'bulk-enable') {
      await pab.setDisabled(proxyIds, false)
    } else if (act === 'bulk-delete') {
      const msg = _t(
        'proxyDashboard.bulk.deleteConfirm',
        'Delete {{n}} proxies? Identities using them will fall back to default strategy.',
      ).replace('{{n}}', String(proxyIds.length))
      if (!window.confirm(msg)) return
      await pab.delete(proxyIds)
      // Clear selection — deleted ids no longer exist
      clearSelection('proxy')
    }
    await deps.refreshDashboard()
  }

  api.toggleRow = toggleRow
  api.selectAllVisible = selectAllVisible
  api.clearSelection = clearSelection
  api.getSelectedIds = getSelectedIds
  api.rowCheckboxHtml = rowCheckboxHtml
  api.syncActionBar = syncActionBar
  api.setVisibleIds = setVisibleIds
  api.handleDelegatedClick = handleDelegatedClick

  window.OZ_DashboardBulk = api
})()
