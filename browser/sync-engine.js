// OZ Browser — Sync Engine (D-3c-1: push side only).
//
// Wires IdentityManager (and future WorkspaceManager, BookmarkManager) to
// Dropbox via the local SyncQueue. Listens to a manager's 'changed' event,
// translates the payload into a queue op, then drains the queue in a
// backoff-protected loop, uploading encrypted records to Dropbox.
//
// What this module DOES (D-3c-1):
//   - registerSource({ recordType, manager, fetchRecord }) installs a
//     'changed' listener that translates to queue ops.
//   - drainOnce() pulls one op from the queue, encodes the current local
//     record (via the registered fetchRecord), and uploads it to
//     `/<appFolder>/<folderName>/<recordId>.json.enc` on Dropbox.
//   - start() / stop() run the drain loop with exponential backoff on
//     failure (1s → 2s → 4s → 8s → 16s → 30s, capped).
//   - Race-safe removal: an op is only removed from the queue if the
//     queue's pending updatedAt for the same key matches what we just
//     pushed; if a concurrent edit re-enqueued a newer op mid-flight,
//     it stays for the next drain.
//   - vault locked / Dropbox unauthenticated → drain pauses (no error).
//
// What this module does NOT do (deferred to D-3c-2 + D-3c-3):
//   - Long-poll pull / listFolderContinue cursor loop.
//   - Conflict pre-flight via filesGetMetadata (the ADR §4 "check before
//     push" — for D-3c-1 we just overwrite; LWW resolves on the pull side).
//   - Initial cold-start sync (§6).
//   - Tombstone GC sweep.
//
// Spec: docs/architecture/0026-sync-engine.md §4 (push on change), §5
//       (offline queue + replay), §12 (failure modes + UX).

'use strict'

const { EventEmitter } = require('events')
const { encodeRecord } = require('./sync-record-store')

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
const DEFAULT_IDLE_WAIT_MS = 1_000
const DEFAULT_APP_FOLDER = 'sync'
const DEFAULT_SCHEMA_VERSION = 1

class SyncEngineError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'SyncEngineError'
  }
}

/**
 * SyncEngine — orchestrator that turns local CRUD events into encrypted
 * record uploads to Dropbox.
 *
 * Events emitted:
 *   'pushed'         {op}             record successfully uploaded
 *   'push-failed'    {op, message}    upload threw; engine will retry
 *   'warn'           {reason, ...}    something unusual but not fatal
 *   'paused'         {reason}         drain skipped (vault locked / no auth)
 *   'started' / 'stopped'             lifecycle
 */
class SyncEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.dropbox        - has upload(path, buffer), isAuthenticated()
   * @param {object} opts.vault          - has getMasterKey() and isUnlocked
   * @param {object} opts.queue          - SyncQueue instance (already load()'d)
   * @param {string} opts.deviceFolder   - this device's deviceFolder slug
   * @param {string} [opts.appFolder]    - Dropbox app folder under root (default 'sync')
   * @param {number} [opts.schemaVersion]
   * @param {number[]} [opts.backoffSchedule]
   * @param {number} [opts.idleWaitMs]   - how long to wait when queue empty
   *                                       OR vault locked / no auth before
   *                                       trying again
   * @param {function} [opts.scheduler]  - inject a setTimeout-like fn for tests;
   *                                       must return a timer handle clearable
   *                                       via opts.cancelScheduler. Default uses
   *                                       global setTimeout/clearTimeout.
   * @param {function} [opts.cancelScheduler]
   */
  constructor(opts = {}) {
    super()
    if (!opts.dropbox) throw new SyncEngineError('dropbox required', 'BAD_ARG')
    if (!opts.vault) throw new SyncEngineError('vault required', 'BAD_ARG')
    if (!opts.queue) throw new SyncEngineError('queue required', 'BAD_ARG')
    if (typeof opts.deviceFolder !== 'string' || opts.deviceFolder.length < 2) {
      throw new SyncEngineError('deviceFolder required', 'BAD_ARG')
    }

    this.dropbox = opts.dropbox
    this.vault = opts.vault
    this.queue = opts.queue
    this.deviceFolder = opts.deviceFolder
    this.appFolder = opts.appFolder || DEFAULT_APP_FOLDER
    this.schemaVersion = opts.schemaVersion || DEFAULT_SCHEMA_VERSION
    this.backoffSchedule =
      Array.isArray(opts.backoffSchedule) && opts.backoffSchedule.length > 0
        ? opts.backoffSchedule.slice()
        : DEFAULT_BACKOFF_MS.slice()
    this.idleWaitMs = opts.idleWaitMs || DEFAULT_IDLE_WAIT_MS

    this._scheduler = opts.scheduler || setTimeout
    this._cancelScheduler = opts.cancelScheduler || clearTimeout

    this._sources = new Map() // recordType → { folderName, fetchRecord, manager, listener }
    this._running = false
    this._backoffIndex = 0
    this._loopHandle = null
  }

  /**
   * Wire a record source — its 'changed' event will be translated to queue
   * ops and pushed by the drain loop.
   *
   * @param {object} src
   * @param {string} src.recordType - 'identity' | 'workspace' | ...
   * @param {string} [src.folderName] - Dropbox folder name (default `${recordType}s`)
   * @param {object} src.manager - emits 'changed' with {op, recordId, record?, updatedAt?, deletedAt?}
   * @param {function} src.fetchRecord - (recordId) → plain object record or null
   */
  registerSource({ recordType, folderName, manager, fetchRecord }) {
    if (typeof recordType !== 'string' || recordType.length < 1) {
      throw new SyncEngineError('recordType required', 'BAD_SOURCE')
    }
    if (this._sources.has(recordType)) {
      throw new SyncEngineError(
        `source for recordType=${recordType} already registered`,
        'SOURCE_DUP',
      )
    }
    if (!manager || typeof manager.on !== 'function') {
      throw new SyncEngineError('manager must be an EventEmitter', 'BAD_SOURCE')
    }
    if (typeof fetchRecord !== 'function') {
      throw new SyncEngineError('fetchRecord must be a function', 'BAD_SOURCE')
    }
    const folder = folderName || `${recordType}s`
    const listener = (evt) => this._onChange(recordType, evt)
    manager.on('changed', listener)
    this._sources.set(recordType, {
      folderName: folder,
      fetchRecord,
      manager,
      listener,
    })
  }

  /**
   * Internal — translates a 'changed' event into a queue op.
   */
  _onChange(recordType, evt) {
    if (!evt || !evt.recordId) return
    try {
      if (evt.op === 'create' || evt.op === 'update') {
        if (typeof evt.updatedAt !== 'string') {
          this.emit('warn', {
            reason: 'changed-missing-updated-at',
            recordType,
            evt,
          })
          return
        }
        this.queue.enqueue({
          op: 'upsert',
          recordType,
          recordId: evt.recordId,
          updatedAt: evt.updatedAt,
        })
      } else if (evt.op === 'delete') {
        if (typeof evt.deletedAt !== 'string') {
          this.emit('warn', {
            reason: 'delete-missing-deleted-at',
            recordType,
            evt,
          })
          return
        }
        this.queue.enqueue({
          op: 'delete',
          recordType,
          recordId: evt.recordId,
          deletedAt: evt.deletedAt,
        })
      } else {
        this.emit('warn', { reason: 'unknown-op', recordType, evt })
      }
    } catch (err) {
      this.emit('warn', {
        reason: 'enqueue-failed',
        recordType,
        evt,
        message: err.message,
      })
    }
  }

  /**
   * Compute the Dropbox path for a record.
   */
  _pathFor(recordType, recordId) {
    const source = this._sources.get(recordType)
    if (!source) {
      throw new SyncEngineError(
        `no source registered for recordType=${recordType}`,
        'NO_SOURCE',
      )
    }
    return `/${this.appFolder}/${source.folderName}/${recordId}.json.enc`
  }

  /**
   * Build the encoded record buffer for an op. Returns {buf, pushedUpdatedAt}.
   * The pushedUpdatedAt is the timestamp that ends up in the uploaded header
   * — for upserts we use the LIVE record's updatedAt (which may be newer
   * than the queue op's updatedAt if a coalesce happened post-enqueue), for
   * deletes we use the queue op's deletedAt.
   */
  _buildPayload(op) {
    const key = this.vault.getMasterKey()
    if (!key) throw new SyncEngineError('vault locked', 'VAULT_LOCKED')
    const source = this._sources.get(op.recordType)
    if (!source) {
      throw new SyncEngineError(
        `no source registered for recordType=${op.recordType}`,
        'NO_SOURCE',
      )
    }

    if (op.op === 'delete') {
      const header = {
        schemaVersion: this.schemaVersion,
        updatedAt: op.deletedAt,
        deviceFolder: this.deviceFolder,
        recordType: op.recordType,
        recordId: op.recordId,
        deleted: true,
        deletedAt: op.deletedAt,
      }
      const buf = encodeRecord(key, header, null)
      return { buf, pushedUpdatedAt: op.deletedAt }
    }

    // upsert — fetch fresh record state. If the record has been deleted
    // locally between enqueue and drain, treat the queued upsert as stale
    // and skip (the matching delete op will land soon).
    const record = source.fetchRecord(op.recordId)
    if (!record) {
      throw new SyncEngineError(
        `record gone locally: ${op.recordType}/${op.recordId}`,
        'RECORD_GONE',
      )
    }
    // Live updatedAt wins over the queue's hint — a coalesce may have
    // landed AFTER the enqueue but BEFORE we got to peek().
    const liveUpdatedAt =
      typeof record.updatedAt === 'string' ? record.updatedAt : op.updatedAt
    const header = {
      schemaVersion: this.schemaVersion,
      updatedAt: liveUpdatedAt,
      deviceFolder: this.deviceFolder,
      recordType: op.recordType,
      recordId: op.recordId,
      deleted: false,
    }
    const buf = encodeRecord(key, header, record)
    return { buf, pushedUpdatedAt: liveUpdatedAt }
  }

  /**
   * After a successful push, remove the queue op iff it's still the same
   * op (no concurrent enqueue raced past us). Compare on op type + key +
   * timestamp.
   *
   * Returns true iff a removal happened.
   */
  _conditionalRemove(op, pushedUpdatedAt) {
    const list = this.queue.list()
    const slot = list.find(
      (o) => o.recordType === op.recordType && o.recordId === op.recordId,
    )
    if (!slot) return false // already removed by some other path
    const slotTs = slot.op === 'upsert' ? slot.updatedAt : slot.deletedAt
    const pushedTs = pushedUpdatedAt
    // The slot is considered "satisfied by our push" iff its timestamp is
    // <= the timestamp we pushed AND its op-type matches what we pushed.
    // If the slot got coalesced into a different op-type or has a strictly
    // newer timestamp, leave it for next drain.
    if (slot.op !== op.op) return false
    if (Date.parse(slotTs) > Date.parse(pushedTs)) return false
    return this.queue.remove(op.recordType, op.recordId)
  }

  /**
   * Perform at most one drain cycle. Returns one of:
   *   'pushed'           — uploaded successfully
   *   'empty'            — no pending ops
   *   'vault-locked'     — vault not ready; will retry
   *   'unauthenticated'  — Dropbox not authenticated; will retry
   *   'failed'           — upload threw; backoff escalates
   *   'skipped'          — op skipped (record gone or no source); op removed
   */
  async drainOnce() {
    if (!this.vault.isUnlocked) {
      this.emit('paused', { reason: 'vault-locked' })
      return 'vault-locked'
    }
    if (
      typeof this.dropbox.isAuthenticated === 'function' &&
      !this.dropbox.isAuthenticated()
    ) {
      this.emit('paused', { reason: 'unauthenticated' })
      return 'unauthenticated'
    }
    const op = this.queue.peek()
    if (!op) return 'empty'

    let buf, pushedUpdatedAt
    try {
      const built = this._buildPayload(op)
      buf = built.buf
      pushedUpdatedAt = built.pushedUpdatedAt
    } catch (err) {
      if (err.code === 'RECORD_GONE') {
        // Local record gone — drop the upsert; a matching delete op should
        // eventually land via 'changed'. Surface a warn so the alert layer
        // can decide whether to inform the user.
        this.queue.remove(op.recordType, op.recordId)
        this.emit('warn', { reason: 'record-gone-dropped', op, message: err.message })
        return 'skipped'
      }
      if (err.code === 'NO_SOURCE') {
        // Op for an unregistered recordType — likely a partial wire-up
        // during startup. Leave the op in the queue, log a warn, but
        // don't crash.
        this.emit('warn', { reason: 'no-source', op, message: err.message })
        return 'failed'
      }
      // VAULT_LOCKED can race with the isUnlocked check above (vault
      // can lock between the check and getMasterKey). Treat as paused.
      if (err.code === 'VAULT_LOCKED') {
        this.emit('paused', { reason: 'vault-locked' })
        return 'vault-locked'
      }
      throw err
    }

    const dropboxPath = this._pathFor(op.recordType, op.recordId)

    try {
      await this.dropbox.upload(dropboxPath, buf)
    } catch (err) {
      this._backoffIndex = Math.min(
        this._backoffIndex + 1,
        this.backoffSchedule.length - 1,
      )
      this.emit('push-failed', {
        op,
        path: dropboxPath,
        message: err && err.message ? err.message : String(err),
      })
      return 'failed'
    }

    this._conditionalRemove(op, pushedUpdatedAt)
    this._backoffIndex = 0
    this.emit('pushed', { op, path: dropboxPath, pushedUpdatedAt })
    return 'pushed'
  }

  currentBackoffMs() {
    return this.backoffSchedule[
      Math.min(this._backoffIndex, this.backoffSchedule.length - 1)
    ]
  }

  /**
   * Begin the drain loop. Idempotent — calling start() twice no-ops.
   */
  start() {
    if (this._running) return
    this._running = true
    this.emit('started')
    this._scheduleNext(0)
  }

  /**
   * Halt the drain loop and detach all 'changed' listeners. After stop()
   * the engine is finalized and should be discarded — registerSource()
   * would refuse re-registration if you reused it. Idempotent.
   */
  stop() {
    if (!this._running) return
    this._running = false
    if (this._loopHandle) {
      this._cancelScheduler(this._loopHandle)
      this._loopHandle = null
    }
    for (const [, source] of this._sources) {
      try {
        source.manager.removeListener('changed', source.listener)
      } catch (_err) {
        /* swallow — the manager may already be torn down */
      }
    }
    this.emit('stopped')
  }

  _scheduleNext(delay) {
    if (!this._running) return
    this._loopHandle = this._scheduler(async () => {
      if (!this._running) return
      let result
      try {
        result = await this.drainOnce()
      } catch (err) {
        this.emit('warn', { reason: 'drain-threw', message: err.message })
        result = 'failed'
      }
      if (!this._running) return
      let nextDelay
      if (result === 'pushed' || result === 'skipped') {
        nextDelay = 0
      } else if (result === 'failed') {
        nextDelay = this.currentBackoffMs()
      } else {
        // empty / vault-locked / unauthenticated → idle wait
        nextDelay = this.idleWaitMs
      }
      this._scheduleNext(nextDelay)
    }, delay)
  }
}

module.exports = {
  SyncEngine,
  SyncEngineError,
  DEFAULT_BACKOFF_MS,
  DEFAULT_IDLE_WAIT_MS,
  DEFAULT_APP_FOLDER,
  DEFAULT_SCHEMA_VERSION,
}
