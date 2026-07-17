// OZ Browser — Workspace domain handlers (pure map of name → fn).
//
// Qué hace: factoriza la lógica de los IPC handlers de Workspace en un mapa
// que pueden consumir DOS layers: ipcMain (via ipc-handlers.js) y MCP (via
// mcp-server.js). Misma implementación, dos transports.
//
// Doc: docs/modules/workspace-handlers.md
// ADR: docs/architecture/0015-workspace-model.md
//
// Exports: buildWorkspaceHandlers(browser) -> Record<string, (args) => any>
// IPC: ninguno directo (los registra ipc-handlers.js).
//
// Convención (idéntica a identity-handlers.js):
//   - Cada handler recibe argumentos posicionales.
//   - Cada handler retorna lo que el IPC devolvía.
//   - Los efectos secundarios (broadcastToWebUI, etc.) viven dentro del handler.
//   - El nombre del handler en el mapa es el nombre canónico del tool MCP
//     (sin prefijo `oz.workspaces.` — eso lo agrega mcp-tools.js en 1.4e).

const log = require('./logger')

function buildWorkspaceHandlers(browser) {
  const wm = () => browser.workspaceManager

  // alpha.109 (idea Jose): precalentar los proxies del workspace al activarlo.
  // Best-effort, gated por settings.performance.warmProxiesOnWorkspace.
  const warmWorkspace = (workspaceId) => {
    try {
      const sm = browser.settingsManager
      const perf = sm && typeof sm.get === 'function' ? sm.get('performance') : null
      if (perf && perf.warmProxiesOnWorkspace === false) return
      require('./proxy-warmup').runWarmup(browser, workspaceId, { log })
    } catch (_e) {
      /* best-effort */
    }
  }

  return {
    list() {
      return wm().list()
    },

    listActive() {
      return wm().listActive()
    },

    get(id) {
      return wm().get(id)
    },

    /**
     * Returns the workspace id currently active in the focused window
     * (or in the window referenced by `windowId` when provided).
     * Multi-window: each window has its own activeWorkspaceId. Set by 1.4b.
     */
    getActive(windowId) {
      const win = windowId
        ? browser.windows.find((w) => w.id === windowId)
        : browser.getFocusedWindow()
      if (!win) return null
      return win.workspaceId || null
    },

    /**
     * Switch the focused window (or referenced window) to the given workspace.
     * Implementation arrives in 1.4b — for now this is a stub that records intent.
     */
    setActive(workspaceId, windowId) {
      const win = windowId
        ? browser.windows.find((w) => w.id === windowId)
        : browser.getFocusedWindow()
      if (!win) {
        log.warn('workspace-handlers', 'setActive: no target window')
        return { ok: false, reason: 'no-window' }
      }
      const ws = wm().get(workspaceId)
      if (!ws) {
        log.warn('workspace-handlers', 'setActive: workspace not found', {
          workspaceId,
        })
        return { ok: false, reason: 'not-found' }
      }
      // Lock check happens in 1.4b's TabbedBrowserWindow.switchToWorkspace.
      if (typeof win.switchToWorkspace === 'function') {
        const result = win.switchToWorkspace(workspaceId)
        if (result && result.ok === false) return result
        browser.broadcastToWebUI('oz:workspaces:active-changed', {
          windowId: win.id,
          workspaceId,
        })
        warmWorkspace(workspaceId)
        log.info('workspace-handlers', 'setActive ok', {
          windowId: win.id,
          workspaceId,
        })
        return { ok: true, workspaceId }
      }
      // Fallback path while 1.4b is in flight: just record the id.
      win.workspaceId = workspaceId
      browser.broadcastToWebUI('oz:workspaces:active-changed', {
        windowId: win.id,
        workspaceId,
      })
      log.info('workspace-handlers', 'setActive (stub) ok', {
        windowId: win.id,
        workspaceId,
      })
      return { ok: true, workspaceId, stub: true }
    },

    create(opts) {
      const ws = wm().create(opts || {})
      browser.broadcastToWebUI('oz:workspaces:changed')
      log.info('workspace-handlers', 'create ok', { id: ws.id, name: ws.name })
      return ws
    },

    update(id, patch) {
      const ws = wm().update(id, patch || {})
      if (ws) browser.broadcastToWebUI('oz:workspaces:changed')
      return ws
    },

    rename(id, name) {
      const ws = wm().rename(id, name)
      if (ws) browser.broadcastToWebUI('oz:workspaces:changed')
      return ws
    },

    setColor(id, color) {
      const ws = wm().setColor(id, color)
      if (ws) browser.broadcastToWebUI('oz:workspaces:changed')
      return ws
    },

    duplicate(id) {
      const ws = wm().duplicate(id)
      if (ws) browser.broadcastToWebUI('oz:workspaces:changed')
      log.info('workspace-handlers', 'duplicate ok', {
        from: id,
        to: ws && ws.id,
      })
      return ws
    },

    archive(id) {
      const ok = wm().archive(id)
      if (ok) browser.broadcastToWebUI('oz:workspaces:changed')
      return ok
    },

    restore(id) {
      const ok = wm().restore(id)
      if (ok) browser.broadcastToWebUI('oz:workspaces:changed')
      return ok
    },

    freeze(id) {
      const ok = wm().freeze(id)
      if (ok) browser.broadcastToWebUI('oz:workspaces:changed')
      return ok
    },

    unfreeze(id) {
      const ok = wm().unfreeze(id)
      if (ok) browser.broadcastToWebUI('oz:workspaces:changed')
      return ok
    },

    /**
     * Remove a workspace. With H3a (D7) the underlying manager rejects when
     * the workspace has identities unless `options.cascade=true` — in which
     * case identities cascade-move to 'general' (locked identities still
     * block the operation entirely).
     *
     * Returns `true` (legacy boolean) when removed cleanly, `false` for
     * legacy reject paths (Default workspace), or a structured object
     * `{ ok: false, reason, ... }` for D7 reject paths.
     */
    remove(id, options) {
      // If the workspace being removed is active in any window, fall back to Default.
      const defaultId = wm().getDefault().id
      for (const win of browser.windows) {
        if (win.workspaceId === id) {
          if (typeof win.switchToWorkspace === 'function') {
            win.switchToWorkspace(defaultId)
          } else {
            win.workspaceId = defaultId
          }
          browser.broadcastToWebUI('oz:workspaces:active-changed', {
            windowId: win.id,
            workspaceId: defaultId,
          })
        }
      }
      const result = wm().remove(id, options || {})
      if (result === true) {
        browser.broadcastToWebUI('oz:workspaces:changed')
        // H3a: cascade-move may have re-homed identities → notify too.
        if (options && options.cascade) {
          browser.broadcastToWebUI('oz:identities:changed')
        }
      }
      log.info('workspace-handlers', 'remove', {
        id,
        result: typeof result === 'object' ? result : { ok: result },
      })
      return result
    },
  }
}

module.exports = { buildWorkspaceHandlers }
