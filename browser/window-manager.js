// OZ Browser — TabbedBrowserWindow: one BrowserWindow + its Tabs + sidebar wiring.

const { BrowserWindow, session } = require('electron')
const { Tabs } = require('./tabs')
const {
  switchWorkspace,
  hydrateWorkspace,
  releaseOnDestroy,
} = require('./window-workspace')

class TabbedBrowserWindow {
  constructor(options) {
    this.session = options.session || session.defaultSession
    this.extensions = options.extensions
    this.identityManager = options.identityManager
    this.browser = options.browser // 1.4b: needed for workspace switch logic

    // Can't inherit BrowserWindow (Electron #23 regression).
    this.window = new BrowserWindow(options.window)
    this.id = this.window.id
    this.webContents = this.window.webContents

    const webuiUrl = `chrome-extension://${options.webuiExtensionId}/webui.html`
    this.webContents.loadURL(webuiUrl)

    this.tabs = new Tabs(this.window, this.identityManager)

    // 1.10b: hook history tracking. HistoryManager subscribes to tab-updated
    // events and dedups + persists URL visits per identity.
    if (options.historyManager) {
      try {
        options.historyManager.hookTabs(this.tabs)
      } catch (_e) {
        // best-effort
      }
    }

    // 1.4b: each window owns exactly one workspace (1-1 lock — ADR 0015).
    // Default to the workspace explicitly requested, or the Default workspace.
    const wm = this.browser && this.browser.workspaceManager
    this.workspaceId = options.workspaceId || (wm ? wm.getDefault().id : null)

    this._wireTabEvents(options.urls)
    this._createInitialTab(options)

    // 1.4b: when the BrowserWindow closes (user-initiated, not via destroy()),
    // snapshot the workspace + release the lock so another window can claim it.
    this.window.on('close', () => {
      if (this.browser) {
        try {
          releaseOnDestroy(this, this.browser)
        } catch (_e) {
          // best-effort
        }
      }
    })
  }

  /**
   * Switch this window to another workspace. Delegates to window-workspace.js.
   * Returns { ok, workspaceId, ... } with reason if rejected (lock conflict, etc.).
   */
  switchToWorkspace(targetWorkspaceId) {
    if (!this.browser) {
      return { ok: false, reason: 'no-browser-ref' }
    }
    return switchWorkspace({
      window: this,
      browser: this.browser,
      targetWorkspaceId,
    })
  }

  /** Wire Tabs events → ChromeExtensions API + sidebar IPC notifications. */
  _wireTabEvents(urls) {
    const self = this

    // Lazy tabs are NOT registered with the Chrome extensions API until they
    // materialize (the API keys tabs by webContents.id which doesn't exist
    // until then).
    this.tabs.on('tab-created', (tab) => {
      if (!tab.pendingUrl && !tab.isMaterialized()) {
        tab.pendingUrl = urls.newtab
      }
      self._sendToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...tab.serialize(), windowId: self.id },
      })
    })

    this.tabs.on('tab-materialized', (tab) => {
      // Only register with the extensions API if the tab uses the default
      // session. Identity-bound tabs use partition sessions; per-Identity
      // extension support is deferred to Bloque 1.10.
      if (tab.webContents.session === self.session) {
        self.extensions.addTab(tab.webContents, tab.window)
      }
      self._sendToWebUI('oz:tabs:updated', {
        kind: 'materialized',
        tabId: tab.id,
        tab: { ...tab.serialize(), windowId: self.id },
      })
    })

    this.tabs.on('tab-updated', (tab, info) => {
      self._sendToWebUI('oz:tabs:updated', {
        kind: 'updated',
        tabId: tab.id,
        tab: { ...info, windowId: self.id },
      })
    })

    this.tabs.on('tab-selected', (tab) => {
      // tab.show() materializes via Tabs.select.
      if (tab.webContents && tab.webContents.session === self.session) {
        self.extensions.selectTab(tab.webContents)
      }
      self._sendToWebUI('oz:tabs:updated', { kind: 'selected', tabId: tab.id })
    })

    this.tabs.on('tab-destroyed', (tab) => {
      self._sendToWebUI('oz:tabs:updated', { kind: 'removed', tabId: tab.id })
    })
  }

  _createInitialTab(options) {
    queueMicrotask(() => {
      // 1.4b: if this window owns a workspace with persisted tabSpecs, recreate
      // them lazy and select the persisted activeTabId. Otherwise (first run /
      // empty workspace) hydrateWorkspace creates a fresh newtab.
      const wm = this.browser && this.browser.workspaceManager
      const ws = wm && this.workspaceId ? wm.get(this.workspaceId) : null
      if (ws && ws.tabSpecs && ws.tabSpecs.length > 0) {
        hydrateWorkspace({ window: this, browser: this.browser })
        return
      }
      // No tabSpecs — original behavior: eager newtab.
      const tab = this.tabs.create({
        url: options.initialUrl || options.urls.newtab,
        materialize: true,
        source: 'window-manager._createInitialTab',
      })
      this.tabs.select(tab.id)
    })
  }

  _sendToWebUI(channel, payload) {
    // alpha.97: guard contra "Object has been destroyed". Durante el teardown,
    // el WebContents de una página puede emitir un evento de Tabs que llega
    // acá DESPUÉS de que la ventana fue destruida. Chequear solo
    // `webContents.isDestroyed()` no alcanza: si el BrowserWindow ya está
    // destruido, el GETTER `this.window.webContents` por sí solo tira el
    // TypeError (el `?.` no corta porque this.window no es null, está
    // destruido). Hay que chequear `this.window.isDestroyed()` ANTES de tocar
    // .webContents, y envolver en try/catch como red final contra el race.
    const win = this.window
    if (!win || win.isDestroyed()) return
    try {
      const wc = win.webContents
      if (wc && !wc.isDestroyed()) wc.send(channel, payload)
    } catch (_e) {
      /* ventana/webContents destruido a mitad del envío — ignorar en teardown */
    }
  }

  destroy() {
    // 1.4b: snapshot live tabs into the workspace + release the lock so another
    // window can claim it. Must happen BEFORE we destroy WebContentsViews.
    if (this.browser) {
      try {
        releaseOnDestroy(this, this.browser)
      } catch (_e) {
        // Don't block shutdown on a snapshot failure — log handled inside.
      }
    }
    this.tabs.destroy()
    this.window.destroy()
  }

  getFocusedTab() {
    return this.tabs.selected
  }
}

module.exports = { TabbedBrowserWindow }
