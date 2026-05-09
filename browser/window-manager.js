// OZ Browser — TabbedBrowserWindow: one BrowserWindow + its Tabs + sidebar wiring.

const { BrowserWindow, session } = require('electron')
const { Tabs } = require('./tabs')

class TabbedBrowserWindow {
  constructor(options) {
    this.session = options.session || session.defaultSession
    this.extensions = options.extensions
    this.identityManager = options.identityManager

    // Can't inherit BrowserWindow (Electron #23 regression).
    this.window = new BrowserWindow(options.window)
    this.id = this.window.id
    this.webContents = this.window.webContents

    const webuiUrl = `chrome-extension://${options.webuiExtensionId}/webui.html`
    this.webContents.loadURL(webuiUrl)

    this.tabs = new Tabs(this.window, this.identityManager)

    this._wireTabEvents(options.urls)
    this._createInitialTab(options)
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
      // First tab is always eager so the window has something to display.
      const tab = this.tabs.create({
        url: options.initialUrl || options.urls.newtab,
        materialize: true,
        source: 'window-manager._createInitialTab',
      })
      this.tabs.select(tab.id)
    })
  }

  _sendToWebUI(channel, payload) {
    if (this.window?.webContents && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(channel, payload)
    }
  }

  destroy() {
    this.tabs.destroy()
    this.window.destroy()
  }

  getFocusedTab() {
    return this.tabs.selected
  }
}

module.exports = { TabbedBrowserWindow }
