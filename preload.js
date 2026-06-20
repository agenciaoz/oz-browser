// OZ Browser preload — runs in every WebContents.
// Exposes window.oz to OZ's own chrome-extension pages (webui.html + the
// dashboards that need to call into the browser internals).
//
// v1.6.5 fix: previously the guard only allowed webui.html. proxy-dashboard.html
// is a separate chrome-extension page that NEEDS window.oz to call
// oz.proxyHealth.getDashboard()/getGlobalStatus()/etc. — without it, the
// dashboard showed "Status unavailable" forever and the bulk-assign modal
// stayed empty ("(0) proxies, (0) identities"). Latent since H-2b (dashboard
// introduction). Safe to expand: the path check still pins us to OZ's own
// chrome-extension ID + a known pathname list, so third-party extensions
// can't get access.

const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')
const { buildAutoUpdaterApi } = require('./browser/preload-autoupdater-api')
const { buildBulkApi } = require('./browser/preload-bulk-api')
const { buildPublishingApi } = require('./browser/preload-publishing-api')

// OZ-owned chrome-extension pages that need window.oz. webui.html is the
// main browser chrome; proxy-dashboard.html is the H-2b dashboard tab.
const OZ_OWNED_PATHS = new Set(['/webui.html', '/proxy-dashboard.html'])
const isOzPage =
  location.protocol === 'chrome-extension:' && OZ_OWNED_PATHS.has(location.pathname)
// Browser-action dropdown only goes in the main chrome (webui.html), not in
// dashboard tabs — otherwise the dropdown would render inside the dashboard.
const isWebUI = isOzPage && location.pathname === '/webui.html'

if (isWebUI) {
  injectBrowserAction()
}
if (isOzPage) {
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
    // alpha.42 — this renderer's own OZ window id (for scoping the global
    // Default identity's tabs to the current window). Null if undeterminable.
    getWindowId: () => ipcRenderer.invoke('oz:window:getId'),
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
      // H2: lock = blocks remove + clearBrowsingData. Returns the updated identity.
      setLocked: (id, locked) =>
        ipcRenderer.invoke('oz:identities:setLocked', id, locked),
      // H3a: per-workspace identity scoping.
      listByWorkspace: (workspaceId) =>
        ipcRenderer.invoke('oz:identities:listByWorkspace', workspaceId),
      moveToWorkspace: (id, targetWorkspaceId) =>
        ipcRenderer.invoke('oz:identities:moveToWorkspace', id, targetWorkspaceId),
      // HX4: native ctx menu (Menu.popup) — replaces the HTML ctx menu that
      // got occluded by WebContentsView overlays.
      contextMenu: (id, opts) =>
        ipcRenderer.invoke('oz:identities:contextMenu', id, opts),
      // C-3 — clone identity with optional inheritance.
      clone: (srcId, opts) => ipcRenderer.invoke('oz:identities:clone', srcId, opts),
      previewCloneName: (srcName) =>
        ipcRenderer.invoke('oz:identities:previewCloneName', srcName),

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
      // H3a: options.cascade=true moves identities to 'general' before delete
      // (per ADR 0023 D7). Without options, default behavior — reject if ws
      // has identities.
      remove: (id, options) => ipcRenderer.invoke('oz:workspaces:remove', id, options),
      // HX4: native ctx menu (Menu.popup) for workspace right-click in
      // sidebar — HTML menus got occluded by WebContentsViews.
      contextMenu: (id, opts) =>
        ipcRenderer.invoke('oz:workspaces:contextMenu', id, opts),

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
    // HX4: sidebar back-channels — the native ctx menu emits these events
    // when an action requires renderer-side UI (inline rename input, open
    // identity editor modal, alert on rejection).
    sidebar: {
      onRequestRename(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:sidebar:request-rename', listener)
        return () => ipcRenderer.off('oz:sidebar:request-rename', listener)
      },
      onRequestEditIdentity(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:sidebar:request-edit-identity', listener)
        return () => ipcRenderer.off('oz:sidebar:request-edit-identity', listener)
      },
      // C-3 — open Clone Identity modal preset with the requested srcId.
      onRequestCloneIdentity(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:sidebar:request-clone-identity', listener)
        return () => ipcRenderer.off('oz:sidebar:request-clone-identity', listener)
      },
      // C-6 — open Health Check modal preset with the requested identityId.
      onRequestHealthCheck(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:sidebar:request-health-check', listener)
        return () => ipcRenderer.off('oz:sidebar:request-health-check', listener)
      },
      // C-7 — open Extensions per-identity modal preset.
      onRequestManageExt(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:sidebar:request-manage-extensions', listener)
        return () => ipcRenderer.off('oz:sidebar:request-manage-extensions', listener)
      },
      onRemoveRejected(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:sidebar:remove-rejected', listener)
        return () => ipcRenderer.off('oz:sidebar:remove-rejected', listener)
      },
    },
    tabs: {
      list: () => ipcRenderer.invoke('oz:tabs:list'),
      getIdentity: (tabId) => ipcRenderer.invoke('oz:tabs:getIdentity', tabId),
      openInIdentity: (identityId, url) =>
        ipcRenderer.invoke('oz:tabs:openInIdentity', identityId, url),
      select: (tabId) => ipcRenderer.invoke('oz:tabs:select', tabId),
      reorder: (tabId, toIndex) => ipcRenderer.invoke('oz:tabs:reorder', tabId, toIndex),
      close: (tabId) => ipcRenderer.invoke('oz:tabs:close', tabId),
      // H1 — Cmd+Shift+T binding lives in the native menu (browser/menu.js)
      // but we expose this here so the renderer can also trigger it via
      // keyboard shortcut interception or the Edit menu.
      reopenClosed: () => ipcRenderer.invoke('oz:tabs:reopenClosed'),
      bulkCreateLazy: (count, identityId, urlTemplate) =>
        ipcRenderer.invoke('oz:tabs:bulkCreateLazy', count, identityId, urlTemplate),
      moveToWorkspace: (tabId, targetWorkspaceId) =>
        ipcRenderer.invoke('oz:tabs:moveToWorkspace', tabId, targetWorkspaceId),
      // 1.7a: pop the native context menu for a tab (delegates to main, which
      // builds the template via tab-context-menu.js and runs Menu.popup()).
      contextMenu: (tabId, opts) =>
        ipcRenderer.invoke('oz:tabs:contextMenu', tabId, opts),
      // 1.7a: tab actions exposed to renderer (for keyboard shortcuts that
      // can't go through the menu, e.g. Alt+D in tabstrip while focused).
      reload: (tabId) => ipcRenderer.invoke('oz:tabs:reload', tabId),
      duplicate: (tabId) => ipcRenderer.invoke('oz:tabs:duplicate', tabId),
      pin: (tabId) => ipcRenderer.invoke('oz:tabs:pin', tabId),
      unpin: (tabId) => ipcRenderer.invoke('oz:tabs:unpin', tabId),
      // H2: lock/unlock — close + moveToWorkspace + moveToNewWindow reject;
      // closeOthers/closeToRight skip (just like pinned).
      lock: (tabId) => ipcRenderer.invoke('oz:tabs:lock', tabId),
      unlock: (tabId) => ipcRenderer.invoke('oz:tabs:unlock', tabId),
      mute: (tabId) => ipcRenderer.invoke('oz:tabs:mute', tabId),
      unmute: (tabId) => ipcRenderer.invoke('oz:tabs:unmute', tabId),

      onUpdated(cb) {
        const listener = (_e, info) => cb(info)
        ipcRenderer.on('oz:tabs:updated', listener)
        return () => ipcRenderer.off('oz:tabs:updated', listener)
      },
    },
    // alpha.65: multi-row tabstrip — renderer reports its row count to main.
    chrome: { setRows: (rows) => ipcRenderer.invoke('oz:chrome:setRows', rows) },
    vault: {
      status: () => ipcRenderer.invoke('oz:vault:status'),
      unlock: () => ipcRenderer.invoke('oz:vault:unlock'),
      lock: () => ipcRenderer.invoke('oz:vault:lock'),
      destroy: () => ipcRenderer.invoke('oz:vault:destroy'),

      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:vault:changed', listener)
        return () => ipcRenderer.off('oz:vault:changed', listener)
      },
    },
    accounts: {
      list: (filter) => ipcRenderer.invoke('oz:accounts:list', filter),
      get: (id) => ipcRenderer.invoke('oz:accounts:get', id),
      create: (opts) => ipcRenderer.invoke('oz:accounts:create', opts),
      update: (id, patch) => ipcRenderer.invoke('oz:accounts:update', id, patch),
      remove: (id) => ipcRenderer.invoke('oz:accounts:remove', id),
      setAll: (accounts) => ipcRenderer.invoke('oz:accounts:setAll', accounts),
      // 1.5c auto-fill / auto-save primitives
      getCredentialsForSite: (site, identityId) =>
        ipcRenderer.invoke('oz:accounts:getCredentialsForSite', site, identityId),
      proposeAutoSave: (opts) => ipcRenderer.invoke('oz:accounts:proposeAutoSave', opts),

      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:accounts:changed', listener)
        return () => ipcRenderer.off('oz:accounts:changed', listener)
      },
      onProposeAutoSave(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:autofill:propose-save', listener)
        return () => ipcRenderer.off('oz:autofill:propose-save', listener)
      },
    },
    excel: {
      exportToFile: (filePath) => ipcRenderer.invoke('oz:excel:exportToFile', filePath),
      importFromFile: (filePath, mode) =>
        ipcRenderer.invoke('oz:excel:importFromFile', filePath, mode),
      // 1.5f: native file dialogs proxied via main (renderer can't hit dialog API directly)
      pickExportPath: () => ipcRenderer.invoke('oz:excel:pickExportPath'),
      pickImportPath: () => ipcRenderer.invoke('oz:excel:pickImportPath'),
    },
    timemachine: {
      create: (opts) => ipcRenderer.invoke('oz:timemachine:create', opts),
      list: () => ipcRenderer.invoke('oz:timemachine:list'),
      restore: (id) => ipcRenderer.invoke('oz:timemachine:restore', id),
      remove: (id) => ipcRenderer.invoke('oz:timemachine:remove', id),
      applyRetention: (opts) => ipcRenderer.invoke('oz:timemachine:applyRetention', opts),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:timemachine:changed', listener)
        return () => ipcRenderer.off('oz:timemachine:changed', listener)
      },
      onRestoreCompleted(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:timemachine:restore-completed', listener)
        return () => ipcRenderer.off('oz:timemachine:restore-completed', listener)
      },
    },
    bookmarks: {
      list: (filter) => ipcRenderer.invoke('oz:bookmarks:list', filter),
      get: (id) => ipcRenderer.invoke('oz:bookmarks:get', id),
      add: (opts) => ipcRenderer.invoke('oz:bookmarks:add', opts),
      addFromTab: (tabId) => ipcRenderer.invoke('oz:bookmarks:addFromTab', tabId),
      remove: (id) => ipcRenderer.invoke('oz:bookmarks:remove', id),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:bookmarks:changed', listener)
        return () => ipcRenderer.off('oz:bookmarks:changed', listener)
      },
    },
    team: {
      status: () => ipcRenderer.invoke('oz:team:status'),
      createTeam: () => ipcRenderer.invoke('oz:team:createTeam'),
      generateInvite: (opts) => ipcRenderer.invoke('oz:team:generateInvite', opts),
      acceptInvite: (opts) => ipcRenderer.invoke('oz:team:acceptInvite', opts),
      leaveTeam: () => ipcRenderer.invoke('oz:team:leaveTeam'),
      disbandTeam: () => ipcRenderer.invoke('oz:team:disbandTeam'),
      listMembers: () => ipcRenderer.invoke('oz:team:listMembers'),
      removeMember: (memberId) => ipcRenderer.invoke('oz:team:removeMember', memberId),
      wrapKeyForPendingMembers: () =>
        ipcRenderer.invoke('oz:team:wrapKeyForPendingMembers'),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:team:changed', listener)
        return () => ipcRenderer.off('oz:team:changed', listener)
      },
      onJoined(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:team:joined', listener)
        return () => ipcRenderer.off('oz:team:joined', listener)
      },
    },
    cloudBackup: {
      status: () => ipcRenderer.invoke('oz:cloud-backup:status'),
      connect: () => ipcRenderer.invoke('oz:cloud-backup:connect'),
      disconnect: () => ipcRenderer.invoke('oz:cloud-backup:disconnect'),
      setAutoUpload: (enabled) =>
        ipcRenderer.invoke('oz:cloud-backup:setAutoUpload', enabled),
      uploadNow: (snapshotId) =>
        ipcRenderer.invoke('oz:cloud-backup:uploadNow', snapshotId),
      listRemoteSnapshots: (deviceFolder) =>
        ipcRenderer.invoke('oz:cloud-backup:listRemoteSnapshots', deviceFolder),
      listDevices: () => ipcRenderer.invoke('oz:cloud-backup:listDevices'),
      downloadAndRestore: (opts) =>
        ipcRenderer.invoke('oz:cloud-backup:downloadAndRestore', opts),
      deleteRemote: (opts) => ipcRenderer.invoke('oz:cloud-backup:deleteRemote', opts),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:cloud-backup:changed', listener)
        return () => ipcRenderer.off('oz:cloud-backup:changed', listener)
      },
    },
    // D-3c-3c: cross-device sync via Dropbox (encrypted with master key).
    sync: {
      getStatus: () => ipcRenderer.invoke('oz:sync:getStatus'),
      setEnabled: (enabled) => ipcRenderer.invoke('oz:sync:setEnabled', enabled),
      pullNow: () => ipcRenderer.invoke('oz:sync:pullNow'),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:sync:changed', listener)
        return () => ipcRenderer.off('oz:sync:changed', listener)
      },
    },
    // F-3 v1: simple cron-lite scheduled actions (wake-up routines).
    scheduledActions: {
      list: () => ipcRenderer.invoke('oz:scheduled:list'),
      get: (id) => ipcRenderer.invoke('oz:scheduled:get', id),
      create: (input) => ipcRenderer.invoke('oz:scheduled:create', input),
      update: (id, patch) => ipcRenderer.invoke('oz:scheduled:update', id, patch),
      remove: (id) => ipcRenderer.invoke('oz:scheduled:remove', id),
      setEnabled: (id, enabled) =>
        ipcRenderer.invoke('oz:scheduled:setEnabled', id, enabled),
      getStatus: () => ipcRenderer.invoke('oz:scheduled:getStatus'),
      tickNow: () => ipcRenderer.invoke('oz:scheduled:tickNow'),
    },
    // G-3: Ghost Browser migration wizard backend.
    ghostMigration: {
      detect: () => ipcRenderer.invoke('oz:migration:detect'),
      dryRun: (options) => ipcRenderer.invoke('oz:migration:dryRun', options),
      runImport: (options) => ipcRenderer.invoke('oz:migration:runImport', options),
      getState: () => ipcRenderer.invoke('oz:migration:getState'),
      clearState: () => ipcRenderer.invoke('oz:migration:clearState'),
      onDone: (cb) => {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:migration:done', listener)
        return () => ipcRenderer.off('oz:migration:done', listener)
      },
    },
    // cookies.* — 1.7.0+: import* gain a 4th `options` arg pass-through
    // (defaultDomain etc); pre-1.7.0 callers stay compat (3 args → undefined).
    cookies: (() => {
      const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a)
      return {
        exportContent: (id, f) => inv('oz:cookies:exportContent', id, f),
        exportToFile: (id, f, p) => inv('oz:cookies:exportToFile', id, f, p),
        importContent: (id, f, c, o) => inv('oz:cookies:importContent', id, f, c, o),
        importFromFile: (id, f, p, o) => inv('oz:cookies:importFromFile', id, f, p, o),
        pickExportPath: (id, f) => inv('oz:cookies:pickExportPath', id, f),
        pickImportPath: (f) => inv('oz:cookies:pickImportPath', f),
      }
    })(),
    proxies: {
      list: () => ipcRenderer.invoke('oz:proxies:list'),
      listAssignable: () => ipcRenderer.invoke('oz:proxies:listAssignable'),
      get: (id) => ipcRenderer.invoke('oz:proxies:get', id),
      create: (opts) => ipcRenderer.invoke('oz:proxies:create', opts),
      update: (id, patch) => ipcRenderer.invoke('oz:proxies:update', id, patch),
      remove: (id) => ipcRenderer.invoke('oz:proxies:remove', id),
      setActive: (id, isActive) =>
        ipcRenderer.invoke('oz:proxies:setActive', id, isActive),
      autoAssign: (strategy) => ipcRenderer.invoke('oz:proxies:autoAssign', strategy),
      bulkAdd: (items) => ipcRenderer.invoke('oz:proxies:bulkAdd', items),
      // Assignment
      assignToIdentity: (identityId, value) =>
        ipcRenderer.invoke('oz:proxies:assignToIdentity', identityId, value),
      assignToWorkspace: (workspaceId, value) =>
        ipcRenderer.invoke('oz:proxies:assignToWorkspace', workspaceId, value),
      setDefaultStrategy: (strategy) =>
        ipcRenderer.invoke('oz:proxies:setDefaultStrategy', strategy),
      listAssignments: () => ipcRenderer.invoke('oz:proxies:listAssignments'),
      resolveForIdentity: (identityId, workspaceId) =>
        ipcRenderer.invoke('oz:proxies:resolveForIdentity', identityId, workspaceId),
      // Health (1.8c)
      testConnectivity: (proxyId) =>
        ipcRenderer.invoke('oz:proxies:testConnectivity', proxyId),
      testAll: (opts) => ipcRenderer.invoke('oz:proxies:testAll', opts),
      // CSV + Providers (1.8d)
      importCsvContent: (content) =>
        ipcRenderer.invoke('oz:proxies:importCsvContent', content),
      // Resolved on each call below; preload also exposes a `fingerprint`
      // namespace for direct access (1.9e).
      importCsvFromFile: (filePath) =>
        ipcRenderer.invoke('oz:proxies:importCsvFromFile', filePath),
      exportCsvContent: () => ipcRenderer.invoke('oz:proxies:exportCsvContent'),
      exportCsvToFile: (filePath) =>
        ipcRenderer.invoke('oz:proxies:exportCsvToFile', filePath),
      listProviders: () => ipcRenderer.invoke('oz:proxies:listProviders'),
      expandProvider: (providerId, opts) =>
        ipcRenderer.invoke('oz:proxies:expandProvider', providerId, opts),
      pickCsvImportPath: () => ipcRenderer.invoke('oz:proxies:pickCsvImportPath'),
      pickCsvExportPath: () => ipcRenderer.invoke('oz:proxies:pickCsvExportPath'),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:proxies:changed', listener)
        return () => ipcRenderer.off('oz:proxies:changed', listener)
      },
    },
    fingerprint: {
      get: (identityId) => ipcRenderer.invoke('oz:fingerprint:get', identityId),
      regenerate: (identityId, newSeed) =>
        ipcRenderer.invoke('oz:fingerprint:regenerate', identityId, newSeed),
      applyGeoSuggestion: (identityId, suggestion) =>
        ipcRenderer.invoke('oz:fingerprint:applyGeoSuggestion', identityId, suggestion),
      resolveCountry: (countryCode) =>
        ipcRenderer.invoke('oz:fingerprint:resolveCountry', countryCode),
      remove: (identityId) => ipcRenderer.invoke('oz:fingerprint:remove', identityId),
      onChanged(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:fingerprint:changed', listener)
        return () => ipcRenderer.off('oz:fingerprint:changed', listener)
      },
    },
    app: {
      getVersion: () => ipcRenderer.invoke('oz:app:getVersion'),
      getSystemLocale: () => ipcRenderer.invoke('oz:app:getSystemLocale'),
    },
    // v1.1.2: proxy health + actions bindings live in preload-proxy.js
    // (ADR 0005 — preload.js kept under 500 LOC). Spread merges into oz.
    ...require('./preload-proxy').buildProxyBindings(ipcRenderer),
    ...require('./preload-settings').buildSettingsBindings(ipcRenderer),
    ...require('./preload-mcp').buildMcpBindings(ipcRenderer),
    downloads: {
      list: (filter) => ipcRenderer.invoke('oz:downloads:list', filter),
      get: (id) => ipcRenderer.invoke('oz:downloads:get', id),
      remove: (id) => ipcRenderer.invoke('oz:downloads:remove', id),
      clear: (filter) => ipcRenderer.invoke('oz:downloads:clear', filter),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:downloads:changed', listener)
        return () => ipcRenderer.off('oz:downloads:changed', listener)
      },
    },
    history: {
      list: (filter) => ipcRenderer.invoke('oz:history:list', filter),
      remove: (id) => ipcRenderer.invoke('oz:history:remove', id),
      clear: (filter) => ipcRenderer.invoke('oz:history:clear', filter),
      addVisit: (opts) => ipcRenderer.invoke('oz:history:addVisit', opts),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:history:changed', listener)
        return () => ipcRenderer.off('oz:history:changed', listener)
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
    // C-1: Command Palette (Cmd+K). list() returns the full command set built
    // from the focused window's identities/workspaces/tabs + static actions.
    // onOpen(cb) fires when the user hits Cmd+K (main broadcasts the event).
    commands: {
      list: (opts) => ipcRenderer.invoke('oz:commands:list', opts),
      onOpen(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:command-palette:open', listener)
        return () => ipcRenderer.off('oz:command-palette:open', listener)
      },
    },
    // C-4: Bulk multi-account opener. Both mutations return
    // { ok, opened|created, errors, workspaceId, workspaceCreated }.
    // preview* / validate are pure helpers for the UI form.
    bulkOpen: {
      fromExisting: (input) => ipcRenderer.invoke('oz:bulkOpen:fromExisting', input),
      createNew: (input) => ipcRenderer.invoke('oz:bulkOpen:createNew', input),
      previewNames: (input) => ipcRenderer.invoke('oz:bulkOpen:previewNames', input),
      previewUrls: (input) => ipcRenderer.invoke('oz:bulkOpen:previewUrls', input),
      validate: (input) => ipcRenderer.invoke('oz:bulkOpen:validate', input),
      onOpen(cb) {
        // K1-extras (v1.4.0): broadcast can carry a pre-fill payload
        // {mode, workspaceId, identityIds} so context-menu callers (e.g.
        // workspace right-click → "Open all identities") drive the modal
        // straight to the right configuration. Defensive: cb may not
        // expect args; we pass undefined when no payload.
        const listener = (_e, payload) => cb(payload || undefined)
        ipcRenderer.on('oz:bulk-open:open', listener)
        return () => ipcRenderer.off('oz:bulk-open:open', listener)
      },
    },
    // E2-C-7: extension sharing per identity. listInstalled = todas las
    // que están en Default. report(id) = matriz default-installed × enabled-
    // for-this-identity. enable/disable agregan/quitan la extension de la
    // partition de la identity. onChanged emite cuando muta state.
    extensions: {
      listInstalled: () => ipcRenderer.invoke('oz:extensions:listInstalled'),
      listEnabled: (identityId) =>
        ipcRenderer.invoke('oz:extensions:listEnabled', identityId),
      report: (identityId) => ipcRenderer.invoke('oz:extensions:report', identityId),
      enable: (identityId, extensionId) =>
        ipcRenderer.invoke('oz:extensions:enable', identityId, extensionId),
      disable: (identityId, extensionId) =>
        ipcRenderer.invoke('oz:extensions:disable', identityId, extensionId),
      onChanged(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:extensions:changed', listener)
        return () => ipcRenderer.off('oz:extensions:changed', listener)
      },
    },
    // E2-C-6: anti-detect health dashboard. get/list devuelve health
    // records; applyFix dispara las acciones inline (re-roll FP, apply geo,
    // reassign proxy, test proxy, mark cookies relogin). onChanged emite
    // cuando alguna fix muta el state.
    health: {
      get: (identityId) => ipcRenderer.invoke('oz:health:get', identityId),
      list: () => ipcRenderer.invoke('oz:health:list'),
      applyFix: (opts) => ipcRenderer.invoke('oz:health:applyFix', opts),
      onChanged(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:health:changed', listener)
        return () => ipcRenderer.off('oz:health:changed', listener)
      },
    },
    // v2 Etapa 1: Publishing Studio — impl en browser/preload-publishing-api.js.
    publishing: buildPublishingApi(ipcRenderer),
    // H-2j (v1.1.4): WebRTC + DNS leak tests on demand. run() spawns hidden
    // BrowserWindow with identity session to gather ICE candidates + hits
    // ipleak.net via net.request, then judges via leak-tests.js (pure).
    // Results cached in-memory by main; get() / list() return cached.
    leakTest: {
      run: (opts) => ipcRenderer.invoke('oz:leakTest:run', opts),
      get: (identityId) => ipcRenderer.invoke('oz:leakTest:get', identityId),
      list: () => ipcRenderer.invoke('oz:leakTest:list'),
      clear: (identityId) => ipcRenderer.invoke('oz:leakTest:clear', identityId),
      onChanged(cb) {
        const listener = (_e, payload) => cb(payload)
        ipcRenderer.on('oz:leakTest:changed', listener)
        return () => ipcRenderer.off('oz:leakTest:changed', listener)
      },
    },
    // E2-C-5: alert log persisted in main. UI calls list/markRead/clear;
    // main process emits add() (the panel mostly READS, doesn't ADD).
    alerts: {
      list: (opts) => ipcRenderer.invoke('oz:alerts:list', opts),
      add: (opts) => ipcRenderer.invoke('oz:alerts:add', opts),
      markRead: (id) => ipcRenderer.invoke('oz:alerts:markRead', id),
      markAllRead: () => ipcRenderer.invoke('oz:alerts:markAllRead'),
      remove: (id) => ipcRenderer.invoke('oz:alerts:remove', id),
      clear: () => ipcRenderer.invoke('oz:alerts:clear'),
      unreadCount: () => ipcRenderer.invoke('oz:alerts:unreadCount'),
      onChanged(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:alerts:changed', listener)
        return () => ipcRenderer.off('oz:alerts:changed', listener)
      },
      onOpen(cb) {
        const listener = () => cb()
        ipcRenderer.on('oz:notifications:open', listener)
        return () => ipcRenderer.off('oz:notifications:open', listener)
      },
    },
    // I-2 (v1.6.0): auto-updater — impl en browser/preload-autoupdater-api.js.
    autoUpdater: buildAutoUpdaterApi(ipcRenderer),
    // v2 sub-bloque 1: Bulk Runner — impl en browser/preload-bulk-api.js.
    bulk: buildBulkApi(ipcRenderer),
  })
}
