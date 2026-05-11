// OZ Browser — Identity context menu template builder (H3c hotfix HX4).
//
// Native Menu.popup() — replaces the HTML ctx menu in sidebar-ctx-menus.js
// for identity right-clicks. The HTML menu was getting occluded by the
// WebContentsView (ADR 0011 again).
//
// Doc: ADR 0023 (D5 + D7 + identity lock semantics) + ADR 0011.
//
// Exports: buildIdentityContextMenu({ browser, identityId }) -> Array<MenuItem>

const log = require('./logger')

function buildIdentityContextMenu({ browser, identityId }) {
  const im = browser.identityManager
  if (!im) return []
  const ident = im.get(identityId)
  if (!ident) {
    log.warn('identity-context-menu', 'identity not found', { identityId })
    return [{ label: '(identity no longer exists)', enabled: false }]
  }
  const h = browser.handlers && browser.handlers.identities
  if (!h) return []

  const wm = browser.workspaceManager
  const allWorkspaces = wm ? wm.list() : []
  const targets = allWorkspaces.filter((w) => !w.isArchived && w.id !== ident.workspaceId)

  const template = []

  template.push({
    label: 'Rename',
    click: () => {
      browser.broadcastToWebUI('oz:sidebar:request-rename', {
        kind: 'identity',
        id: ident.id,
        currentName: ident.name,
      })
    },
  })
  template.push({
    label: 'Edit identity…',
    click: () => {
      browser.broadcastToWebUI('oz:sidebar:request-edit-identity', {
        id: ident.id,
      })
    },
  })
  // C-3 — open Clone Identity modal preset with this identity's id. Locked
  // identities CAN be cloned (clone is non-destructive, mirrors create()
  // semantics — H2 lock only blocks remove + clearBrowsingData).
  template.push({
    label: 'Clone identity…',
    click: () => {
      browser.broadcastToWebUI('oz:sidebar:request-clone-identity', {
        id: ident.id,
      })
    },
  })
  // C-6 — open Anti-Detect Health modal for this identity. Available on
  // every identity (incluyendo Default + locked) — el dashboard es read-only
  // por default; los inline fixes respetan los locks downstream.
  template.push({
    label: 'Health check…',
    click: () => {
      browser.broadcastToWebUI('oz:sidebar:request-health-check', {
        id: ident.id,
      })
    },
  })
  // C-7 — open Extensions per-identity manager. Disponible para Default
  // (ahí ves "Always enabled") y custom (con checkboxes editables).
  template.push({
    label: 'Manage extensions…',
    click: () => {
      browser.broadcastToWebUI('oz:sidebar:request-manage-extensions', {
        id: ident.id,
      })
    },
  })

  if (!ident.isDefault) {
    // Move to workspace submenu — list every other non-archived workspace.
    const moveSubmenu =
      targets.length > 0
        ? targets.map((w) => ({
            label: `${w.isFrozen ? '🔒 ' : ''}${w.name}`,
            click: () => {
              const r = h.moveToWorkspace(ident.id, w.id)
              if (r && r.ok === false) {
                browser.broadcastToWebUI('oz:sidebar:remove-rejected', {
                  kind: 'identity-move',
                  id: ident.id,
                  reason: r.reason,
                })
              }
            },
          }))
        : [{ label: '(no other workspaces)', enabled: false }]
    template.push({
      label: 'Move to workspace…',
      enabled: !ident.locked,
      submenu: moveSubmenu,
    })
  }

  template.push({
    label: ident.locked ? 'Unlock identity' : 'Lock identity',
    click: () => h.setLocked(ident.id, !ident.locked),
  })

  if (!ident.isDefault) {
    template.push({ type: 'separator' })
    template.push({
      label: ident.locked ? 'Delete identity (locked)' : 'Delete identity',
      enabled: !ident.locked,
      click: () => {
        const ok = h.remove(ident.id)
        if (ok === false) {
          browser.broadcastToWebUI('oz:sidebar:remove-rejected', {
            kind: 'identity',
            id: ident.id,
            reason: ident.locked ? 'identity-locked' : 'remove-failed',
          })
        }
      },
    })
  }

  return template
}

module.exports = { buildIdentityContextMenu }
