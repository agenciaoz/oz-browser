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
// K1-extras (v1.4.1): session warmer — per-identity HTTP touch to keep
// social platform session cookies fresh. Lightweight (no BrowserWindows).
const ACTION_SESSION_WARMER = 'session-warmer'

const ACTION_TYPES = Object.freeze([
  ACTION_OPEN_WORKSPACE,
  ACTION_SYNC_PUSH,
  ACTION_BACKUP_SNAPSHOT,
  ACTION_SESSION_WARMER,
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

// ---------- session-warmer (K1-extras, v1.4.1) ------------------------------
//
// Por qué existe: el use case core ("50 cuentas Insta logueadas") sufre de
// session expiry por inactividad. Plataformas como IG, X, FB rotan session
// cookies en cada request — sin requests, las cookies vencen y la cuenta
// queda logged out. Anti-logout extiende cookies localmente, pero algunos
// providers solo refrescan server-side al ver tráfico real.
//
// Lo que hace el handler: para cada identity (params.identityIds OR todas
// las del workspace), abre un net.request HTTP GET via la session de la
// identity contra la URL configurada (default: el homepage del primer site
// con account en el vault para esa identity, fallback `https://about:blank`).
// Goes through la proxy chain real + envía las cookies actuales.
//
// Lightweight design — NO BrowserWindows. Solo touch HTTP. Si el server
// devuelve 200 con Set-Cookie, las cookies se renuevan automáticamente
// (Electron mete las cookies del response en la session.cookies del
// partition). Si devuelve 401/403, el watcher de anti-logout va a flagear
// el account como needs_relogin en el próximo check.
//
// Cap: 50 identities por run, 1s throttle entre requests para no saturar.
// Timeout 8s por request.

const WARMER_PER_REQ_TIMEOUT_MS = 8000
const WARMER_THROTTLE_MS = 1000
const WARMER_MAX_IDENTITIES = 50

/**
 * Returns an async handler for `session-warmer`. The handler:
 *   - Requires `params.workspaceId` OR `params.identityIds` (one or both).
 *   - Skips on locked vault (no accountVault.list without unlock).
 *   - For each identity: resolves a target URL (params.urls[siteId] OR
 *     first account.site for that identity OR fallback `params.fallbackUrl`),
 *     fires net.request via session.fromPartition('persist:identity-<id>'),
 *     awaits response or timeout, throttles.
 *   - Returns `{ warmed: [{identityId, url, status}], skipped: [...], errors: [...] }`.
 *
 * @param {object} deps
 * @param {{list: Function}} deps.identityManager
 * @param {{get: Function}} [deps.workspaceManager]
 * @param {{getAccounts: Function, isUnlocked: boolean}} [deps.accountVault]
 * @param {import('electron').Session} [deps.sessionFactory]
 *   Function (partition) → Session. Default uses electron.session.fromPartition.
 * @param {Function} [deps.netRequest] - Electron net.request. Default uses electron.net.
 * @param {{isLocked?: () => boolean}} [deps.vault]
 */
function createSessionWarmerHandler({
  identityManager,
  workspaceManager,
  accountVault,
  sessionFactory,
  netRequest,
  vault,
} = {}) {
  if (!identityManager || typeof identityManager.list !== 'function') {
    throw new ScheduledHandlerError(
      'createSessionWarmerHandler: identityManager.list required',
      'BAD_DEP',
    )
  }
  const _sessionFactory =
    sessionFactory ||
    ((partition) => require('electron').session.fromPartition(partition, { cache: true }))
  const _netRequest = netRequest || ((opts) => require('electron').net.request(opts))

  return async function sessionWarmerHandler(params) {
    const locked = _vaultLockedSkip(vault)
    if (locked) return locked

    // 1. Resolve identity list.
    let identityIds = Array.isArray(params && params.identityIds)
      ? params.identityIds.slice()
      : null
    if (!identityIds && params && params.workspaceId && workspaceManager) {
      const ws = workspaceManager.get(params.workspaceId)
      if (ws && Array.isArray(ws.identityIds)) identityIds = ws.identityIds.slice()
    }
    if (!identityIds || identityIds.length === 0) {
      throw new ScheduledHandlerError(
        'session-warmer requires params.identityIds (array) or params.workspaceId',
        'BAD_PARAMS',
      )
    }
    if (identityIds.length > WARMER_MAX_IDENTITIES) {
      identityIds = identityIds.slice(0, WARMER_MAX_IDENTITIES)
    }

    // 2. Build account-by-identity map for URL resolution (best-effort).
    const accountsByIdentity = new Map()
    if (
      accountVault &&
      typeof accountVault.getAccounts === 'function' &&
      accountVault.isUnlocked !== false
    ) {
      try {
        for (const a of accountVault.getAccounts()) {
          if (!accountsByIdentity.has(a.identityId)) {
            accountsByIdentity.set(a.identityId, [])
          }
          accountsByIdentity.get(a.identityId).push(a)
        }
      } catch (_e) {
        // best-effort
      }
    }

    // 3. Iterate identities sequentially with throttle.
    const warmed = []
    const skipped = []
    const errors = []
    const fallbackUrl = (params && params.fallbackUrl) || null

    for (const identityId of identityIds) {
      const url = _resolveWarmerUrl({
        identityId,
        accountsByIdentity,
        explicitUrlsBySite: params && params.urlsBySite,
        fallbackUrl,
      })
      if (!url) {
        skipped.push({ identityId, reason: 'no-url' })
        continue
      }
      try {
        const status = await _fetchAndDiscard({
          url,
          identityId,
          sessionFactory: _sessionFactory,
          netRequest: _netRequest,
        })
        warmed.push({ identityId, url, status })
      } catch (err) {
        errors.push({
          identityId,
          url,
          message: err && err.message,
        })
      }
      // Throttle (skip after last).
      await new Promise((resolve) => setTimeout(resolve, WARMER_THROTTLE_MS))
    }

    return { warmed, skipped, errors, totalRequested: identityIds.length }
  }
}

function _resolveWarmerUrl({
  identityId,
  accountsByIdentity,
  explicitUrlsBySite,
  fallbackUrl,
}) {
  const accounts = accountsByIdentity.get(identityId) || []
  // 1. Explicit urls map by site: { 'instagram.com': 'https://instagram.com/' }.
  if (explicitUrlsBySite && typeof explicitUrlsBySite === 'object') {
    for (const a of accounts) {
      if (a.site && explicitUrlsBySite[a.site]) return explicitUrlsBySite[a.site]
    }
  }
  // 2. First account.site → derive homepage URL.
  for (const a of accounts) {
    if (a.site) return `https://${a.site}/`
  }
  // 3. Fallback URL or null.
  return fallbackUrl || null
}

function _fetchAndDiscard({ url, identityId, sessionFactory, netRequest }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      resolve(status)
    }
    const timer = setTimeout(() => finish('timeout'), WARMER_PER_REQ_TIMEOUT_MS)
    try {
      const ses = sessionFactory(`persist:identity-${identityId}`)
      const req = netRequest({ url, session: ses, useSessionCookies: true })
      let bytes = 0
      req.on('response', (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length
          // Drop bytes after 16KB to avoid memory bloat on huge pages.
          if (bytes > 16 * 1024) res.removeAllListeners('data')
        })
        res.on('end', () => {
          clearTimeout(timer)
          finish(res.statusCode || 0)
        })
        res.on('error', () => {
          clearTimeout(timer)
          finish('error')
        })
      })
      req.on('error', () => {
        clearTimeout(timer)
        finish('error')
      })
      req.end()
    } catch (_err) {
      clearTimeout(timer)
      finish('throw')
    }
  })
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
  // K1-extras (v1.4.1): session-warmer needs identityManager AND access to
  // the partition sessions via electron.session.fromPartition. workspaceManager
  // + accountVault are best-effort (used to resolve identityIds + URLs).
  if (deps.identityManager && typeof deps.identityManager.list === 'function') {
    scheduled.setHandler(
      ACTION_SESSION_WARMER,
      createSessionWarmerHandler({
        identityManager: deps.identityManager,
        workspaceManager: deps.workspaceManager,
        accountVault: deps.accountVault,
        sessionFactory: deps.sessionFactory,
        netRequest: deps.netRequest,
        vault: deps.vault,
      }),
    )
    registered.push(ACTION_SESSION_WARMER)
  }
  return registered
}

module.exports = {
  // factories
  createOpenWorkspaceHandler,
  createSyncPushHandler,
  createBackupSnapshotHandler,
  createSessionWarmerHandler,
  registerScheduledActionHandlers,
  // constants
  ACTION_OPEN_WORKSPACE,
  ACTION_SYNC_PUSH,
  ACTION_BACKUP_SNAPSHOT,
  ACTION_SESSION_WARMER,
  ACTION_TYPES,
  // tunables exposed for test pinning
  WARMER_PER_REQ_TIMEOUT_MS,
  WARMER_THROTTLE_MS,
  WARMER_MAX_IDENTITIES,
  // error
  ScheduledHandlerError,
}
