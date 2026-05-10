// OZ Browser — Sidebar event wiring (HX4 follow-up).
//
// Extraído de sidebar.js para respetar la 500 LOC rule. Contiene:
//   - wireSidebarBackChannels(sidebar): suscribe a los eventos que el ctx menu
//     nativo emite cuando una acción requiere UI del renderer (inline rename,
//     open identity editor, alert on rejection).
//   - showWorkspaceCtxMenu(e, ws), showIdentityCtxMenu(e, identity): thin
//     wrappers que disparan el IPC del ctx menu nativo (Menu.popup).
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const { safe } = window.OZ.utils

  function wireSidebarBackChannels(sidebar) {
    if (!window.oz || !window.oz.sidebar) return

    window.oz.sidebar.onRequestRename((payload) => {
      if (!payload || !payload.id) return
      const rowEl =
        payload.kind === 'workspace'
          ? document.querySelector(
              `.workspace-wrapper[data-ws-id="${payload.id}"] .workspace-row`,
            )
          : document.querySelector(
              `.identity-wrapper[data-identity-id="${payload.id}"] .identity-row`,
            )
      if (!rowEl) return
      if (payload.kind === 'workspace') {
        sidebar.handleInlineRename(rowEl, payload.currentName, async (v) => {
          await safe(window.oz.workspaces.rename(payload.id, v), 'workspaces.rename')
        })
      } else {
        sidebar.handleInlineRename(rowEl, payload.currentName, async (v) => {
          await safe(window.oz.identities.rename(payload.id, v), 'identities.rename')
        })
      }
    })

    window.oz.sidebar.onRequestEditIdentity((payload) => {
      if (!payload || !payload.id) return
      const ident = sidebar.identities.find((i) => i.id === payload.id)
      if (!ident) return
      const editor = window.OZ && window.OZ.IdentityEditor
      if (editor) editor.open(ident)
      else alert('Identity editor not available.')
    })

    window.oz.sidebar.onRemoveRejected((payload) => {
      if (!payload) return
      if (payload.reason === 'has-locked-identities') {
        alert(
          `Cannot delete: ${payload.lockedCount || 0} locked identities. Unlock them first.`,
        )
      } else if (payload.reason === 'identity-locked') {
        alert('Cannot delete locked identity. Unlock it first.')
      } else {
        alert(`Operation failed: ${payload.reason || 'unknown'}`)
      }
    })
  }

  async function showWorkspaceCtxMenu(e, ws) {
    e.preventDefault()
    e.stopPropagation()
    if (window.oz.workspaces.contextMenu) {
      await safe(
        window.oz.workspaces.contextMenu(ws.id, { x: e.clientX, y: e.clientY }),
        'workspaces.contextMenu',
      )
    }
  }

  async function showIdentityCtxMenu(e, identity) {
    e.preventDefault()
    e.stopPropagation()
    if (window.oz.identities.contextMenu) {
      await safe(
        window.oz.identities.contextMenu(identity.id, {
          x: e.clientX,
          y: e.clientY,
        }),
        'identities.contextMenu',
      )
    }
  }

  window.OZ.SidebarEvents = {
    wireSidebarBackChannels,
    showWorkspaceCtxMenu,
    showIdentityCtxMenu,
  }
})()
