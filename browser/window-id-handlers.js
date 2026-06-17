// OZ Browser — window-id IPC (alpha.42).
//
// Lets a renderer (the sidebar webUI) learn its OWN OZ window id, so it can
// scope the global Default identity's tabs to the current window. The Default
// jar is global (ADR 0035), but each OZ window is locked to one workspace
// (ADR 0015), so Default tabs are still per-window — without this the sidebar
// can't tell which Default tabs belong to its window.
//
// e.sender is the webUI WebContents, which equals win.webContents (the same
// target broadcastToWebUI sends to), so the lookup is a direct identity match.
//
// ADR: 0035 (Default identity global) · 0005 (modular 500 LOC)

const { ipcMain } = require('electron')

function registerWindowIdHandlersIPC(browser) {
  ipcMain.handle('oz:window:getId', (e) => {
    const win = (browser.windows || []).find(
      (w) => w.webContents && w.webContents === e.sender,
    )
    return win ? win.id : null
  })
}

module.exports = { registerWindowIdHandlersIPC }
