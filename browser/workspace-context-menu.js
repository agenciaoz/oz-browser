// OZ Browser — Workspace context menu template builder (H3c hotfix HX4).
//
// Qué hace: arma el array de menu items para Menu.buildFromTemplate(). Un solo
// menú renderizado nativamente vía Menu.popup() — replica el approach del
// tab-context-menu.js (ADR 0011: los menús HTML quedan ocultos detrás de
// las WebContentsViews nativas; native menus no tienen ese problema).
//
// Doc: ADR 0023 (D7 cascade-remove) + ADR 0011 (native menus).
//
// Exports: buildWorkspaceContextMenu({ browser, wsId }) -> Array<MenuItem>

const log = require('./logger')

function buildWorkspaceContextMenu({ browser, wsId }) {
  const wm = browser.workspaceManager
  if (!wm) {
    log.error('workspace-context-menu', 'workspaceManager missing')
    return []
  }
  const ws = wm.get(wsId)
  if (!ws) {
    log.warn('workspace-context-menu', 'workspace not found', { wsId })
    return [{ label: '(workspace no longer exists)', enabled: false }]
  }
  const h = browser.handlers && browser.handlers.workspaces
  if (!h) {
    log.error('workspace-context-menu', 'workspace handlers missing')
    return []
  }

  const template = []

  template.push({
    label: 'Rename',
    enabled: !ws.isFrozen,
    click: () => {
      // Renaming uses an inline input in the sidebar — fire an IPC event the
      // sidebar can pick up to enter rename mode. We can't open a prompt in
      // the native menu without an extra dialog, so the renderer handles it.
      browser.broadcastToWebUI('oz:sidebar:request-rename', {
        kind: 'workspace',
        id: ws.id,
        currentName: ws.name,
      })
    },
  })
  template.push({
    label: 'Duplicate',
    click: () => h.duplicate(ws.id),
  })
  template.push({
    label: ws.isFrozen ? 'Unfreeze' : 'Freeze',
    click: () => (ws.isFrozen ? h.unfreeze(ws.id) : h.freeze(ws.id)),
  })

  // Quick Tabs submenu (mirrors the workspace-switcher legacy ctx menu).
  const QT_LABELS = {
    'on-click': 'Lazy (on click) — default',
    'load-all': 'Load all on switch',
    'one-by-one': 'Load one by one',
    'on-click-confirm': 'Lazy + confirm before load',
  }
  const currentMode = ws.quickTabsMode || 'on-click'
  template.push({
    label: 'Quick Tabs',
    enabled: !ws.isFrozen,
    submenu: Object.keys(QT_LABELS).map((mode) => ({
      label: QT_LABELS[mode] + (mode === currentMode ? '  ✓' : ''),
      click: () => h.update(ws.id, { quickTabsMode: mode }),
    })),
  })

  if (!ws.isDefault) {
    template.push({ type: 'separator' })
    if (ws.isArchived) {
      template.push({ label: 'Restore', click: () => h.restore(ws.id) })
    } else {
      template.push({ label: 'Archive', click: () => h.archive(ws.id) })
    }
    template.push({
      label: 'Delete workspace',
      click: async () => {
        const count = (ws.identityIds && ws.identityIds.length) || 0
        const result = await Promise.resolve(
          h.remove(ws.id, count > 0 ? { cascade: true } : undefined),
        )
        // If the result is a structured rejection, surface to the renderer so
        // the sidebar can alert the user.
        if (result && result.ok === false) {
          browser.broadcastToWebUI('oz:sidebar:remove-rejected', {
            kind: 'workspace',
            id: ws.id,
            reason: result.reason,
            lockedCount: result.lockedCount || 0,
          })
        }
      },
    })
  }

  return template
}

module.exports = { buildWorkspaceContextMenu }
