// OZ Browser — Tab context menu template builder (1.7).
//
// Qué hace: arma el array de menu items para Menu.buildFromTemplate(). Un solo
// menú renderizado nativamente vía Menu.popup() — replica las 16 opciones de
// Ghost Browser. Mismo menú accesible desde sidebar tab list y topbar tabstrip.
//
// Doc: docs/modules/tab-context-menu.md
// ADR: docs/architecture/0016-tab-context-menu.md
//
// Exports: buildTabContextMenu({ browser, tabId, identityId }) -> Array<MenuItem>
//
// Por qué nativo y no HTML: nativo usa el OS menubar que se ve consistente con
// Chrome, soporta keyboard nav out-of-the-box, y no se rompe cuando el
// WebContentsView vive arriba del DOM (ADR 0011 — el HTML ctx-menu del 1.4d
// requería overlays con z-index hacks y no soportaba submenus profundos como
// "Open in Identity → 47 identities").
//
// Convención: items que dependen de handlers no implementados aún (1.7b/c
// agrega bookmark/cookies/clear-data) se marcan con `enabled: false` y un
// label "(Coming in 1.7b)" para que el usuario sepa que viene. Esto evita
// crashes en sub-fases incompletas y comunica progreso.

const log = require('./logger')

/**
 * @param {object} args
 * @param {Browser} args.browser - main process Browser instance
 * @param {string} args.tabId - target tab id (must exist in some window)
 * @returns {Array} menu template ready for Menu.buildFromTemplate
 */
function buildTabContextMenu({ browser, tabId }) {
  const h = browser.handlers && browser.handlers.tabs
  const bookmarksH = browser.handlers && browser.handlers.bookmarks
  const identitiesH = browser.handlers && browser.handlers.identities
  const cookiesH = browser.handlers && browser.handlers.cookies
  if (!h) {
    log.error('tab-context-menu', 'browser.handlers.tabs missing')
    return []
  }
  // Resolve target tab + its identity to populate dynamic labels (Pin/Unpin
  // toggle, Mute/Unmute toggle, Refresh All in <Identity Name>).
  let targetTab = null
  let targetWin = null
  for (const w of browser.windows || []) {
    const t = w.tabs && w.tabs.get && w.tabs.get(tabId)
    if (t) {
      targetTab = t
      targetWin = w
      break
    }
  }
  if (!targetTab) {
    log.warn('tab-context-menu', 'tab not found', { tabId })
    return [{ label: '(tab no longer exists)', enabled: false }]
  }
  const im = browser.identityManager
  const tabIdentity = im && im.get(targetTab.identityId)
  const tabIdentityName = (tabIdentity && tabIdentity.name) || 'Unknown Identity'

  const allIdentities = im ? im.list() : []
  const otherIdentities = allIdentities.filter((i) => i.id !== targetTab.identityId)

  // ---------- "Create a New Tab" submenu --------------------------------
  const newTabSubmenu = [
    {
      label: `Current Identity (${tabIdentityName})`,
      click: () => h.openInIdentity(targetTab.identityId, 'about:blank'),
    },
    {
      label: 'New Temporary Identity',
      click: async () => {
        // Reuse duplicate-in-temporary path but with about:blank.
        try {
          const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
          const ident = im.create({ name: `Temp ${stamp}`, color: '#a8a8a8' })
          browser.broadcastToWebUI('oz:identities:changed')
          h.openInIdentity(ident.id, 'about:blank')
        } catch (err) {
          log.warn('tab-context-menu', 'new tab in temp identity failed', {
            message: err.message,
          })
        }
      },
    },
    ...allIdentities
      .filter((i) => i.isDefault)
      .map((def) => ({
        label: `Default (${def.name})`,
        click: () => h.openInIdentity(def.id, 'about:blank'),
      })),
    {
      label: 'New Identity…',
      click: () => {
        try {
          const ident = im.create({ name: 'New Identity' })
          browser.broadcastToWebUI('oz:identities:changed')
          h.openInIdentity(ident.id, 'about:blank')
        } catch (err) {
          log.warn('tab-context-menu', 'new identity for new tab failed', {
            message: err.message,
          })
        }
      },
    },
  ]
  if (otherIdentities.length > 0) {
    newTabSubmenu.push({ type: 'separator' })
    newTabSubmenu.push({
      label: 'In Identity…',
      submenu: otherIdentities.map((i) => ({
        label: i.name,
        click: () => h.openInIdentity(i.id, 'about:blank'),
      })),
    })
  }

  // ---------- "Duplicate into Identity…" submenu ------------------------
  const dupIntoIdentitySubmenu =
    otherIdentities.length > 0
      ? otherIdentities.map((i) => ({
          label: i.name,
          click: () => h.duplicateInIdentity(tabId, i.id),
        }))
      : [{ label: '(no other identities)', enabled: false }]

  // ---------- pinned / locked / muted state for toggles ------------------
  const isPinned = !!targetTab.pinned
  const isLocked = !!targetTab.locked
  const isMuted =
    targetTab.materialized &&
    targetTab.webContents &&
    typeof targetTab.webContents.isAudioMuted === 'function' &&
    targetTab.webContents.isAudioMuted()

  // ---------- "Move to Workspace…" submenu (carryover from 1.4d) -------
  const wsAll = browser.workspaceManager ? browser.workspaceManager.list() : []
  const currentWsId = targetWin ? targetWin.workspaceId : null
  const movableWorkspaces = wsAll.filter((w) => w.id !== currentWsId && !w.isArchived)
  const moveWsSubmenu =
    movableWorkspaces.length > 0
      ? movableWorkspaces.map((w) => ({
          label: `${w.isFrozen ? '🔒 ' : ''}${w.name}`,
          click: () => h.moveToWorkspace(tabId, w.id),
        }))
      : [{ label: '(no other workspaces)', enabled: false }]

  // ---------- main template ---------------------------------------------
  const template = [
    { label: 'Create a New Tab', submenu: newTabSubmenu },
    { type: 'separator' },
    {
      // H2: locked tabs reject move. Disable the submenu so the user knows
      // why instead of clicking and silently failing.
      label: isLocked ? 'Move to Workspace… (locked)' : 'Move to Workspace…',
      enabled: !isLocked,
      submenu: moveWsSubmenu,
    },
    {
      label: isLocked ? 'Move Tab to New Window (locked)' : 'Move Tab to New Window',
      enabled: !isLocked,
      click: () => h.moveToNewWindow(tabId),
    },
    { type: 'separator' },
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => h.reload(tabId) },
    { label: 'Duplicate', accelerator: 'Alt+D', click: () => h.duplicate(tabId) },
    {
      label: 'Duplicate (New Temporary Identity)',
      click: () => h.duplicateInTemporary(tabId),
    },
    {
      label: 'Duplicate (New Identity)',
      click: () => h.duplicateInNewIdentity(tabId),
    },
    {
      label: 'Duplicate into Identity…',
      submenu: dupIntoIdentitySubmenu,
    },
    { type: 'separator' },
    {
      label: `Refresh All in this Identity (${tabIdentityName})`,
      click: () => h.refreshAllInIdentity(targetTab.identityId),
    },
    // 1.7b: Clear Browsing Data submenu — Cookies / Storage / Both.
    // H2: locked identities reject clearBrowsingData. Disable the whole
    // submenu so the user knows why instead of all 3 options silently
    // failing.
    {
      label:
        tabIdentity && tabIdentity.locked
          ? `Clear This Identity Browsing Data… (${tabIdentityName} — locked)`
          : `Clear This Identity Browsing Data… (${tabIdentityName})`,
      enabled: !!identitiesH && !(tabIdentity && tabIdentity.locked),
      submenu: [
        {
          label: 'Cookies only',
          click: () =>
            identitiesH && identitiesH.clearBrowsingData(targetTab.identityId, 'cookies'),
        },
        {
          label: 'LocalStorage / IndexedDB / Cache (no cookies)',
          click: () =>
            identitiesH && identitiesH.clearBrowsingData(targetTab.identityId, 'storage'),
        },
        {
          label: 'Everything (cookies + storage + cache)',
          click: () =>
            identitiesH && identitiesH.clearBrowsingData(targetTab.identityId, 'both'),
        },
      ],
    },
    // 1.7c: Export Cookies submenu (4 formats). Each click opens a native
    // save dialog via cookies-handlers.pickExportPath then writes the file.
    {
      label: `Export Cookies (${tabIdentityName})`,
      enabled: !!cookiesH,
      submenu: cookiesH
        ? buildCookieFormatSubmenu({
            tabIdentity: targetTab.identityId,
            cookiesH,
            mode: 'export',
            browser,
          })
        : [{ label: '(no handlers)', enabled: false }],
    },
    {
      label: `Import Cookies (${tabIdentityName})`,
      enabled: !!cookiesH,
      submenu: cookiesH
        ? buildCookieFormatSubmenu({
            tabIdentity: targetTab.identityId,
            cookiesH,
            mode: 'import',
            browser,
          })
        : [{ label: '(no handlers)', enabled: false }],
    },
    { type: 'separator' },
    {
      label: isPinned ? 'Unpin Tab' : 'Pin Tab',
      accelerator: 'Alt+P',
      click: () => (isPinned ? h.unpin(tabId) : h.pin(tabId)),
    },
    {
      // H2: Lock blocks close + move. Pin keeps a tab visible across new tabs;
      // Lock prevents accidental destruction. Two distinct concepts.
      label: isLocked ? 'Unlock Tab' : 'Lock Tab',
      click: () => (isLocked ? h.unlock(tabId) : h.lock(tabId)),
    },
    {
      label: isMuted ? 'Unmute Site' : 'Mute Site',
      enabled: targetTab.materialized,
      click: () => (isMuted ? h.unmute(tabId) : h.mute(tabId)),
    },
    // 1.7b: Bookmark this Tab — addFromTab dedups (identityId,url).
    {
      label: 'Bookmark this Tab',
      enabled: !!bookmarksH,
      click: () => bookmarksH && bookmarksH.addFromTab(tabId),
    },
    { type: 'separator' },
    {
      label: isLocked ? 'Close Tab (locked)' : 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      enabled: !isLocked,
      click: () => h.close(tabId),
    },
    { label: 'Close Other Tabs', click: () => h.closeOthers(tabId) },
    { label: 'Close Tabs to the Right', click: () => h.closeToRight(tabId) },
  ]
  return template
}

/**
 * Build the 4-format submenu for Export/Import Cookies. Each item triggers a
 * native file dialog via the IPC pickExportPath/pickImportPath wrappers (those
 * handlers live in ipc-handlers.js and the cookies handler doesn't see them
 * directly — we round-trip through ipcMain.invoke from main itself by reaching
 * into electron.ipcMain).
 *
 * Important: because we're in main process, we cannot ipcRenderer.invoke()
 * ourselves. Instead, we inline the dialog calls directly using electron.dialog
 * and the focused window. This keeps the menu click handler self-contained.
 */
function buildCookieFormatSubmenu({ tabIdentity, cookiesH, mode, browser }) {
  const { dialog, BrowserWindow } = require('electron')
  const formats = [
    { id: 'oz', label: 'OZ Browser JSON (.json)', ext: 'json' },
    { id: 'netscape', label: 'Netscape cookies.txt (.txt)', ext: 'txt' },
    { id: 'adspower', label: 'AdsPower JSON (.json)', ext: 'json' },
    { id: 'multilogin', label: 'Multilogin JSON (.json)', ext: 'json' },
  ]
  return formats.map((f) => ({
    label: f.label,
    click: async () => {
      const focused = BrowserWindow.getFocusedWindow() || null
      try {
        if (mode === 'export') {
          const stamp = new Date().toISOString().slice(0, 10)
          const ident =
            browser.identityManager && browser.identityManager.get(tabIdentity)
          const safeName = ((ident && ident.name) || tabIdentity)
            .replace(/[^a-z0-9-_]+/gi, '-')
            .toLowerCase()
          const r = await dialog.showSaveDialog(focused, {
            title: `Export cookies (${f.label})`,
            defaultPath: `oz-cookies-${safeName}-${f.id}-${stamp}.${f.ext}`,
            filters: [{ name: f.label, extensions: [f.ext] }],
          })
          if (r.canceled || !r.filePath) return
          const out = await cookiesH.exportToFile(tabIdentity, f.id, r.filePath)
          if (out && out.ok) {
            log.info('tab-context-menu', 'export ok', {
              identityId: tabIdentity,
              format: f.id,
              filePath: r.filePath,
              cookieCount: out.cookieCount,
            })
          } else {
            log.warn('tab-context-menu', 'export failed', {
              identityId: tabIdentity,
              format: f.id,
              reason: out && out.reason,
            })
          }
        } else {
          // mode === 'import'
          const r = await dialog.showOpenDialog(focused, {
            title: `Import cookies (${f.label})`,
            filters: [
              { name: f.label, extensions: [f.ext] },
              { name: 'All files', extensions: ['*'] },
            ],
            properties: ['openFile'],
          })
          if (r.canceled || !r.filePaths || !r.filePaths[0]) return
          const out = await cookiesH.importFromFile(tabIdentity, f.id, r.filePaths[0])
          if (out && out.ok) {
            log.info('tab-context-menu', 'import ok', {
              identityId: tabIdentity,
              format: f.id,
              filePath: r.filePaths[0],
              parsedCount: out.parsedCount,
              written: out.written,
              errorCount: (out.errors || []).length,
            })
          } else {
            log.warn('tab-context-menu', 'import failed', {
              identityId: tabIdentity,
              format: f.id,
              reason: out && out.reason,
            })
          }
        }
      } catch (err) {
        log.error('tab-context-menu', 'cookies submenu click failed', {
          mode,
          format: f.id,
          message: err.message,
        })
      }
    },
  }))
}

module.exports = { buildTabContextMenu }
