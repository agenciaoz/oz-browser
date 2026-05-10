// OZ Browser preload — runs in every WebContents.
// Exposes window.oz to the browser chrome (webui.html) only.

const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

const isWebUI =
  location.protocol === 'chrome-extension:' && location.pathname === '/webui.html'

if (isWebUI) {
  injectBrowserAction()

  // Forward unhandled errors from the renderer (browser chrome) to the main
  // process so they hit the unified logger and the user-visible error popup.
  window.addEventListener('error', (event) => {
    const detail = {
      source: 'renderer/webui',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error && event.error.stack ? event.error.stack : null,
    }
    ipcRenderer.invoke('oz:report-error', detail).catch(() => {})
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const detail = {
      source: 'renderer/webui',
      message: 'Unhandled promise rejection',
      reason: reason && reason.stack ? reason.stack : String(reason),
    }
    ipcRenderer.invoke('oz:report-error', detail).catch(() => {})
  })

  contextBridge.exposeInMainWorld('oz', {
    identities: {
      list: () => ipcRenderer.invoke('oz:identities:list'),
      get: (id) => ipcRenderer.invoke('oz:identities:get', id),
      getActive: () => ipcRenderer.invoke('oz:identities:getActive'),
      setActive: (id) => ipcRenderer.invoke('oz:identities:setActive', id),
      create: (opts) => ipcRenderer.invoke('oz:identities:create', opts),
      rename: (id, name) => ipcRenderer.invoke('oz:identities:rename', id, name),
      setColor: (id, color) => ipcRenderer.invoke('oz:identities:setColor', id, color),
      update: (id, patch) => ipcRenderer.invoke('oz:identities:update', id, patch),
      remove: (id) => ipcRenderer.invoke('oz:identities:remove', id),

      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:identities:changed', listener)
        return () => ipcRenderer.off('oz:identities:changed', listener)
      },
      onActiveChanged(cb) {
        const listener = (_e, id) => cb(id)
        ipcRenderer.on('oz:identities:active-changed', listener)
        return () => ipcRenderer.off('oz:identities:active-changed', listener)
      },
    },
    workspaces: {
      list: () => ipcRenderer.invoke('oz:workspaces:list'),
      listActive: () => ipcRenderer.invoke('oz:workspaces:listActive'),
      get: (id) => ipcRenderer.invoke('oz:workspaces:get', id),
      getActive: (windowId) => ipcRenderer.invoke('oz:workspaces:getActive', windowId),
      setActive: (workspaceId, windowId) =>
        ipcRenderer.invoke('oz:workspaces:setActive', workspaceId, windowId),
      create: (opts) => ipcRenderer.invoke('oz:workspaces:create', opts),
      update: (id, patch) => ipcRenderer.invoke('oz:workspaces:update', id, patch),
      rename: (id, name) => ipcRenderer.invoke('oz:workspaces:rename', id, name),
      setColor: (id, color) => ipcRenderer.invoke('oz:workspaces:setColor', id, color),
      duplicate: (id) => ipcRenderer.invoke('oz:workspaces:duplicate', id),
      archive: (id) => ipcRenderer.invoke('oz:workspaces:archive', id),
      restore: (id) => ipcRenderer.invoke('oz:workspaces:restore', id),
      freeze: (id) => ipcRenderer.invoke('oz:workspaces:freeze', id),
      unfreeze: (id) => ipcRenderer.invoke('oz:workspaces:unfreeze', id),
      remove: (id) => ipcRenderer.invoke('oz:workspaces:remove', id),

      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:workspaces:changed', listener)
        return () => ipcRenderer.off('oz:workspaces:changed', listener)
      },
      onActiveChanged(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:workspaces:active-changed', listener)
        return () => ipcRenderer.off('oz:workspaces:active-changed', listener)
      },
    },
    tabs: {
      list: () => ipcRenderer.invoke('oz:tabs:list'),
      getIdentity: (tabId) => ipcRenderer.invoke('oz:tabs:getIdentity', tabId),
      openInIdentity: (identityId, url) =>
        ipcRenderer.invoke('oz:tabs:openInIdentity', identityId, url),
      select: (tabId) => ipcRenderer.invoke('oz:tabs:select', tabId),
      close: (tabId) => ipcRenderer.invoke('oz:tabs:close', tabId),
      bulkCreateLazy: (count, identityId, urlTemplate) =>
        ipcRenderer.invoke('oz:tabs:bulkCreateLazy', count, identityId, urlTemplate),
      moveToWorkspace: (tabId, targetWorkspaceId) =>
        ipcRenderer.invoke('oz:tabs:moveToWorkspace', tabId, targetWorkspaceId),
      // 1.7a: pop the native context menu for a tab (delegates to main, which
      // builds the template via tab-context-menu.js and runs Menu.popup()).
      contextMenu: (tabId, opts) =>
        ipcRenderer.invoke('oz:tabs:contextMenu', tabId, opts),
      // 1.7a: tab actions exposed to renderer (for keyboard shortcuts that
      // can't go through the menu, e.g. Alt+D in tabstrip while focused).
      reload: (tabId) => ipcRenderer.invoke('oz:tabs:reload', tabId),
      duplicate: (tabId) => ipcRenderer.invoke('oz:tabs:duplicate', tabId),
      pin: (tabId) => ipcRenderer.invoke('oz:tabs:pin', tabId),
      unpin: (tabId) => ipcRenderer.invoke('oz:tabs:unpin', tabId),
      mute: (tabId) => ipcRenderer.invoke('oz:tabs:mute', tabId),
      unmute: (tabId) => ipcRenderer.invoke('oz:tabs:unmute', tabId),

      onUpdated(cb) {
        const listener = (_e, info) => cb(info)
        ipcRenderer.on('oz:tabs:updated', listener)
        return () => ipcRenderer.off('oz:tabs:updated', listener)
      },
    },
    vault: {
      status: () => ipcRenderer.invoke('oz:vault:status'),
      unlock: () => ipcRenderer.invoke('oz:vault:unlock'),
      lock: () => ipcRenderer.invoke('oz:vault:lock'),
      destroy: () => ipcRenderer.invoke('oz:vault:destroy'),

      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:vault:changed', listener)
        return () => ipcRenderer.off('oz:vault:changed', listener)
      },
    },
    accounts: {
      list: (filter) => ipcRenderer.invoke('oz:accounts:list', filter),
      get: (id) => ipcRenderer.invoke('oz:accounts:get', id),
      create: (opts) => ipcRenderer.invoke('oz:accounts:create', opts),
      update: (id, patch) => ipcRenderer.invoke('oz:accounts:update', id, patch),
      remove: (id) => ipcRenderer.invoke('oz:accounts:remove', id),
      setAll: (accounts) => ipcRenderer.invoke('oz:accounts:setAll', accounts),
      // 1.5c auto-fill / auto-save primitives
      getCredentialsForSite: (site, identityId) =>
        ipcRenderer.invoke('oz:accounts:getCredentialsForSite', site, identityId),
      proposeAutoSave: (opts) => ipcRenderer.invoke('oz:accounts:proposeAutoSave', opts),

      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:accounts:changed', listener)
        return () => ipcRenderer.off('oz:accounts:changed', listener)
      },
      onProposeAutoSave(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:autofill:propose-save', listener)
        return () => ipcRenderer.off('oz:autofill:propose-save', listener)
      },
    },
    excel: {
      exportToFile: (filePath) => ipcRenderer.invoke('oz:excel:exportToFile', filePath),
      importFromFile: (filePath, mode) =>
        ipcRenderer.invoke('oz:excel:importFromFile', filePath, mode),
      // 1.5f: native file dialogs proxied via main (renderer can't hit dialog API directly)
      pickExportPath: () => ipcRenderer.invoke('oz:excel:pickExportPath'),
      pickImportPath: () => ipcRenderer.invoke('oz:excel:pickImportPath'),
    },
    timemachine: {
      create: (opts) => ipcRenderer.invoke('oz:timemachine:create', opts),
      list: () => ipcRenderer.invoke('oz:timemachine:list'),
      restore: (id) => ipcRenderer.invoke('oz:timemachine:restore', id),
      remove: (id) => ipcRenderer.invoke('oz:timemachine:remove', id),
      applyRetention: (opts) => ipcRenderer.invoke('oz:timemachine:applyRetention', opts),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:timemachine:changed', listener)
        return () => ipcRenderer.off('oz:timemachine:changed', listener)
      },
      onRestoreCompleted(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:timemachine:restore-completed', listener)
        return () => ipcRenderer.off('oz:timemachine:restore-completed', listener)
      },
    },
    bookmarks: {
      list: (filter) => ipcRenderer.invoke('oz:bookmarks:list', filter),
      get: (id) => ipcRenderer.invoke('oz:bookmarks:get', id),
      add: (opts) => ipcRenderer.invoke('oz:bookmarks:add', opts),
      addFromTab: (tabId) => ipcRenderer.invoke('oz:bookmarks:addFromTab', tabId),
      remove: (id) => ipcRenderer.invoke('oz:bookmarks:remove', id),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:bookmarks:changed', listener)
        return () => ipcRenderer.off('oz:bookmarks:changed', listener)
      },
    },
    cookies: {
      exportContent: (identityId, format) =>
        ipcRenderer.invoke('oz:cookies:exportContent', identityId, format),
      exportToFile: (identityId, format, filePath) =>
        ipcRenderer.invoke('oz:cookies:exportToFile', identityId, format, filePath),
      importContent: (identityId, format, content) =>
        ipcRenderer.invoke('oz:cookies:importContent', identityId, format, content),
      importFromFile: (identityId, format, filePath) =>
        ipcRenderer.invoke('oz:cookies:importFromFile', identityId, format, filePath),
      pickExportPath: (identityId, format) =>
        ipcRenderer.invoke('oz:cookies:pickExportPath', identityId, format),
      pickImportPath: (format) => ipcRenderer.invoke('oz:cookies:pickImportPath', format),
    },
    nav: {
      back: () => ipcRenderer.invoke('oz:nav:back'),
      forward: () => ipcRenderer.invoke('oz:nav:forward'),
      reload: () => ipcRenderer.invoke('oz:nav:reload'),
      loadURL: (url) => ipcRenderer.invoke('oz:nav:loadURL', url),
    },
    ui: {
      // Hide / show the active tab's WebContentsView. Required when the WebUI
      // wants to show a modal that needs to cover the content area (native
      // WebContentsView always renders on top of HTML chrome).
      setContentVisible: (visible) =>
        ipcRenderer.invoke('oz:ui:setContentVisible', !!visible),
    },
    log: {
      debug: (source, msg, ...args) =>
        ipcRenderer.invoke('oz:log', 'DEBUG', source, msg, args),
      info: (source, msg, ...args) =>
        ipcRenderer.invoke('oz:log', 'INFO', source, msg, args),
      warn: (source, msg, ...args) =>
        ipcRenderer.invoke('oz:log', 'WARN', source, msg, args),
      error: (source, msg, ...args) =>
        ipcRenderer.invoke('oz:log', 'ERROR', source, msg, args),
      reportError: (detail) => ipcRenderer.invoke('oz:report-error', detail),
    },
  })
}
