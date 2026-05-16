// OZ Browser — auto-updater IPC handlers (I-2 v1.6.0).
//
// Extracted from ipc-handlers.js to keep that file under the 500-LOC budget
// (ADR 0005). Pure wiring — the heavy lifting lives in auto-updater-setup.js.
//
// Renderer IPC channels:
//   oz:auto-updater:check    → trigger an immediate check (ignores
//                              settings.autoUpdate.enabled toggle so user can
//                              opt-in to a one-off check even when disabled)
//   oz:auto-updater:install  → quit + install previously downloaded update.
//                              Returns false if no update is pending.
//
// Background events come from autoUpdater event listeners wired in
// browser/auto-updater-setup.js and broadcasted to the WebUI via
// `oz:auto-updater:*` channels (checking / available / not-available /
// download-progress / downloaded / error).

const { ipcMain } = require('electron')
const autoUpdater = require('./auto-updater-setup')

function registerAutoUpdaterHandlersIPC(_browser) {
  ipcMain.handle('oz:auto-updater:check', () => {
    const dispatched = autoUpdater.checkForUpdatesManual()
    return { dispatched }
  })
  ipcMain.handle('oz:auto-updater:install', () => {
    const dispatched = autoUpdater.quitAndInstall()
    return { dispatched }
  })
}

module.exports = { registerAutoUpdaterHandlersIPC }
