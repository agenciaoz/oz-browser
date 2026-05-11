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

  // 1.7d: keyboard shortcuts for Ghost Browser parity. These call the same
  // tab-handlers / tab-context-handlers maps the right-click menu uses.
  const focusedTabId = () => {
    const t = browser.getFocusedWindow()?.getFocusedTab()
    return t ? t.id : null
  }
  const focusedIdentityId = () => {
    const t = browser.getFocusedWindow()?.getFocusedTab()
    return (t && t.identityId) || browser.activeIdentityId
  }
  const tabsH = () => browser.handlers && browser.handlers.tabs
  const idsH = () => browser.handlers && browser.handlers.identities

  const newTabCurrentId = () => {
    const id = focusedIdentityId()
    if (id && tabsH()) tabsH().openInIdentity(id, 'about:blank')
  }
  const newTabDefault = () => {
    const def = browser.identityManager?.getDefault()
    if (def && tabsH()) tabsH().openInIdentity(def.id, 'about:blank')
  }
  const newIdentity = () => {
    if (!idsH()) return
    const ident = idsH().create({ name: 'New Identity' })
    if (ident && ident.id && tabsH()) {
      tabsH().openInIdentity(ident.id, 'about:blank')
    }
  }
  const duplicateFocused = () => {
    const id = focusedTabId()
    if (id && tabsH()) tabsH().duplicate(id)
  }
  const moveFocusedToNewWindow = () => {
    const id = focusedTabId()
    if (id && tabsH()) tabsH().moveToNewWindow(id)
  }
  const togglePinFocused = () => {
    const focused = browser.getFocusedWindow()?.getFocusedTab()
    if (!focused || !tabsH()) return
    if (focused.pinned) tabsH().unpin(focused.id)
    else tabsH().pin(focused.id)
  }
  // H1 — reopen most recently closed tab in focused window.
  const reopenClosed = () => {
    if (tabsH()) tabsH().reopenClosed()
  }
  // H2 — toggle lock on focused tab.
  const toggleLockFocused = () => {
    const focused = browser.getFocusedWindow()?.getFocusedTab()
    if (!focused || !tabsH()) return
    if (focused.locked) tabsH().unlock(focused.id)
    else tabsH().lock(focused.id)
  }

  // C-1 — Cmd+K opens the command palette. We target only the focused
  // window's WebUI (broadcastToWebUI sends to all windows, which would open
  // the palette in every chrome at once — not what the user wants).
  const openCommandPalette = () => {
    const win = browser.getFocusedWindow()
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('oz:command-palette:open')
    }
  }

  // C-4 — ⌥⇧O opens the bulk multi-account opener. Same focused-window
  // routing as Cmd+K so multi-window setups don't get duplicate modals.
  const openBulkOpener = () => {
    const win = browser.getFocusedWindow()
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('oz:bulk-open:open')
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
          label: 'Toggle Developer Tools',
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
    // 1.7d: Tab menu — Ghost-parity keyboard shortcuts. The full 16-option
    // context menu still lives on right-click; this shortlist is for muscle
    // memory (Cmd+T new tab, Alt+D duplicate, etc).
    {
      label: 'Tab',
      submenu: [
        {
          label: 'New Tab (Current Identity)',
          accelerator: 'CmdOrCtrl+T',
          click: newTabCurrentId,
        },
        {
          label: 'New Tab in Default Identity',
          accelerator: 'Alt+G',
          click: newTabDefault,
        },
        {
          label: 'New Identity + New Tab',
          accelerator: 'Alt+N',
          click: newIdentity,
        },
        {
          // H1 — Chrome-style "reopen closed tab" shortcut.
          label: 'Reopen Closed Tab',
          accelerator: 'Shift+CmdOrCtrl+T',
          click: reopenClosed,
        },
        { type: 'separator' },
        {
          label: 'Duplicate Tab',
          accelerator: 'Alt+D',
          click: duplicateFocused,
        },
        {
          label: 'Move Tab to New Window',
          accelerator: 'Alt+S',
          click: moveFocusedToNewWindow,
        },
        {
          label: 'Pin / Unpin Tab',
          accelerator: 'Alt+P',
          click: togglePinFocused,
        },
        {
          // H2 — lock toggle (no Chrome equivalent; Alt+L is free).
          label: 'Lock / Unlock Tab',
          accelerator: 'Alt+L',
          click: toggleLockFocused,
        },
        { type: 'separator' },
        {
          label: 'Open DevTools',
          accelerator: 'Shift+CmdOrCtrl+J',
          click: () => {
            const t = tab()
            if (t && t.webContents) t.webContents.toggleDevTools()
          },
        },
      ],
    },
    {
      // C-1 + C-4 — quick-actions menu. Command palette + Bulk multi-account
      // opener. Future quick-actions join here.
      label: 'Go',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: openCommandPalette,
        },
        {
          label: 'Bulk Open Identities…',
          accelerator: 'Alt+Shift+O',
          click: openBulkOpener,
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
