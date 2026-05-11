// OZ Browser — Identity domain handlers (pure map of name → fn).
//
// Qué hace: factoriza la lógica de los IPC handlers de Identity en un mapa que
// pueden consumir DOS layers: ipcMain (via ipc-handlers.js) y MCP (via
// mcp-server.js). Misma implementación, dos transports.
//
// Doc: docs/modules/identity-handlers.md
// ADR: docs/architecture/0012-oz-mcp-server.md (la justificación del refactor)
//
// Exports: buildIdentityHandlers(browser) -> Record<string, (args) => any>
// IPC: ninguno directo (los registra ipc-handlers.js).
//
// Convención:
//   - Cada handler recibe argumentos posicionales (mismo orden que el IPC original).
//   - Cada handler retorna lo que el IPC devolvía.
//   - Los efectos secundarios (broadcastToWebUI, etc.) viven dentro del handler.
//   - El nombre del handler en el mapa es el nombre canónico del tool MCP
//     (sin prefijo `oz.identities.` — eso lo agrega mcp-tools.js).

const log = require('./logger')
const { cloneIdentity, resolveCopyName } = require('./identity-clone')

function buildIdentityHandlers(browser) {
  const im = () => browser.identityManager

  return {
    list() {
      return im().list()
    },

    get(id) {
      return im().get(id)
    },

    getActive() {
      return browser.activeIdentityId
    },

    setActive(id) {
      const ident = im().get(id)
      if (!ident) return false
      browser.activeIdentityId = id
      browser.broadcastToWebUI('oz:identities:active-changed', id)
      log.info('identity-handlers', 'setActive', { id })
      return true
    },

    create(opts) {
      try {
        // H3a: every identity belongs to exactly one workspace. Default is
        // the focused window's workspaceId — matches the user's mental
        // model ("create a new identity here, in the workspace I'm in").
        // The caller (UI) can override by passing opts.workspaceId
        // explicitly. Falls back to 'general' if no focused window.
        const passedWs = opts && opts.workspaceId
        let resolvedWs = passedWs
        if (!resolvedWs) {
          const focused = browser.getFocusedWindow ? browser.getFocusedWindow() : null
          resolvedWs = (focused && focused.workspaceId) || 'general'
        }
        const ident = im().create({ ...(opts || {}), workspaceId: resolvedWs })
        // 1.5d: hook anti-logout cookie listener for the new identity session.
        if (
          browser.antiLogout &&
          typeof browser.antiLogout.installForIdentity === 'function'
        ) {
          try {
            browser.antiLogout.installForIdentity(ident.id)
          } catch (_e) {
            // best-effort
          }
        }
        browser.broadcastToWebUI('oz:identities:changed')
        // H3a: workspace list is also affected — its identityIds[] changed.
        browser.broadcastToWebUI('oz:workspaces:changed')
        log.info('identity-handlers', 'create ok', {
          id: ident.id,
          name: ident.name,
          workspaceId: ident.workspaceId,
        })
        return ident
      } catch (err) {
        if (err && err.code === 'IDENTITY_CAP_REACHED') {
          log.warn('identity-handlers', 'create blocked by cap', {
            current: err.current,
            max: err.max,
          })
          return {
            __error: {
              code: err.code,
              message: err.message,
              current: err.current,
              max: err.max,
            },
          }
        }
        throw err
      }
    },

    /**
     * H3a — list identities scoped to a workspace.
     */
    listByWorkspace(workspaceId) {
      return im().listByWorkspace(workspaceId)
    },

    /**
     * H3a — move identity to another workspace. Default identity rejects
     * (pinned to 'general'), locked identities reject. Returns
     * { ok, id, from, to } or { ok: false, reason }.
     */
    moveToWorkspace(id, targetWorkspaceId) {
      const result = im().moveToWorkspace(id, targetWorkspaceId)
      if (result && result.ok) {
        browser.broadcastToWebUI('oz:identities:changed')
        browser.broadcastToWebUI('oz:workspaces:changed')
      }
      return result
    },

    rename(id, name) {
      const ident = im().rename(id, name)
      if (ident) browser.broadcastToWebUI('oz:identities:changed')
      return ident
    },

    setColor(id, color) {
      const ident = im().setColor(id, color)
      if (ident) browser.broadcastToWebUI('oz:identities:changed')
      return ident
    },

    update(id, patch) {
      const ident = im().update(id, patch || {})
      if (ident) browser.broadcastToWebUI('oz:identities:changed')
      return ident
    },

    remove(id) {
      // H2: pre-check the lock so we don't reset activeIdentityId to Default
      // when the remove is going to be rejected anyway.
      const ident = im().get(id)
      if (ident && ident.locked) {
        log.warn('identity-handlers', 'remove blocked: identity is locked', {
          id,
          name: ident.name,
        })
        return false
      }
      if (browser.activeIdentityId === id) {
        browser.activeIdentityId = im().getDefault().id
        browser.broadcastToWebUI('oz:identities:active-changed', browser.activeIdentityId)
      }
      const ok = im().remove(id)
      if (ok) browser.broadcastToWebUI('oz:identities:changed')
      log.info('identity-handlers', 'remove', { id, ok })
      return ok
    },

    /**
     * H2: toggle Identity.locked. Locked identities reject remove +
     * clearBrowsingData but still accept rename, color and UA edits — Jose
     * confirmed scope ("sólo destructivo") on the H2 kickoff.
     */
    setLocked(id, locked) {
      const ident = im().setLocked(id, !!locked)
      if (!ident) return null
      browser.broadcastToWebUI('oz:identities:changed')
      log.info('identity-handlers', 'setLocked', { id, locked: !!locked })
      return ident
    },

    /**
     * 1.7b — Clear browsing data for a single identity.
     *
     * @param {string} identityId
     * @param {string} scope - 'cookies' | 'storage' | 'both' (default 'both')
     *   - 'cookies' wipes cookie jar only.
     *   - 'storage' wipes localStorage + IndexedDB + WebSQL + ServiceWorkers
     *     + cache (everything except cookies).
     *   - 'both' wipes all of the above.
     *
     * Note: this does NOT touch the on-disk Partition directory itself —
     * Electron rewrites the SQLite/leveldb files on next session use. The
     * Identity row, accounts, bookmarks, and config are all preserved.
     *
     * Live tabs of this identity are not destroyed; a `Refresh All in this
     * Identity` after the clear gives the user a clean slate.
     *
     * Returns { ok: true, identityId, scope, clearedStorages } or
     * { ok: false, reason }.
     */
    async clearBrowsingData(identityId, scope = 'both') {
      const ident = im().get(identityId)
      if (!ident) {
        log.warn('identity-handlers', 'clearBrowsingData: identity not found', {
          identityId,
        })
        return { ok: false, reason: 'identity-not-found', identityId }
      }
      // H2: locked identities reject destructive cleanup. The user must unlock
      // first. Pairs with remove() which rejects the same way.
      if (ident.locked) {
        log.warn('identity-handlers', 'clearBrowsingData blocked: identity is locked', {
          identityId,
          name: ident.name,
        })
        return { ok: false, reason: 'identity-locked', identityId }
      }
      const validScopes = ['cookies', 'storage', 'both']
      if (!validScopes.includes(scope)) {
        return { ok: false, reason: 'invalid-scope', scope }
      }

      const ses = im().getSession(identityId)
      const storagesByScope = {
        cookies: ['cookies'],
        storage: [
          'appcache',
          'filesystem',
          'indexdb',
          'localstorage',
          'shadercache',
          'websql',
          'serviceworkers',
          'cachestorage',
        ],
        both: [
          'appcache',
          'cookies',
          'filesystem',
          'indexdb',
          'localstorage',
          'shadercache',
          'websql',
          'serviceworkers',
          'cachestorage',
        ],
      }
      const storages = storagesByScope[scope]

      try {
        await ses.clearStorageData({ storages })
        // Also flush the HTTP cache when scope wipes storage (storage|both).
        if (scope !== 'cookies' && typeof ses.clearCache === 'function') {
          await ses.clearCache()
        }
      } catch (err) {
        log.error('identity-handlers', 'clearStorageData failed', {
          identityId,
          scope,
          message: err.message,
        })
        return { ok: false, reason: 'clear-failed', message: err.message }
      }
      log.info('identity-handlers', 'clearBrowsingData ok', {
        identityId,
        scope,
        storages,
      })
      return { ok: true, identityId, scope, clearedStorages: storages }
    },

    /**
     * C-3 — clone an identity, optionally inheriting fingerprint / proxy / UA.
     * Returns {ok:true, identity, inherited} or {ok:false, reason, ...}.
     *
     * opts shape:
     *   - srcId: string (required)
     *   - name?: string (auto-generated "X (copy)" if missing)
     *   - sameFingerprint?: boolean (default false — fresh seed per safety)
     *   - sameProxy?: boolean (default true if proxy assigned — same cluster)
     *   - sameUA?: boolean (default false)
     */
    clone(srcId, opts = {}) {
      const result = cloneIdentity({
        srcId,
        opts,
        identityManager: im(),
        proxyAssignment: browser.proxyAssignment,
      })
      if (result && result.ok) {
        // 1.5d: hook anti-logout for the new identity session (parity with
        // create() path above — clone goes through the same lifecycle).
        if (
          browser.antiLogout &&
          typeof browser.antiLogout.installForIdentity === 'function'
        ) {
          try {
            browser.antiLogout.installForIdentity(result.identity.id)
          } catch (_e) {
            // best-effort
          }
        }
        browser.broadcastToWebUI('oz:identities:changed')
        browser.broadcastToWebUI('oz:workspaces:changed')
        log.info('identity-handlers', 'clone ok', {
          srcId,
          newId: result.identity.id,
          name: result.identity.name,
          inherited: result.inherited,
        })
      } else {
        log.warn('identity-handlers', 'clone rejected', {
          srcId,
          reason: result && result.reason,
        })
      }
      return result
    },

    /**
     * C-3 — preview the auto-generated "X (copy N)" name without actually
     * cloning. Used by the UI to populate the default name input field.
     */
    previewCloneName(srcName) {
      return resolveCopyName(srcName, im().list())
    },
  }
}

module.exports = { buildIdentityHandlers }
