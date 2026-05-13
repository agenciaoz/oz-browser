// OZ Browser — Sync Queue (D-3b CORE).
//
// Persistent FIFO queue for pending sync operations (upsert/delete) that
// haven't been pushed to Dropbox yet. Drained by sync-engine when online;
// grows when offline or when the vault is locked.
//
// Storage: `userData/sync-queue.json` (atomic write via tmp + rename).
//
// Dedup: at most ONE pending op per `(recordType, recordId)`. A subsequent
// enqueue for the same record REPLACES the prior op and moves it to the
// END of the queue — so the freshest state is always carried, and FIFO
// order reflects most-recent-edit-first-among-pending. This is the
// "coalesce" optimization from ADR 0026 §5 (and the trigger debounce from
// §4) generalized to all time scales: regardless of when burst edits land,
// the queue carries at most one op per record.
//
// Spec: docs/architecture/0026-sync-engine.md §5 (offline queue + replay).
//
// Consumer: browser/sync-engine.js (D-3c) listens to IdentityManager
// 'changed' events, calls enqueue() with a translated op, and drains by
// peek()→push→remove() in a backoff-protected loop.

'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const SCHEMA_VERSION = 1
// Cap pre-allocation in case of pathological enqueue calls / disk corruption.
// 50k pending ops is well past any realistic team-mode workload; the engine
// is expected to drain or fail loud well before this number.
const MAX_QUEUE_SIZE = 50_000

class SyncQueueError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'SyncQueueError'
  }
}

function _validateOp(op) {
  if (op == null || typeof op !== 'object') {
    throw new SyncQueueError('op must be an object', 'BAD_OP')
  }
  if (op.op !== 'upsert' && op.op !== 'delete') {
    throw new SyncQueueError(
      `op.op must be "upsert" or "delete" (got ${JSON.stringify(op.op)})`,
      'BAD_OP_TYPE',
    )
  }
  if (typeof op.recordType !== 'string' || op.recordType.length < 1) {
    throw new SyncQueueError(
      'op.recordType must be a non-empty string',
      'BAD_RECORD_TYPE',
    )
  }
  if (typeof op.recordId !== 'string' || op.recordId.length < 1) {
    throw new SyncQueueError('op.recordId must be a non-empty string', 'BAD_RECORD_ID')
  }
  if (op.op === 'upsert') {
    if (typeof op.updatedAt !== 'string' || Number.isNaN(Date.parse(op.updatedAt))) {
      throw new SyncQueueError('upsert ops require ISO updatedAt', 'BAD_UPDATED_AT')
    }
    if (op.deletedAt !== undefined) {
      throw new SyncQueueError(
        'upsert ops must not carry deletedAt',
        'UPSERT_WITH_DELETED_AT',
      )
    }
  } else {
    // delete
    if (typeof op.deletedAt !== 'string' || Number.isNaN(Date.parse(op.deletedAt))) {
      throw new SyncQueueError('delete ops require ISO deletedAt', 'BAD_DELETED_AT')
    }
    if (op.updatedAt !== undefined) {
      throw new SyncQueueError(
        'delete ops must not carry updatedAt',
        'DELETE_WITH_UPDATED_AT',
      )
    }
  }
}

function _key(recordType, recordId) {
  return `${recordType}:${recordId}`
}

class SyncQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.filePath - absolute path to the queue file. In
   *   runtime this is `path.join(app.getPath('userData'), 'sync-queue.json')`.
   *   Pass a tmp path in tests.
   */
  constructor(opts = {}) {
    super()
    if (!opts.filePath || typeof opts.filePath !== 'string') {
      throw new SyncQueueError('filePath required', 'BAD_ARG')
    }
    this.filePath = opts.filePath
    // Map preserves insertion order — that IS our FIFO order. Dedup is
    // implicit: same key = same slot.
    this._ops = new Map()
    this._loaded = false
  }

  /**
   * Load existing queue from disk. Idempotent — subsequent calls no-op.
   * Bad JSON / schema mismatch → log + start fresh (the file is rewritten
   * on next save).
   */
  load() {
    if (this._loaded) return this
    this._loaded = true

    if (!fs.existsSync(this.filePath)) {
      return this
    }
    let raw
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      this.emit('warn', { reason: 'read-failed', message: err.message })
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.emit('warn', { reason: 'parse-failed', message: err.message })
      return this
    }
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(parsed.queue)
    ) {
      this.emit('warn', {
        reason: 'schema-mismatch',
        seenSchemaVersion: parsed && parsed.schemaVersion,
      })
      return this
    }

    for (const op of parsed.queue) {
      try {
        _validateOp(op)
      } catch (err) {
        // Skip malformed ops but keep the rest of the queue. Surface a warn
        // so the engine can decide whether to alert the user.
        this.emit('warn', {
          reason: 'invalid-op-skipped',
          op,
          message: err.message,
        })
        continue
      }
      this._ops.set(_key(op.recordType, op.recordId), op)
      if (this._ops.size >= MAX_QUEUE_SIZE) {
        this.emit('warn', { reason: 'max-queue-size-reached-on-load' })
        break
      }
    }
    return this
  }

  /**
   * Persist the queue to disk atomically (tmp + rename). Cheap to call after
   * every mutation — the queue is bounded in practice (<100 pending ops).
   */
  save() {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      queue: Array.from(this._ops.values()),
    }
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  /**
   * Append an op to the queue, persisting to disk. If an op already exists
   * for the same (recordType, recordId), it is REPLACED with the new op and
   * the slot moves to the end of the queue (carries the freshest state, and
   * FIFO order reflects most-recent-edit-first-among-pending).
   *
   * Throws SyncQueueError on validation failures or when the queue would
   * exceed MAX_QUEUE_SIZE.
   *
   * Emits 'enqueued' with `{ op, coalesced: boolean }`.
   */
  enqueue(op) {
    _validateOp(op)
    const k = _key(op.recordType, op.recordId)
    const coalesced = this._ops.has(k)
    if (coalesced) {
      // Remove from current position so the new op lands at the END.
      this._ops.delete(k)
    } else if (this._ops.size >= MAX_QUEUE_SIZE) {
      throw new SyncQueueError(
        `queue would exceed MAX_QUEUE_SIZE=${MAX_QUEUE_SIZE}`,
        'QUEUE_FULL',
      )
    }
    this._ops.set(k, op)
    this.save()
    this.emit('enqueued', { op, coalesced })
    return { coalesced }
  }

  /**
   * Read the next op without removing it. Returns null if empty.
   * Returns a SHALLOW copy so callers can't mutate the in-memory state.
   */
  peek() {
    const first = this._ops.values().next()
    if (first.done) return null
    return { ...first.value }
  }

  /**
   * Remove + return the next op, persisting to disk. Returns null if empty.
   * Emits 'dequeued' with `{ op }`.
   */
  dequeue() {
    const it = this._ops.keys().next()
    if (it.done) return null
    const k = it.value
    const op = this._ops.get(k)
    this._ops.delete(k)
    this.save()
    this.emit('dequeued', { op })
    return { ...op }
  }

  /**
   * Remove a specific op by (recordType, recordId). Used by the engine
   * after a successful upload OR when conflict resolution discards the
   * pending op. Returns true iff something was removed.
   */
  remove(recordType, recordId) {
    const k = _key(recordType, recordId)
    if (!this._ops.has(k)) return false
    const op = this._ops.get(k)
    this._ops.delete(k)
    this.save()
    this.emit('removed', { op })
    return true
  }

  has(recordType, recordId) {
    return this._ops.has(_key(recordType, recordId))
  }

  size() {
    return this._ops.size
  }

  /**
   * Returns a shallow-copy array of pending ops in FIFO order. Callers may
   * NOT mutate (mutations are silently ignored by the engine).
   */
  list() {
    return Array.from(this._ops.values()).map((op) => ({ ...op }))
  }

  /**
   * Drop every pending op. Used by the engine when a destructive restore
   * happens (pre-restore snapshot carries the old state; the queue is no
   * longer meaningful).
   *
   * Emits 'cleared' with `{ droppedCount }`.
   */
  clear() {
    const dropped = this._ops.size
    this._ops.clear()
    this.save()
    this.emit('cleared', { droppedCount: dropped })
  }
}

module.exports = {
  SyncQueue,
  SyncQueueError,
  SCHEMA_VERSION,
  MAX_QUEUE_SIZE,
}
