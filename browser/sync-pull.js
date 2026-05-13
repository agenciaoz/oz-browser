// OZ Browser — Sync Pull (D-3c-2 CORE).
//
// Pulls remote records from Dropbox, decodes them, runs LWW merge against
// local state via sync-merge, and emits 'remote-apply' events that a
// host (e.g. main.js) wires into IdentityManager / WorkspaceManager.
//
// Why a separate module (not folded into sync-engine.js)? ADR 0005 caps
// files at 500 LOC; sync-engine.js is already close after D-3c-1. Pull
// has independent state (cursors per folder) and is independently
// testable, so it earns its own module. D-3c-3 wires both into the host.
//
// What this module DOES (D-3c-2):
//   - registerSource({recordType, folderName, fetchRecord}) — knows where
//     to look on Dropbox and how to read local state for merge.
//   - pullOnce(recordType) — fetches the delta for one folder using the
//     persisted cursor (or full listFolder if cold-start), decodes each
//     entry, runs sync-merge LWW against local, and emits 'remote-apply'
//     for each remote record that needs to land locally.
//   - Cursor persistence in `userData/sync-state.json` (atomic write).
//   - Self-upload skip: entries whose header.deviceFolder matches this
//     device's are ignored (we already have that state locally).
//   - Decode failures / Dropbox-level deletes are skipped with a 'warn'.
//
// What this module does NOT do (deferred):
//   - Long-poll connection via filesListFolderLongpoll (D-3c-3).
//   - Apply remote changes to IdentityManager — the host wires 'remote-apply'
//     events to manager.applyRemoteUpsert / applyRemoteDelete (D-3c-3).
//   - Tombstone GC sweep (D-4).
//   - Pagination loop when hasMore=true — for D-3c-2 we surface hasMore
//     in the result so the caller (or D-3c-3 loop) can drive multiple
//     pullOnce calls.
//
// Spec: docs/architecture/0026-sync-engine.md §4 (pull / long-poll), §6
//       (initial sync cold-start).

'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { decodeRecord } = require('./sync-record-store')
const { mergeRecords } = require('./sync-merge')

const SCHEMA_VERSION = 1

class SyncPullError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'SyncPullError'
  }
}

class SyncPuller extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.dropbox        - has listFolder(path), listFolderContinue(cursor), download(path), isAuthenticated()
   * @param {object} opts.vault          - has getMasterKey() and isUnlocked
   * @param {string} opts.deviceFolder   - this device's deviceFolder slug
   * @param {string} [opts.appFolder]    - Dropbox app folder under root (default 'sync')
   * @param {string} opts.stateFilePath  - absolute path to sync-state.json
   */
  constructor(opts = {}) {
    super()
    if (!opts.dropbox) throw new SyncPullError('dropbox required', 'BAD_ARG')
    if (!opts.vault) throw new SyncPullError('vault required', 'BAD_ARG')
    if (typeof opts.deviceFolder !== 'string' || opts.deviceFolder.length < 2) {
      throw new SyncPullError('deviceFolder required', 'BAD_ARG')
    }
    if (typeof opts.stateFilePath !== 'string' || opts.stateFilePath.length < 1) {
      throw new SyncPullError('stateFilePath required', 'BAD_ARG')
    }

    this.dropbox = opts.dropbox
    this.vault = opts.vault
    this.deviceFolder = opts.deviceFolder
    this.appFolder = opts.appFolder || 'sync'
    this.stateFilePath = opts.stateFilePath

    this._sources = new Map() // recordType → { folderName, fetchRecord }
    this._state = { schemaVersion: SCHEMA_VERSION, cursors: {} }
    this._loaded = false
  }

  /**
   * Wire a source. fetchRecord(recordId) → current local record or null.
   */
  registerSource({ recordType, folderName, fetchRecord }) {
    if (typeof recordType !== 'string' || recordType.length < 1) {
      throw new SyncPullError('recordType required', 'BAD_SOURCE')
    }
    if (this._sources.has(recordType)) {
      throw new SyncPullError(
        `source for recordType=${recordType} already registered`,
        'SOURCE_DUP',
      )
    }
    if (typeof fetchRecord !== 'function') {
      throw new SyncPullError('fetchRecord must be a function', 'BAD_SOURCE')
    }
    this._sources.set(recordType, {
      folderName: folderName || `${recordType}s`,
      fetchRecord,
    })
  }

  /**
   * Load existing cursor state from disk. Idempotent. Bad JSON / schema
   * mismatch → start fresh (next save rewrites the file).
   */
  loadState() {
    if (this._loaded) return this
    this._loaded = true
    if (!fs.existsSync(this.stateFilePath)) return this
    let raw
    try {
      raw = fs.readFileSync(this.stateFilePath, 'utf-8')
    } catch (err) {
      this.emit('warn', { reason: 'state-read-failed', message: err.message })
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.emit('warn', { reason: 'state-parse-failed', message: err.message })
      return this
    }
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      parsed.cursors == null ||
      typeof parsed.cursors !== 'object'
    ) {
      this.emit('warn', {
        reason: 'state-schema-mismatch',
        seenSchemaVersion: parsed && parsed.schemaVersion,
      })
      return this
    }
    this._state = {
      schemaVersion: SCHEMA_VERSION,
      cursors: { ...parsed.cursors },
    }
    return this
  }

  /**
   * Atomic persist (tmp + rename).
   */
  saveState() {
    const dir = path.dirname(this.stateFilePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = this.stateFilePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf-8')
    fs.renameSync(tmp, this.stateFilePath)
  }

  /**
   * Returns the cursor for a folder (or null if not yet stored).
   */
  cursorFor(folderName) {
    return this._state.cursors[folderName] || null
  }

  /**
   * Pull the next delta for one recordType.
   *
   * Returns:
   *   { status: 'ok', applied, localWins, skipped, errors, hasMore, cursor }
   *   { status: 'vault-locked' }      — vault not unlocked
   *   { status: 'unauthenticated' }   — Dropbox not authenticated
   *
   * Emits per processed entry:
   *   'remote-apply' { recordType, action: 'upsert'|'delete', recordId, header, body }
   *   'local-wins'   { recordType, header }
   *   'warn'         { reason, ... }
   */
  async pullOnce(recordType) {
    if (!this.vault.isUnlocked) {
      this.emit('paused', { reason: 'vault-locked' })
      return { status: 'vault-locked' }
    }
    if (
      typeof this.dropbox.isAuthenticated === 'function' &&
      !this.dropbox.isAuthenticated()
    ) {
      this.emit('paused', { reason: 'unauthenticated' })
      return { status: 'unauthenticated' }
    }
    const source = this._sources.get(recordType)
    if (!source) {
      throw new SyncPullError(
        `no source registered for recordType=${recordType}`,
        'NO_SOURCE',
      )
    }
    const folderPath = `/${this.appFolder}/${source.folderName}`

    let listResult
    const cursor = this.cursorFor(source.folderName)
    try {
      if (!cursor) {
        listResult = await this.dropbox.listFolder(folderPath)
      } else {
        listResult = await this.dropbox.listFolderContinue(cursor)
      }
    } catch (err) {
      this.emit('warn', {
        reason: 'list-folder-failed',
        recordType,
        cursor,
        message: err && err.message ? err.message : String(err),
      })
      return {
        status: 'ok',
        applied: 0,
        localWins: 0,
        skipped: 0,
        errors: 1,
        hasMore: false,
        cursor,
      }
    }

    const masterKey = this.vault.getMasterKey()
    if (!masterKey) {
      this.emit('paused', { reason: 'vault-locked' })
      return { status: 'vault-locked' }
    }

    const stats = { applied: 0, localWins: 0, skipped: 0, errors: 0 }
    const entries = (listResult && listResult.entries) || []

    for (const entry of entries) {
      if (entry.isFolder) {
        stats.skipped++
        continue
      }
      if (entry.isDeleted) {
        // Server-side hard-delete (e.g. GC sweep). We use soft-delete via
        // tombstone records, so any Dropbox-level delete is expected to
        // post-date the tombstone we already processed.
        stats.skipped++
        continue
      }
      if (!entry.pathDisplay) {
        stats.skipped++
        continue
      }

      let buf
      try {
        buf = await this.dropbox.download(entry.pathDisplay)
      } catch (err) {
        this.emit('warn', {
          reason: 'download-failed',
          path: entry.pathDisplay,
          message: err && err.message ? err.message : String(err),
        })
        stats.errors++
        continue
      }

      let header, body
      try {
        ;({ header, body } = decodeRecord(masterKey, buf))
      } catch (err) {
        this.emit('warn', {
          reason: 'decode-failed',
          path: entry.pathDisplay,
          message: err && err.message ? err.message : String(err),
          code: err && err.code,
        })
        stats.errors++
        continue
      }

      if (header.recordType !== recordType) {
        this.emit('warn', {
          reason: 'record-type-mismatch',
          path: entry.pathDisplay,
          expected: recordType,
          got: header.recordType,
        })
        stats.errors++
        continue
      }

      // Skip our own uploads — same device, same state already locally.
      if (header.deviceFolder === this.deviceFolder) {
        stats.skipped++
        continue
      }

      // Build a local header from the current record (if any) for LWW.
      const localRecord = source.fetchRecord(header.recordId)
      const localHeader = localRecord
        ? {
            schemaVersion: SCHEMA_VERSION,
            updatedAt: localRecord.updatedAt,
            deviceFolder: this.deviceFolder,
            recordType,
            recordId: header.recordId,
            deleted: false,
          }
        : null

      let merge
      try {
        merge = mergeRecords(localHeader, header)
      } catch (err) {
        this.emit('warn', {
          reason: 'merge-failed',
          path: entry.pathDisplay,
          message: err.message,
        })
        stats.errors++
        continue
      }

      if (merge.action === 'take-remote') {
        const action = header.deleted ? 'delete' : 'upsert'
        this.emit('remote-apply', {
          recordType,
          action,
          recordId: header.recordId,
          header,
          body, // null for tombstones
        })
        stats.applied++
      } else if (merge.action === 'keep-local') {
        this.emit('local-wins', { recordType, header, reason: merge.reason })
        stats.localWins++
      } else {
        // 'noop' — already in sync
        stats.skipped++
      }
    }

    // Persist the new cursor for next time. Even if entries were empty,
    // the cursor advances and we want to record that.
    const nextCursor = (listResult && listResult.cursor) || cursor || null
    if (nextCursor) {
      this._state.cursors[source.folderName] = nextCursor
      this.saveState()
    }

    return {
      status: 'ok',
      ...stats,
      hasMore: !!(listResult && listResult.hasMore),
      cursor: nextCursor,
    }
  }
}

module.exports = {
  SyncPuller,
  SyncPullError,
  SCHEMA_VERSION,
}
