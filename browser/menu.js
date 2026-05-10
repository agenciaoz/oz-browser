const { Menu } = require('electron')
const log = require('./logger')

const setupMenu = (browser) => {
  const isMac = process.platform === 'darwin'

  const tab = () => browser.getFocusedWindow().getFocusedTab()
  const tabWc = () => tab().webContents

  // 1.6b: manual snapshot via keyboard shortcut. Skips silently if vault is
  // locked (we don't want to surprise the user with a Keychain prompt from
  // a global shortcut). User can take snapshots from the Time Machine modal
  // when locked.
  const manualSnapshot = () => {
    if (!browser.backupManager || !browser.accountVault?.isUnlocked) {
      log.warn('menu', 'manual snapshot shortcut ignored — vault locked')
      return
    }
    try {
      const snap = browser.backupManager.createSnapshot({ reason: 'manual' })
      browser.broadcastToWebUI('oz:timemachine:changed')
      log.info('menu', 'manual snapshot via shortcut', { id: snap.id })
    } catch (err) {
      log.error('menu', 'manual snapshot shortcut failed', { message: err.message })
    }
  }

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          nonNativeMacOSRole: true,
          click: () => tabWc().reload(),
        },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          nonNativeMacOSRole: true,
          click: () => tabWc().reloadIgnoringCache(),
        },
        {
          label: 'Toggle Developer Tool asdf',
          accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          nonNativeMacOSRole: true,
          click: () => tabWc().toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Time Machine',
      submenu: [
        {
          label: 'Take snapshot now',
          accelerator: 'Shift+CmdOrCtrl+B',
          click: manualSnapshot,
        },
      ],
    },
    { role: 'windowMenu' },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

module.exports = {
  setupMenu,
}
