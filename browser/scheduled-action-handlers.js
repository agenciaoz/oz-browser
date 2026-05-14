// OZ Browser — Scheduled Action handlers (Bloque F-2, v1).
//
// Real handlers for the action types that F-1's runner schedules. Each
// handler is a thin adapter that:
//   1. Validates params shape (so a typo in Settings UI surfaces as
//      lastResult.error, not a downstream crash).
//   2. Skips with `{ skipped: true, reason: 'vault-locked' }` when the
//      vault is locked — locked vaults can't decrypt sessions, push to
//      Dropbox, or write snapshot blobs, so firing those handlers anyway
//      would just produce noise + failed cron entries the user can't
//      action. We treat locked-vault as a benign skip, not an error.
//   3. Returns a small JSON-serializable result so lastResult.value
//      stays useful (sync-queue / backup ids etc.).
//
// We expose factory functions so F-4 (main.js wire-up) can inject the
// real implementations:
//   - openWorkspace(workspaceId) → opaque promise (window-workspace.js)
//   - syncPush() → opaque promise (sync-setup.js / sync-engine.js)
//   - backupManager.createSnapshot(opts) (browser/backup-manager.js)
//
// Tests cover each handler against fakes — they never touch Electron,
// the real vault, or real Dropbox. The factory signature is the contract.
//
// Spec: see browser/scheduled-actions.js for the runner side. NON-GOAL
// for v1: comment / posting / multi-step recipes (that's v2 in
// docs/PLAN-AUTOMATION-F-K.md).

'use strict'

const ACTION_OPEN_WORKSPACE = 'open-workspace'
const ACTION_SYNC_PUSH = 'sync-push'
const ACTION_BACKUP_SNAPSHOT = 'backup-snapshot'

const ACTION_TYPES = Object.freeze([
  ACTION_OPEN_WORKSPACE,
  ACTION_SYNC_PUSH,
  ACTION_BACKUP_SNAPSHOT,
])

class ScheduledHandlerError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'ScheduledHandlerError'
  }
}

// Common guard: skip on locked vault. Returns the skip payload (truthy)
// when locked, null when unlocked or when no vault was injected.
function _vaultLockedSkip(vault) {
  if (vault && typeof vault.isLocked === 'function' && vault.isLocked()) {
    return { skipped: true, reason: 'vault-locked' }
  }
  return null
}

// ---------- open-workspace --------------------------------------------------

/**
 * Returns an async handler for `open-workspace`. The handler:
 *   - Requires `params.workspaceId` (non-empty string).
 *   - Skips on locked vault (workspaces can't be opened without cookies).
 *   - Delegates to `openWorkspace(workspaceId)`; whatever that returns is
 *     wrapped into `{ ok: true, workspaceId, opened: <value> }`.
 *   - Propagates downstream errors so the runner marks lastResult.ok=false.
 *
 * @param {object} deps
 * @param {(workspaceId: string) => Promise<any>} deps.openWorkspace
 * @param {{isLocked?: () => boolean}} [deps.vault]
 */
function createOpenWorkspaceHandler({ openWorkspace, vault } = {}) {
  if (typeof openWorkspace !== 'function') {
    throw new ScheduledHandlerError(
      'createOpenWorkspaceHandler: openWorkspace fn required',
      'BAD_DEP',
    )
  }
  return async function openWorkspaceHandler(params) {
    const workspaceId = params && params.workspaceId
    if (typeof workspaceId !== 'string' || workspaceId.length < 1) {
      throw new ScheduledHandlerError(
        'open-workspace requires params.workspaceId (string)',
        'BAD_PARAMS',
      )
    }
    const lockedSkip = _vaultLockedSkip(vault)
    if (lockedSkip) return lockedSkip
    const result = await openWorkspace(workspaceId)
    return { ok: true, workspaceId, opened: _safeScalar(result) }
  }
}

// ---------- sync-push -------------------------------------------------------

/**
 * Returns an async handler for `sync-push`. The handler:
 *   - Skips on locked vault (the engine refuses to upload encrypted
 *     records without the master key in scope anyway — better to skip
 *     cleanly than queue an attempt that's going to fail at the queue).
 *   - Delegates to `syncPush()` and wraps the result.
 *
 * `syncPush` is expected to be idempotent — multiple pushes during a
 * tick burst should be safe (the engine debounces internally).
 *
 * @param {object} deps
 * @param {() => Promise<any>} deps.syncPush
 * @param {{isLocked?: () => boolean}} [deps.vault]
 */
function createSyncPushHandler({ syncPush, vault } = {}) {
  if (typeof syncPush !== 'function') {
    throw new ScheduledHandlerError(
      'createSyncPushHandler: syncPush fn required',
      'BAD_DEP',
    )
  }
  return async function syncPushHandler(_params) {
    const lockedSkip = _vaultLockedSkip(vault)
    if (lockedSkip) return lockedSkip
    const result = await syncPush()
    return { ok: true, pushed: _safeScalar(result) }
  }
}

// ---------- backup-snapshot -------------------------------------------------

/**
 * Returns an async handler for `backup-snapshot`. The handler:
 *   - Skips on locked vault (snapshot bodies are AES-256-GCM encrypted
 *     with the master key; can't encrypt without it).
 *   - Forwards optional params to `backupManager.createSnapshot(params)`
 *     (e.g. `{ label: 'nightly' }`).
 *   - Returns a small `{ ok: true, snapshotId, createdAt }` shape so
 *     lastResult.value stays under the 4kB cap.
 *
 * @param {object} deps
 * @param {{createSnapshot: (opts: object) => Promise<{id: string, createdAt?: any}>}} deps.backupManager
 * @param {{isLocked?: () => boolean}} [deps.vault]
 */
function createBackupSnapshotHandler({ backupManager, vault } = {}) {
  if (!backupManager || typeof backupManager.createSnapshot !== 'function') {
    throw new ScheduledHandlerError(
      'createBackupSnapshotHandler: backupManager.createSnapshot required',
      'BAD_DEP',
    )
  }
  return async function backupSnapshotHandler(params) {
    const lockedSkip = _vaultLockedSkip(vault)
    if (lockedSkip) return lockedSkip
    const opts = _sanitizeSnapshotOpts(params)
    const snap = await backupManager.createSnapshot(opts)
    if (!snap || typeof snap.id !== 'string') {
      throw new ScheduledHandlerError(
        'backup-snapshot: createSnapshot returned no id',
        'BAD_RESULT',
      )
    }
    return {
      ok: true,
      snapshotId: snap.id,
      createdAt: _safeScalar(snap.createdAt),
    }
  }
}

function _sanitizeSnapshotOpts(params) {
  if (params == null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) return {}
  // Whitelist the keys we let through. Anything else is silently dropped
  // — the user types the schedule, they shouldn't be able to inject
  // arbitrary createSnapshot opts via Settings UI.
  const out = {}
  if (typeof params.label === 'string' && params.label.length <= 80) {
    out.label = params.label
  }
  if (typeof params.reason === 'string' && params.reason.length <= 80) {
    out.reason = params.reason
  }
  return out
}

function _safeScalar(v) {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    try {
      const s = JSON.stringify(v)
      if (s.length > 400) return { truncated: true }
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  return null
}

// ---------- registry helper -------------------------------------------------

/**
 * Convenience: register all three handlers on a `ScheduledActions`
 * instance using the same deps bag. F-4's main.js wire-up calls this
 * once with the live WorkspaceManager / sync-setup / backupManager.
 *
 * Missing deps are tolerated — a handler simply isn't registered, and
 * its scheduled action will fail with NO_HANDLER at fire time (the
 * runner's existing path). That lets us partial-wire during F-4 dev.
 *
 * @param {import('./scheduled-actions').ScheduledActions} scheduled
 * @param {object} deps
 * @param {(workspaceId: string) => Promise<any>} [deps.openWorkspace]
 * @param {() => Promise<any>} [deps.syncPush]
 * @param {{createSnapshot: Function}} [deps.backupManager]
 * @param {{isLocked?: () => boolean}} [deps.vault]
 * @returns {string[]} list of action types that were registered
 */
function registerScheduledActionHandlers(scheduled, deps = {}) {
  if (!scheduled || typeof scheduled.setHandler !== 'function') {
    throw new ScheduledHandlerError(
      'registerScheduledActionHandlers: scheduled.setHandler required',
      'BAD_ARG',
    )
  }
  const registered = []
  if (typeof deps.openWorkspace === 'function') {
    scheduled.setHandler(
      ACTION_OPEN_WORKSPACE,
      createOpenWorkspaceHandler({
        openWorkspace: deps.openWorkspace,
        vault: deps.vault,
      }),
    )
    registered.push(ACTION_OPEN_WORKSPACE)
  }
  if (typeof deps.syncPush === 'function') {
    scheduled.setHandler(
      ACTION_SYNC_PUSH,
      createSyncPushHandler({ syncPush: deps.syncPush, vault: deps.vault }),
    )
    registered.push(ACTION_SYNC_PUSH)
  }
  if (deps.backupManager && typeof deps.backupManager.createSnapshot === 'function') {
    scheduled.setHandler(
      ACTION_BACKUP_SNAPSHOT,
      createBackupSnapshotHandler({
        backupManager: deps.backupManager,
        vault: deps.vault,
      }),
    )
    registered.push(ACTION_BACKUP_SNAPSHOT)
  }
  return registered
}

module.exports = {
  // factories
  createOpenWorkspaceHandler,
  createSyncPushHandler,
  createBackupSnapshotHandler,
  registerScheduledActionHandlers,
  // constants
  ACTION_OPEN_WORKSPACE,
  ACTION_SYNC_PUSH,
  ACTION_BACKUP_SNAPSHOT,
  ACTION_TYPES,
  // error
  ScheduledHandlerError,
}
