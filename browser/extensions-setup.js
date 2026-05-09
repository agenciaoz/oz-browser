// OZ Browser — Chrome extensions integration: session UA scrub, ChromeExtensions
// instance, Web Store install, and per-webContents handlers (window.open, context menu).

const { app, session, dialog } = require('electron')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { buildChromeContextMenu } = require('electron-chrome-context-menu')
const { installChromeWebStore, loadAllExtensions } = require('electron-chrome-web-store')
const { PATHS } = require('./paths')
const log = require('./logger')

/** Set up the default session: strip Electron/App from UA, log SW status. */
function initSession(browser) {
  browser.session = session.defaultSession

  const userAgent = browser.session
    .getUserAgent()
    .replace(/\sElectron\/\S+/, '')
    .replace(new RegExp(`\\s${app.getName()}/\\S+`), '')
  browser.session.setUserAgent(userAgent)

  browser.session.serviceWorkers.on('running-status-changed', (event) => {
    log.debug('sw', `service worker ${event.versionId} ${event.runningStatus}`)
  })

  if (process.env.SHELL_DEBUG) {
    browser.session.serviceWorkers.once('running-status-changed', () => {
      const tab = browser.windows[0]?.getFocusedTab()
      if (tab && tab.webContents) tab.webContents.inspectServiceWorker()
    })
  }
}

/** Register the OZ preload script for the default session. */
function registerPreload(ses) {
  if ('registerPreloadScript' in ses) {
    ses.registerPreloadScript({
      id: 'oz-preload',
      type: 'frame',
      filePath: PATHS.PRELOAD,
    })
  } else {
    ses.setPreloads([PATHS.PRELOAD])
  }
}

/**
 * Build ElectronChromeExtensions and wire createTab/selectTab/removeTab/
 * createWindow/removeWindow to the Browser. Returns the extensions instance.
 */
function buildChromeExtensions(browser) {
  const extensions = new ElectronChromeExtensions({
    license: 'internal-license-do-not-use',
    session: browser.session,

    createTab: async (details) => {
      await browser.ready
      const win =
        typeof details.windowId === 'number' &&
        browser.windows.find((w) => w.id === details.windowId)
      if (!win) throw new Error(`Unable to find windowId=${details.windowId}`)
      log.info('ext', 'chrome.tabs.create incoming', {
        url: details.url,
        windowId: details.windowId,
        active: details.active,
      })
      const tab = win.tabs.create({
        identityId: browser.activeIdentityId,
        url: details.url,
        materialize: true,
        source: 'chromeExtensionsAPI.createTab',
      })
      if (typeof details.active === 'boolean' ? details.active : true) {
        win.tabs.select(tab.id)
      }
      return [tab.webContents, tab.window]
    },

    selectTab: (tab, browserWindow) => {
      const win = browser.getWindowFromBrowserWindow(browserWindow)
      if (!win) return
      const ozTab = win.tabs.getByWebContentsId(tab.id)
      if (ozTab) win.tabs.select(ozTab.id)
    },

    removeTab: (tab, browserWindow) => {
      const win = browser.getWindowFromBrowserWindow(browserWindow)
      if (!win) return
      const ozTab = win.tabs.getByWebContentsId(tab.id)
      if (ozTab) win.tabs.remove(ozTab.id)
    },

    createWindow: async (details) => {
      await browser.ready
      const win = browser.createWindow({ initialUrl: details.url })
      return win.window
    },

    removeWindow: (browserWindow) => {
      const win = browser.getWindowFromBrowserWindow(browserWindow)
      win?.destroy()
    },
  })

  ElectronChromeExtensions.handleCRXProtocol(browser.session)

  extensions.on('browser-action-popup-created', (popup) => {
    browser.popup = popup
  })

  extensions.on('url-overrides-updated', (urlOverrides) => {
    if (urlOverrides.newtab) browser.urls.newtab = urlOverrides.newtab
  })

  return extensions
}

/** Load WebUI extension + Chrome Web Store + local extensions. */
async function loadExtensions(browser) {
  const webuiExtension = await browser.session.extensions.loadExtension(PATHS.WEBUI)
  browser.webuiExtensionId = webuiExtension.id

  await installChromeWebStore({
    session: browser.session,
    async beforeInstall(details) {
      if (!details.browserWindow || details.browserWindow.isDestroyed()) return
      const title = `Add "${details.localizedName}"?`
      let message = title
      if (details.manifest.permissions) {
        message += `\n\nPermissions: ${(details.manifest.permissions || []).join(', ')}`
      }
      const result = await dialog.showMessageBox(details.browserWindow, {
        title,
        message,
        icon: details.icon,
        buttons: ['Cancel', 'Add Extension'],
      })
      return { action: result.response === 0 ? 'deny' : 'allow' }
    },
  })

  if (!app.isPackaged) {
    await loadAllExtensions(browser.session, PATHS.LOCAL_EXTENSIONS, {
      allowUnpacked: true,
    }).catch((err) =>
      log.warn('ext', 'loadAllExtensions failed (folder may not exist)', err.message),
    )
  }

  await Promise.all(
    browser.session.extensions.getAllExtensions().map(async (extension) => {
      const manifest = extension.manifest
      if (manifest.manifest_version === 3 && manifest?.background?.service_worker) {
        await browser.session.serviceWorkers
          .startWorkerForScope(extension.url)
          .catch((err) => log.error('ext', 'service worker start failed', err.message))
      }
    }),
  )
}

/** Wire window.open + right-click context menu for an arbitrary webContents. */
function setupWebContentsCreatedHandler(browser) {
  app.on('web-contents-created', (_event, webContents) => {
    const type = webContents.getType()
    const url = webContents.getURL()
    log.debug('wc', `web-contents-created [type:${type}, url:${url}]`)

    if (process.env.SHELL_DEBUG && ['backgroundPage', 'remote'].includes(type)) {
      webContents.openDevTools({ mode: 'detach', activate: true })
    }

    webContents.setWindowOpenHandler((details) => {
      if (
        ['foreground-tab', 'background-tab', 'new-window'].includes(details.disposition)
      ) {
        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: ({ webContents: guest, webPreferences }) => {
            const win = browser.getWindowFromWebContents(webContents)
            log.info('wc', 'window.open → new tab', {
              disposition: details.disposition,
              url: details.url,
              opener: webContents.getURL(),
            })
            const tab = win.tabs.create({
              webContents: guest,
              webPreferences,
              identityId: browser.activeIdentityId,
              url: details.url,
              source: `windowOpen[${details.disposition}]`,
            })
            return tab.webContents
          },
        }
      }
      return { action: 'allow' }
    })

    webContents.on('context-menu', (_e, params) => {
      const menu = buildChromeContextMenu({
        params,
        webContents,
        extensionMenuItems: browser.extensions.getContextMenuItems(webContents, params),
        openLink: (url, disposition) => {
          const win = browser.getFocusedWindow()
          if (disposition === 'new-window') {
            browser.createWindow({ initialUrl: url })
          } else {
            const tab = win.tabs.create({
              identityId: browser.activeIdentityId,
              url,
              source: 'contextMenu.openLink',
            })
            win.tabs.select(tab.id)
          }
        },
      })
      menu.popup()
    })
  })
}

module.exports = {
  initSession,
  registerPreload,
  buildChromeExtensions,
  loadExtensions,
  setupWebContentsCreatedHandler,
}
