// OZ Browser — Sidebar tree context menus (H3c).
//
// Right-click handlers para workspaces + identities en el árbol del sidebar.
// Extraído del sidebar.js principal para respetar la 500 LOC rule.
//
// Cada función recibe:
//   - sidebar: la instancia IdentitySidebar (para handleInlineRename, refresh
//     inline, etc.)
//   - e: el MouseEvent del contextmenu
//   - target: el workspace o identity sobre el que se hizo right-click
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const { safe } = window.OZ.utils

  function buildMenu(e) {
    const existing = document.querySelector('.ctx-menu')
    if (existing) existing.remove()
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    menu.style.left = `${e.clientX}px`
    menu.style.top = `${e.clientY}px`
    return menu
  }

  function addItem(menu, label, onClick, opts = {}) {
    const btn = document.createElement('button')
    btn.textContent = label
    if (opts.danger) btn.className = 'danger'
    if (opts.disabled) btn.setAttribute('disabled', '')
    btn.addEventListener('click', () => {
      menu.remove()
      if (!opts.disabled) onClick()
    })
    menu.appendChild(btn)
  }

  function showMenu(menu) {
    document.body.appendChild(menu)
    setTimeout(() => {
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove()
          document.removeEventListener('click', close, true)
        }
      }
      document.addEventListener('click', close, true)
    }, 0)
  }

  function showWorkspaceContextMenu(sidebar, e, ws) {
    e.preventDefault()
    e.stopPropagation()
    const menu = buildMenu(e)
    const rowEl = e.currentTarget.closest('.workspace-row')

    addItem(
      menu,
      'Rename',
      () => {
        sidebar.handleInlineRename(rowEl, ws.name, async (v) => {
          await safe(window.oz.workspaces.rename(ws.id, v), 'workspaces.rename')
        })
      },
      { disabled: ws.isFrozen },
    )
    addItem(menu, 'Duplicate', () =>
      safe(window.oz.workspaces.duplicate(ws.id), 'workspaces.duplicate'),
    )
    addItem(menu, ws.isFrozen ? 'Unfreeze' : 'Freeze', () => {
      if (ws.isFrozen) {
        safe(window.oz.workspaces.unfreeze(ws.id), 'workspaces.unfreeze')
      } else {
        safe(window.oz.workspaces.freeze(ws.id), 'workspaces.freeze')
      }
    })
    if (!ws.isDefault) {
      if (ws.isArchived) {
        addItem(menu, 'Restore', () =>
          safe(window.oz.workspaces.restore(ws.id), 'workspaces.restore'),
        )
      } else {
        addItem(menu, 'Archive', () =>
          safe(window.oz.workspaces.archive(ws.id), 'workspaces.archive'),
        )
      }
      addItem(
        menu,
        'Delete workspace',
        async () => {
          const count = (ws.identityIds && ws.identityIds.length) || 0
          const tabsCount = (ws.tabSpecs && ws.tabSpecs.length) || 0
          const msg =
            count > 0
              ? `Delete workspace "${ws.name}"?\n\n` +
                `${count} identities will be moved to General Browsing.\n` +
                `Tab specs (${tabsCount}) will be discarded.\n` +
                `Cookies/storage on disk are preserved (they belong to identities).`
              : `Delete workspace "${ws.name}"? Tab specs will be discarded.`
          if (!confirm(msg)) return
          const r = await safe(
            window.oz.workspaces.remove(ws.id, count > 0 ? { cascade: true } : undefined),
            'workspaces.remove',
          )
          if (r && r.ok === false) {
            if (r.reason === 'has-locked-identities') {
              alert(
                `Cannot delete: ${r.lockedCount} locked identities. Unlock them first.`,
              )
            } else {
              alert(`Cannot delete: ${r.reason}`)
            }
          }
        },
        { danger: true },
      )
    }
    showMenu(menu)
  }

  function showIdentityContextMenu(sidebar, e, identity) {
    e.preventDefault()
    e.stopPropagation()
    const menu = buildMenu(e)
    const rowEl = e.currentTarget.closest('.identity-row')

    addItem(menu, 'Rename', () => {
      sidebar.handleInlineRename(rowEl, identity.name, async (v) => {
        await safe(window.oz.identities.rename(identity.id, v), 'identities.rename')
      })
    })
    addItem(menu, 'Edit identity…', () => {
      const editor = window.OZ && window.OZ.IdentityEditor
      if (editor) editor.open(identity)
      else alert('Identity editor not available.')
    })

    // H3a: Move to workspace submenu (only for non-Default identities).
    if (!identity.isDefault) {
      _appendMoveToWorkspaceSubmenu(sidebar, e, menu, identity)
    }

    addItem(menu, identity.locked ? 'Unlock identity' : 'Lock identity', () => {
      safe(
        window.oz.identities.setLocked(identity.id, !identity.locked),
        'identities.setLocked',
      )
    })
    if (!identity.isDefault) {
      addItem(
        menu,
        identity.locked ? 'Delete identity (locked)' : 'Delete identity',
        () => {
          if (identity.locked) {
            alert(`Identity "${identity.name}" is locked. Unlock it first.`)
            return
          }
          if (
            confirm(
              `Delete identity "${identity.name}"?\n\n` +
                `Tabs of this identity will close. Cookies/storage on disk remain.`,
            )
          ) {
            safe(window.oz.identities.remove(identity.id), 'identities.remove')
          }
        },
        { danger: true, disabled: identity.locked },
      )
    }
    showMenu(menu)
  }

  function _appendMoveToWorkspaceSubmenu(sidebar, e, menu, identity) {
    const targets = sidebar.workspaces.filter(
      (w) => !w.isArchived && w.id !== identity.workspaceId,
    )
    const moveSub = document.createElement('div')
    moveSub.className = 'ctx-menu ctx-submenu'
    if (targets.length === 0) {
      const empty = document.createElement('button')
      empty.textContent = '(no other workspaces)'
      empty.disabled = true
      moveSub.appendChild(empty)
    } else {
      for (const ws of targets) {
        const item = document.createElement('button')
        item.textContent = `${ws.isFrozen ? '🔒 ' : ''}${ws.name}`
        item.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          const r = await safe(
            window.oz.identities.moveToWorkspace(identity.id, ws.id),
            'identities.moveToWorkspace',
          )
          if (r && r.ok === false) alert(`Move failed: ${r.reason}`)
          menu.remove()
          moveSub.remove()
        })
        moveSub.appendChild(item)
      }
    }
    const moveBtn = document.createElement('button')
    moveBtn.textContent = 'Move to workspace… ▸'
    if (identity.locked) moveBtn.disabled = true
    moveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (identity.locked) return
      moveSub.style.left = `${e.clientX + 200}px`
      moveSub.style.top = `${e.clientY + 60}px`
      document.body.appendChild(moveSub)
      const closeSub = (ev2) => {
        if (!moveSub.contains(ev2.target) && !menu.contains(ev2.target)) {
          moveSub.remove()
          document.removeEventListener('click', closeSub, true)
        }
      }
      setTimeout(() => document.addEventListener('click', closeSub, true), 0)
    })
    menu.appendChild(moveBtn)
  }

  window.OZ.SidebarCtxMenus = {
    showWorkspaceContextMenu,
    showIdentityContextMenu,
  }
})()
