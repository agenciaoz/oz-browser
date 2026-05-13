// OZ Browser — Sync Setup (D-3c-3b CORE).
//
// Wire-up module that composes all the sync primitives into a single
// controllable object. The host (main.js or test) calls setupSync(...)
// with deps + returns { start, stop, engine, puller, queue } — everything
// it needs to drive the sync layer end-to-end.
//
// What setupSync DOES:
//   1. Instantiates SyncQueue at userData/sync-queue.json and load()'s it.
//   2. Instantiates SyncEngine with the queue, registers IdentityManager
//      as the 'identity' source — engine listens to IM's 'changed' event
//      and translates to queue ops, then drains in a backoff loop.
//   3. Instantiates SyncPuller at userData/sync-state.json and load()'s
//      its cursor state. Registers IdentityManager as the 'identity'
//      source (for fetchRecord during LWW merge).
//   4. Subscribes puller.on('remote-apply') to the apply-remote helpers
//      in identity-manager-sync.js — that's the bridge that lands remote
//      changes locally WITHOUT triggering the push loop.
//   5. Exposes start() / stop() that drive both engine.start() and a
//      periodic pullOnce() poll loop (D-3c-3c will replace the poll with
//      a real long-poll over filesListFolderLongpoll).
//
// What it does NOT do (deferred):
//   - main.js wire-up itself (separate sub-chunk — D-3c-3c).
//   - WorkspaceManager / bookmarks sources.
//   - Long-poll connection.
//   - UI status surface (paused / unauthenticated alerts).
//   - Initial cold-start "push all local first" sweep.
//
// Spec: docs/architecture/0026-sync-engine.md §4 (push + pull), §12
//       (failure modes + UX).

'use strict'

const path = require('path')
const log = require('./logger')
const { SyncQueue } = require('./sync-queue')
const { SyncEngine } = require('./sync-engine')
const { SyncPuller } = require('./sync-pull')
const {
  applyRemoteUpsert: applyIdentityRemoteUpsert,
  applyRemoteDelete: applyIdentityRemoteDelete,
} = require('./identity-manager-sync')
const {
  applyRemoteUpsert: applyWorkspaceRemoteUpsert,
  applyRemoteDelete: applyWorkspaceRemoteDelete,
} = require('./workspace-manager-sync')
const {
  applyRemoteUpsert: applyBookmarkRemoteUpsert,
  BOOKMARKS_RECORD_ID,
} = require('./bookmark-manager-sync')

const DEFAULT_POLL_INTERVAL_MS = 30_000
const DEFAULT_APP_FOLDER = 'sync'

class SyncSetupError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'SyncSetupError'
  }
}

/**
 * @param {object} opts
 * @param {object} opts.vault            - Vault instance (getMasterKey, isUnlocked)
 * @param {object} opts.dropbox          - Dropbox client
 * @param {object} opts.identityManager  - IdentityManager instance
 * @param {object} [opts.workspaceManager] - WorkspaceManager instance (optional)
 * @param {object} [opts.bookmarkManager]  - BookmarkManager instance (optional)
 * @param {string} opts.userDataDir      - absolute path; queue + state live here
 * @param {string} opts.deviceFolder     - this device's deviceFolder slug
 * @param {string} [opts.appFolder]      - Dropbox app folder (default 'sync')
 * @param {number} [opts.pollIntervalMs] - pull poll interval (default 30s)
 * @param {function} [opts.scheduler]    - inject for tests (engine drain loop)
 * @param {function} [opts.cancelScheduler]
 * @param {function} [opts.pollScheduler]      - inject for tests (pull poll loop)
 * @param {function} [opts.pollCancelScheduler]
 *
 * @returns {{
 *   engine: SyncEngine,
 *   puller: SyncPuller,
 *   queue: SyncQueue,
 *   start: () => void,
 *   stop: () => void,
 *   isRunning: () => boolean,
 *   pullNow: () => Promise<*>,  // manual trigger for tests / "refresh" button
 * }}
 */
function setupSync(opts = {}) {
  if (!opts.vault) throw new SyncSetupError('vault required', 'BAD_ARG')
  if (!opts.dropbox) throw new SyncSetupError('dropbox required', 'BAD_ARG')
  if (!opts.identityManager) {
    throw new SyncSetupError('identityManager required', 'BAD_ARG')
  }
  if (typeof opts.userDataDir !== 'string' || opts.userDataDir.length < 1) {
    throw new SyncSetupError('userDataDir required', 'BAD_ARG')
  }
  if (typeof opts.deviceFolder !== 'string' || opts.deviceFolder.length < 2) {
    throw new SyncSetupError('deviceFolder required', 'BAD_ARG')
  }

  const appFolder = opts.appFolder || DEFAULT_APP_FOLDER
  const pollIntervalMs = opts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS

  // ---------- 1. Queue ----------
  const queue = new SyncQueue({
    filePath: path.join(opts.userDataDir, 'sync-queue.json'),
  }).load()

  // Surface queue warns for the host to log / alert on.
  queue.on('warn', (w) => {
    log.warn('sync-setup', 'queue warn', w)
  })

  // ---------- 2. Engine (push side) ----------
  const engine = new SyncEngine({
    vault: opts.vault,
    dropbox: opts.dropbox,
    queue,
    deviceFolder: opts.deviceFolder,
    appFolder,
    scheduler: opts.scheduler,
    cancelScheduler: opts.cancelScheduler,
  })

  engine.registerSource({
    recordType: 'identity',
    manager: opts.identityManager,
    fetchRecord: (recordId) => opts.identityManager.get(recordId),
  })

  if (opts.workspaceManager) {
    engine.registerSource({
      recordType: 'workspace',
      manager: opts.workspaceManager,
      // Strip tabSpecs / activeTabId at push time — privacy carveout
      // (mirror of the strip on the apply side in workspace-manager-sync).
      fetchRecord: (recordId) => {
        const ws = opts.workspaceManager.get(recordId)
        if (!ws) return null

        const { tabSpecs: _t, activeTabId: _a, ...stripped } = ws
        return stripped
      },
    })
  }

  if (opts.bookmarkManager) {
    // Bookmarks sync as a single record — recordId='all'. fetchRecord
    // returns the entire bookmark collection wrapped as one body.
    engine.registerSource({
      recordType: 'bookmark',
      manager: opts.bookmarkManager,
      fetchRecord: (recordId) => {
        if (recordId !== BOOKMARKS_RECORD_ID) return null
        return opts.bookmarkManager.getSyncRecord()
      },
    })
  }

  // ---------- 3. Puller (pull side) ----------
  const puller = new SyncPuller({
    vault: opts.vault,
    dropbox: opts.dropbox,
    deviceFolder: opts.deviceFolder,
    appFolder,
    stateFilePath: path.join(opts.userDataDir, 'sync-state.json'),
  }).loadState()

  puller.registerSource({
    recordType: 'identity',
    fetchRecord: (recordId) => opts.identityManager.get(recordId),
  })

  if (opts.workspaceManager) {
    puller.registerSource({
      recordType: 'workspace',
      fetchRecord: (recordId) => opts.workspaceManager.get(recordId),
    })
  }

  if (opts.bookmarkManager) {
    puller.registerSource({
      recordType: 'bookmark',
      fetchRecord: (recordId) =>
        recordId === BOOKMARKS_RECORD_ID ? opts.bookmarkManager.getSyncRecord() : null,
    })
  }

  // ---------- 4. Bridge: puller 'remote-apply' → sync helpers ----------
  // Routed by recordType: identity → identity-manager-sync,
  // workspace → workspace-manager-sync.
  puller.on('remote-apply', (evt) => {
    try {
      const isUpsert = evt.action === 'upsert'
      const isDelete = evt.action === 'delete'
      if (!isUpsert && !isDelete) {
        log.warn('sync-setup', "unknown 'remote-apply' action", { evt })
        return
      }
      const deletedAt = evt.header && evt.header.deletedAt
      if (evt.recordType === 'identity') {
        if (isUpsert) applyIdentityRemoteUpsert(opts.identityManager, evt.body)
        else applyIdentityRemoteDelete(opts.identityManager, evt.recordId, deletedAt)
      } else if (evt.recordType === 'workspace' && opts.workspaceManager) {
        if (isUpsert) applyWorkspaceRemoteUpsert(opts.workspaceManager, evt.body)
        else applyWorkspaceRemoteDelete(opts.workspaceManager, evt.recordId, deletedAt)
      } else if (evt.recordType === 'bookmark' && opts.bookmarkManager) {
        // Deletes are a no-op for bookmarks (see bookmark-manager-sync docstring).
        if (isUpsert) applyBookmarkRemoteUpsert(opts.bookmarkManager, evt.body)
      } else {
        log.warn('sync-setup', "unhandled recordType in 'remote-apply'", {
          recordType: evt.recordType,
        })
      }
    } catch (err) {
      log.warn('sync-setup', "'remote-apply' handler threw", {
        recordId: evt && evt.recordId,
        message: err.message,
      })
    }
  })

  // Surface puller pauses / warns / local-wins for observability.
  puller.on('paused', (e) => log.info('sync-setup', 'puller paused', e))
  puller.on('warn', (w) => log.warn('sync-setup', 'puller warn', w))
  puller.on('local-wins', (e) =>
    log.info('sync-setup', 'puller local-wins', {
      recordId: e.header && e.header.recordId,
      reason: e.reason,
    }),
  )

  // Surface engine events too.
  engine.on('pushed', (e) =>
    log.info('sync-setup', 'engine pushed', {
      recordId: e.op && e.op.recordId,
      path: e.path,
    }),
  )
  engine.on('push-failed', (e) =>
    log.warn('sync-setup', 'engine push-failed', {
      recordId: e.op && e.op.recordId,
      message: e.message,
    }),
  )

  // ---------- 5. Pull poll loop ----------
  // D-3c-3c may replace this with filesListFolderLongpoll. For now, a
  // setInterval-driven poll is fine — Dropbox's per-call cost on
  // listFolderContinue is small and the 30s default keeps remote→local
  // lag acceptable.
  const pollScheduler = opts.pollScheduler || setInterval
  const pollCancelScheduler = opts.pollCancelScheduler || clearInterval

  let pollHandle = null
  let running = false

  async function pullTick() {
    if (!running) return
    try {
      await puller.pullOnce('identity')
      if (opts.workspaceManager) {
        await puller.pullOnce('workspace')
      }
      if (opts.bookmarkManager) {
        await puller.pullOnce('bookmark')
      }
    } catch (err) {
      log.warn('sync-setup', 'pullOnce threw', { message: err.message })
    }
  }

  function start() {
    if (running) return
    running = true
    engine.start()
    // Fire one pull immediately on start, then settle into the interval.
    // Use Promise.resolve().then to schedule for the next microtask — keeps
    // synchronous start() simple and avoids re-entrancy traps.
    Promise.resolve().then(pullTick)
    pollHandle = pollScheduler(pullTick, pollIntervalMs)
    log.info('sync-setup', 'sync started', { pollIntervalMs })
  }

  function stop() {
    if (!running) return
    running = false
    if (pollHandle) {
      pollCancelScheduler(pollHandle)
      pollHandle = null
    }
    engine.stop()
    log.info('sync-setup', 'sync stopped')
  }

  return {
    engine,
    puller,
    queue,
    start,
    stop,
    isRunning: () => running,
    pullNow: async () => {
      const identityResult = await puller.pullOnce('identity')
      let workspaceResult
      if (opts.workspaceManager) {
        workspaceResult = await puller.pullOnce('workspace')
      }
      let bookmarkResult
      if (opts.bookmarkManager) {
        bookmarkResult = await puller.pullOnce('bookmark')
      }
      return {
        identity: identityResult,
        workspace: workspaceResult,
        bookmark: bookmarkResult,
      }
    },
  }
}

module.exports = {
  setupSync,
  SyncSetupError,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_APP_FOLDER,
}
