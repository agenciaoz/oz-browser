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

      onUpdated(cb) {
        const listener = (_e, info) => cb(info)
        ipcRenderer.on('oz:tabs:updated', listener)
        return () => ipcRenderer.off('oz:tabs:updated', listener)
      },
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
