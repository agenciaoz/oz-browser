// OZ Browser — Workspace switch logic + lock exclusivo (1.4b).
//
// Qué hace: implementa el switch atómico de workspace en una ventana, con lock
// exclusivo (1 ventana = 1 WS, 1 WS = max 1 ventana). Lógica extraída en módulo
// puro para testearla sin Electron real (recibe `tabs` como dependency).
//
// Doc: docs/modules/window-workspace.md
// ADR: docs/architecture/0015-workspace-model.md
//
// Exports:
//   - switchWorkspace({ window, browser, targetWorkspaceId, options? })
//       → { ok, ...details }
//   - hydrateWorkspace({ window, browser })
//       → recrea tabs lazy desde tabSpecs del workspace activo. Idempotente.
//
// El método correspondiente en TabbedBrowserWindow (window-manager.js) llama
// directo a estas funciones, manteniendo window-manager.js compacto.

const log = require('./logger')

/**
 * Encuentra qué ventana tiene un workspaceId activo. Devuelve el TabbedBrowserWindow
 * o null si nadie lo tiene. Usado para enforce del lock exclusivo.
 */
function findWindowOwning(browser, workspaceId) {
  for (const w of browser.windows || []) {
    if (w !== undefined && w.workspaceId === workspaceId) return w
  }
  return null
}

/**
 * Cambiar el workspace activo de `window` al `targetWorkspaceId`.
 *
 * Pasos atómicos:
 *  1. Validar workspace existe.
 *  2. Si target === current, no-op (ok).
 *  3. Lock check: si target ya está abierto en otra ventana, rechazar.
 *  4. Snapshot de las tabs vivas del WS actual → tabSpecs (sync save).
 *  5. Destruir todas las tabs vivas de la ventana.
 *  6. Cargar tabSpecs del nuevo WS → crear lazy tabs.
 *  7. Seleccionar la tab activa (activeTabId persistido, o primera, o crear newtab si vacío).
 *  8. Actualizar window.workspaceId.
 *
 * Retorna { ok: true, workspaceId } o { ok: false, reason: '...', ... }.
 */
function switchWorkspace({ window, browser, targetWorkspaceId, options = {} }) {
  const wm = browser.workspaceManager
  if (!wm) {
    return { ok: false, reason: 'no-workspace-manager' }
  }
  const target = wm.get(targetWorkspaceId)
  if (!target) {
    log.warn('window-workspace', 'switch: target workspace not found', {
      targetWorkspaceId,
      windowId: window.id,
    })
    return { ok: false, reason: 'not-found', workspaceId: targetWorkspaceId }
  }

  // No-op si ya estamos ahí.
  if (window.workspaceId === targetWorkspaceId) {
    return { ok: true, workspaceId: targetWorkspaceId, noop: true }
  }

  // Lock exclusivo: nadie más puede tenerlo abierto.
  const owner = findWindowOwning(browser, targetWorkspaceId)
  if (owner && owner !== window) {
    log.warn('window-workspace', 'switch: workspace already open in another window', {
      targetWorkspaceId,
      ownerWindowId: owner.id,
      requesterWindowId: window.id,
    })
    return {
      ok: false,
      reason: 'already-open',
      workspaceId: targetWorkspaceId,
      ownerWindowId: owner.id,
    }
  }

  const fromWorkspaceId = window.workspaceId

  // 1) Snapshot de las tabs actuales (si hay).
  if (fromWorkspaceId) {
    snapshotWindowToWorkspace(window, browser, fromWorkspaceId)
  }

  // 2) Destruir todas las tabs vivas. La SQLite per-identity en disk preserva
  //    cookies/storage — solo se pierde el state in-memory de la página.
  const previousTabs = window.tabs.tabList.slice()
  for (const t of previousTabs) {
    if (typeof window.tabs.remove === 'function') {
      window.tabs.remove(t.id)
    }
  }

  // 3) Asignar el workspaceId nuevo ANTES de hidratar — así findWindowOwning
  //    lo encuentra correctamente para futuros locks.
  window.workspaceId = targetWorkspaceId

  // 4) Hidratar lazy tabs del workspace nuevo.
  hydrateWorkspace({ window, browser, options })

  log.info('window-workspace', 'switch ok', {
    windowId: window.id,
    from: fromWorkspaceId,
    to: targetWorkspaceId,
    tabsRecreated: window.tabs.tabList.length,
  })

  return { ok: true, workspaceId: targetWorkspaceId, from: fromWorkspaceId }
}

/**
 * Snapshot del runtime al disco. Llamado desde switchWorkspace antes de destruir
 * tabs, y desde TabbedBrowserWindow.destroy() antes de cerrar la ventana.
 *
 * No destruye tabs — es solo el write a workspaceManager.
 */
function snapshotWindowToWorkspace(window, browser, workspaceId) {
  const wm = browser.workspaceManager
  if (!wm) return false
  if (!window.tabs) return false

  const ws = wm.get(workspaceId)
  if (!ws) {
    log.warn('window-workspace', 'snapshot: workspace not found', {
      workspaceId,
      windowId: window.id,
    })
    return false
  }

  const specs = window.tabs.toSpecs ? window.tabs.toSpecs() : []
  const activeTabId = window.tabs.selected ? window.tabs.selected.id : null
  wm.setTabSpecs(workspaceId, specs, activeTabId)
  // Para la snapshot path queremos persistencia inmediata (no esperar al
  // throttle) — un crash entre snapshot y destroy no debe perder tabs.
  if (typeof wm.flush === 'function') wm.flush()
  log.debug('window-workspace', 'snapshot saved', {
    workspaceId,
    windowId: window.id,
    tabsSnapshotted: specs.length,
    activeTabId,
  })
  return true
}

/**
 * Cargar las tabs del workspace activo de la ventana, creando instancias lazy
 * (no materializadas). Selecciona activeTabId o la primera. Si tabSpecs está
 * vacío, crea una newtab fresh (caso first-run o WS recién creado).
 *
 * Idempotente: no asume que window.tabs esté vacío (caller puede haber dejado
 * basura), pero el caso normal es justo después de destruir todas las tabs.
 */
function hydrateWorkspace({ window, browser, options = {} }) {
  const wm = browser.workspaceManager
  if (!wm || !window.workspaceId) return
  const ws = wm.get(window.workspaceId)
  if (!ws) return

  const specs = ws.tabSpecs || []
  const newtabUrl =
    (browser.urls && browser.urls.newtab) || options.newtabUrl || 'about:blank'

  if (specs.length === 0) {
    // First arrival al WS — crear una newtab.
    const tab = window.tabs.create({
      url: newtabUrl,
      materialize: true,
      source: 'window-workspace.hydrate.newtab',
    })
    if (typeof window.tabs.select === 'function') {
      window.tabs.select(tab.id)
    }
    return
  }

  // Recrear cada tabSpec como Tab lazy.
  for (const spec of specs) {
    window.tabs.create({
      id: spec.id,
      identityId: spec.identityId,
      url: spec.url || newtabUrl,
      title: spec.title,
      favicon: spec.favicon,
      pinned: spec.pinned,
      source: 'window-workspace.hydrate',
    })
  }

  // Seleccionar la tab activa persistida (materializa al hacer select), o la
  // primera si activeTabId quedó stale.
  const targetId =
    ws.activeTabId && window.tabs.get(ws.activeTabId)
      ? ws.activeTabId
      : window.tabs.tabList[0] && window.tabs.tabList[0].id
  if (targetId && typeof window.tabs.select === 'function') {
    window.tabs.select(targetId)
  }
}

/**
 * Liberar el lock cuando una ventana se destruye. Snapshot final + clear
 * de workspaceId. Llamar desde TabbedBrowserWindow.destroy() ANTES de cerrar
 * la BrowserWindow, para que el snapshot capture el estado vivo.
 */
function releaseOnDestroy(window, browser) {
  if (!window.workspaceId) return
  snapshotWindowToWorkspace(window, browser, window.workspaceId)
  log.info('window-workspace', 'released workspace lock on destroy', {
    windowId: window.id,
    workspaceId: window.workspaceId,
  })
  window.workspaceId = null
}

module.exports = {
  switchWorkspace,
  hydrateWorkspace,
  snapshotWindowToWorkspace,
  releaseOnDestroy,
  findWindowOwning,
}
