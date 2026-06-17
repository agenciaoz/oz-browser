// OZ Browser — Sidebar workspace-row renderer (alpha.43).
//
// Extracted from sidebar.js (ADR 0005 LOC budget) when adding drag-to-reorder
// for workspaces (Ghost parity). Pure DOM builder that takes the sidebar
// instance for its callbacks/state.
//
// A pill = one workspace in the switcher. Clicking switches the active
// workspace. The pill is:
//   - draggable (type application/oz-workspace-id) to REORDER workspaces, and
//   - a drop target for application/oz-identity-id / oz-tab-id to MOVE an
//     identity/tab into the workspace (unchanged behaviour), and
//   - a drop target for application/oz-workspace-id to place the dragged
//     workspace before/after this one (by drop position).

;(function () {
  'use strict'
  const { safe } = window.OZ.utils

  function render(sidebar, ws) {
    const row = document.createElement('div')
    row.className = 'workspace-pill'
    row.dataset.wsId = ws.id
    if (ws.id === sidebar.activeWorkspaceId) row.classList.add('active')
    if (ws.isArchived) row.classList.add('archived')
    if (ws.isFrozen) row.classList.add('frozen')

    const chip = document.createElement('span')
    chip.className = 'workspace-chip'
    chip.style.background = ws.color
    row.appendChild(chip)

    if (ws.isFrozen) {
      const lock = document.createElement('span')
      lock.className = 'workspace-lock'
      lock.textContent = '🔒'
      row.appendChild(lock)
    }

    const name = document.createElement('span')
    name.className = 'workspace-name'
    name.textContent = ws.name
    row.appendChild(name)

    const count = document.createElement('span')
    count.className = 'tree-count'
    const idCount = (ws.identityIds && ws.identityIds.length) || 0
    count.textContent = `(${idCount})`
    if (idCount === 0) count.classList.add('zero')
    row.appendChild(count)

    // ＋ new identity directly in THIS workspace (frozen/archived excluded).
    if (!ws.isFrozen && !ws.isArchived) {
      const addId = document.createElement('button')
      addId.type = 'button'
      addId.className = 'ws-add-identity-btn'
      addId.title = `New identity in "${ws.name}"`
      addId.textContent = '＋'
      addId.addEventListener('click', (ev) => {
        ev.stopPropagation()
        sidebar.handleNewIdentityInWorkspace(ws.id)
      })
      row.appendChild(addId)
    }

    row.addEventListener('click', () => sidebar.handleSelectWorkspace(ws.id))
    row.addEventListener('contextmenu', (e) => sidebar.showWorkspaceContextMenu(e, ws))
    row.addEventListener('dblclick', (e) => {
      e.preventDefault()
      if (ws.isFrozen) return
      sidebar.handleInlineRename(row, ws.name, async (v) => {
        await safe(window.oz.workspaces.rename(ws.id, v), 'workspaces.rename')
      })
    })

    // alpha.43 — drag the pill to reorder (archived pills are not reorderable).
    if (!ws.isArchived) {
      row.draggable = true
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/oz-workspace-id', ws.id)
        ev.dataTransfer.effectAllowed = 'move'
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => row.classList.remove('dragging'))
    }

    // Drop target: reorder (workspace-id) OR move an identity/tab in.
    row.addEventListener('dragover', (ev) => {
      const types = ev.dataTransfer.types
      const isWs = types.includes('application/oz-workspace-id')
      const isMove =
        types.includes('application/oz-identity-id') ||
        types.includes('application/oz-tab-id')
      const acceptWs = isWs && !ws.isArchived
      const acceptMove = isMove && ws.id !== sidebar.activeWorkspaceId && !ws.isArchived
      if (acceptWs || acceptMove) {
        ev.preventDefault()
        ev.dataTransfer.dropEffect = 'move'
        row.classList.add('drop-target')
      }
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'))
    row.addEventListener('drop', async (ev) => {
      ev.preventDefault()
      row.classList.remove('drop-target')
      const wsId = ev.dataTransfer.getData('application/oz-workspace-id')
      const idId = ev.dataTransfer.getData('application/oz-identity-id')
      const tabId = ev.dataTransfer.getData('application/oz-tab-id')
      if (wsId) {
        const rect = row.getBoundingClientRect()
        const placeAfter = ev.clientY > rect.top + rect.height / 2
        sidebar.handleReorderWorkspaces(wsId, ws.id, placeAfter)
      } else if (idId) {
        const r = await safe(
          window.oz.identities.moveToWorkspace(idId, ws.id),
          'identities.moveToWorkspace',
        )
        if (r && r.ok === false) alert(`Move failed: ${r.reason}`)
      } else if (tabId) {
        const r = await safe(
          window.oz.tabs.moveToWorkspace(tabId, ws.id),
          'tabs.moveToWorkspace',
        )
        if (r && r.ok === false) alert(`Move failed: ${r.reason}`)
      }
    })

    return row
  }

  window.OZ = window.OZ || {}
  window.OZ.SidebarWsRow = { render }
})()
