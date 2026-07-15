// OZ Browser — preload bridge para Tabs. Extraído de preload.js para
// mantenerlo bajo el límite de 500 LOC (ADR 0005). Mismo patrón que
// preload-projects-api.js.
//
// Doc: docs/modules/preload-tabs-api.md

'use strict'

function buildTabsApi(ipcRenderer) {
  return {
    list: () => ipcRenderer.invoke('oz:tabs:list'),
    getIdentity: (tabId) => ipcRenderer.invoke('oz:tabs:getIdentity', tabId),
    openInIdentity: (identityId, url) =>
      ipcRenderer.invoke('oz:tabs:openInIdentity', identityId, url),
    select: (tabId) => ipcRenderer.invoke('oz:tabs:select', tabId),
    reorder: (tabId, toIndex) => ipcRenderer.invoke('oz:tabs:reorder', tabId, toIndex),
    close: (tabId) => ipcRenderer.invoke('oz:tabs:close', tabId),
    // H1 — Cmd+Shift+T binding lives in the native menu (browser/menu.js)
    // but we expose this here so the renderer can also trigger it via
    // keyboard shortcut interception or the Edit menu.
    reopenClosed: () => ipcRenderer.invoke('oz:tabs:reopenClosed'),
    bulkCreateLazy: (count, identityId, urlTemplate) =>
      ipcRenderer.invoke('oz:tabs:bulkCreateLazy', count, identityId, urlTemplate),
    moveToWorkspace: (tabId, targetWorkspaceId) =>
      ipcRenderer.invoke('oz:tabs:moveToWorkspace', tabId, targetWorkspaceId),
    // alpha.103: expose moveToNewWindow so the command palette (⌥S) works
    // from the renderer, not just the native tab menu.
    moveToNewWindow: (tabId) => ipcRenderer.invoke('oz:tabs:moveToNewWindow', tabId),
    // 1.7a: pop the native context menu for a tab (delegates to main, which
    // builds the template via tab-context-menu.js and runs Menu.popup()).
    contextMenu: (tabId, opts) => ipcRenderer.invoke('oz:tabs:contextMenu', tabId, opts),
    // 1.7a: tab actions exposed to renderer (for keyboard shortcuts that
    // can't go through the menu, e.g. Alt+D in tabstrip while focused).
    reload: (tabId) => ipcRenderer.invoke('oz:tabs:reload', tabId),
    duplicate: (tabId) => ipcRenderer.invoke('oz:tabs:duplicate', tabId),
    pin: (tabId) => ipcRenderer.invoke('oz:tabs:pin', tabId),
    unpin: (tabId) => ipcRenderer.invoke('oz:tabs:unpin', tabId),
    // H2: lock/unlock — close + moveToWorkspace + moveToNewWindow reject;
    // closeOthers/closeToRight skip (just like pinned).
    lock: (tabId) => ipcRenderer.invoke('oz:tabs:lock', tabId),
    unlock: (tabId) => ipcRenderer.invoke('oz:tabs:unlock', tabId),
    mute: (tabId) => ipcRenderer.invoke('oz:tabs:mute', tabId),
    unmute: (tabId) => ipcRenderer.invoke('oz:tabs:unmute', tabId),

    onUpdated(cb) {
      const listener = (_e, info) => cb(info)
      ipcRenderer.on('oz:tabs:updated', listener)
      return () => ipcRenderer.off('oz:tabs:updated', listener)
    },
  }
}

module.exports = { buildTabsApi }
