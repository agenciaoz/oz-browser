// OZ Browser — runtime paths and small helpers shared across main-process modules.

const path = require('path')
const { app, BrowserWindow } = require('electron')

// At runtime under electron-forge webpack, __dirname = .webpack/main, so
// PROJECT_ROOT goes up 2 levels from the bundled main.
const PROJECT_ROOT = path.join(__dirname, '../../')

const PATHS = {
  WEBUI: app.isPackaged
    ? path.resolve(process.resourcesPath, 'ui')
    : path.resolve(PROJECT_ROOT, 'browser', 'ui'),
  PRELOAD: path.join(__dirname, '../renderer/browser/preload.js'),
  LOCAL_EXTENSIONS: path.join(PROJECT_ROOT, 'extensions'),
}

/** Find the parent BrowserWindow of an arbitrary webContents. */
function getParentWindowOfTab(tab) {
  switch (tab.getType()) {
    case 'window':
      return BrowserWindow.fromWebContents(tab)
    case 'browserView':
    case 'webview':
      return tab.getOwnerBrowserWindow()
    case 'backgroundPage':
      return BrowserWindow.getFocusedWindow()
    default:
      throw new Error(`Unable to find parent window of '${tab.getType()}'`)
  }
}

module.exports = { PROJECT_ROOT, PATHS, getParentWindowOfTab }
