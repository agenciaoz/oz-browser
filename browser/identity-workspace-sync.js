// OZ Browser — Identity ↔ Workspace sync orchestration (H3a).
//
// Qué hace: wirea los hooks que mantienen consistente la invariante
//   workspace.identityIds[] === { i.id : i.workspaceId === workspace.id }
//
// IdentityManager.identity.workspaceId es la fuente de verdad. Los hooks aquí
// hacen que el estado derivado (workspace.identityIds[]) y el flujo de
// cascade-on-workspace-remove (D7) funcionen sin que cada manager conozca al
// otro — loose coupling vía hook callbacks.
//
// Doc: docs/architecture/0023-identity-workspace-hierarchy.md (D1, D2, D7)
//
// Exports:
//   - wireIdentityWorkspaceSync(browser)
//       Instala los 2 hooks (sync + cascade) + corre el reconcile inicial.
//       Llamado desde Browser.init() entre new WorkspaceManager() y
//       AntiLogout.install().
//
// Convención: el helper recibe `browser` y opera sobre browser.identityManager
// + browser.workspaceManager. No mantiene state propio.

const log = require('./logger')

const DEFAULT_WORKSPACE_ID = 'general'

/**
 * Install the identity ↔ workspace sync hooks + run the initial invariant
 * reconcile. Idempotent — safe to call again after replacing managers.
 */
function wireIdentityWorkspaceSync(browser) {
  if (!browser || !browser.identityManager || !browser.workspaceManager) {
    log.warn('identity-workspace-sync', 'wire skipped — managers missing')
    return
  }

  // 1) IdentityManager fires sync events on create / remove / move so we can
  //    update workspace.identityIds[] without writing duplicate logic inside
  //    IdentityManager itself.
  browser.identityManager.setWorkspaceSyncHook((op, identityId, fromWsId, toWsId) => {
    try {
      if (op === 'add' && toWsId) {
        browser.workspaceManager.addIdentity(toWsId, identityId)
      } else if (op === 'remove' && fromWsId) {
        browser.workspaceManager.removeIdentity(fromWsId, identityId)
      } else if (op === 'move') {
        if (fromWsId) browser.workspaceManager.removeIdentity(fromWsId, identityId)
        if (toWsId) browser.workspaceManager.addIdentity(toWsId, identityId)
      }
    } catch (err) {
      log.warn('identity-workspace-sync', 'sync hook error', {
        op,
        identityId,
        fromWsId,
        toWsId,
        message: err.message,
      })
    }
  })

  // 2) WorkspaceManager.remove() with D7 cascade: when a workspace has
  //    identities and the caller passed cascade:true, we move them all to
  //    'general' via IdentityManager. Locked identities block the cascade.
  browser.workspaceManager.setWorkspaceCascadeHooks({
    probe: (_wsId, identityIds) => {
      let lockedCount = 0
      for (const iid of identityIds) {
        const ident = browser.identityManager.get(iid)
        if (ident && ident.locked) lockedCount += 1
      }
      return { lockedCount, movableCount: identityIds.length - lockedCount }
    },
    run: (_wsId, identityIds, destWorkspaceId) => {
      for (const iid of identityIds) {
        const ident = browser.identityManager.get(iid)
        if (!ident) continue
        // Default identity is pinned to general (D2) — should never reach
        // here, but defensive skip just in case.
        if (ident.isDefault) continue
        browser.identityManager.moveToWorkspace(iid, destWorkspaceId)
      }
    },
  })

  // 3) Reconcile invariant once at boot (handles legacy data / drift).
  syncIdentityWorkspaces(browser)
}

/**
 * Reconcile workspace.identityIds[] with IdentityManager state.
 *
 * IdentityManager.identity.workspaceId is the source of truth. Rebuilds each
 * workspace.identityIds[] from scratch + logs any drift. Idempotent — safe
 * to call multiple times.
 *
 * Also defensively re-homes any identity whose workspaceId points at a
 * workspace that no longer exists → routed to 'general' (covers the case
 * where the workspace was deleted while the identity persisted with stale
 * id; mirrors the defensive backfill in IdentityManager._load).
 */
function syncIdentityWorkspaces(browser) {
  const im = browser.identityManager
  const wm = browser.workspaceManager
  if (!im || !wm) return

  const allIdentities = im.list()
  const wsIds = new Set(wm.list().map((w) => w.id))

  // Step 1 — re-home any identity pointing at a missing workspace.
  let rehomed = 0
  for (const ident of allIdentities) {
    if (!wsIds.has(ident.workspaceId)) {
      im.moveToWorkspace(ident.id, DEFAULT_WORKSPACE_ID)
      rehomed += 1
    }
  }

  // Step 2 — rebuild every workspace.identityIds[] from authoritative
  // IdentityManager state. Use the manager's mutation helpers so the
  // persisted file stays in sync.
  let driftFixed = 0
  for (const ws of wm.list()) {
    const expected = im.listByWorkspace(ws.id).map((i) => i.id)
    const actual = ws.identityIds || []
    const expectedSet = new Set(expected)
    const actualSet = new Set(actual)
    const same =
      expected.length === actual.length && expected.every((id) => actualSet.has(id))
    if (!same) {
      for (const id of expected) {
        if (!actualSet.has(id)) wm.addIdentity(ws.id, id)
      }
      for (const id of actual) {
        if (!expectedSet.has(id)) wm.removeIdentity(ws.id, id)
      }
      driftFixed += 1
    }
  }
  if (rehomed > 0 || driftFixed > 0) {
    log.info('identity-workspace-sync', 'invariant reconciled', {
      identitiesRehomed: rehomed,
      workspacesDriftFixed: driftFixed,
    })
  }
}

module.exports = { wireIdentityWorkspaceSync, syncIdentityWorkspaces }
