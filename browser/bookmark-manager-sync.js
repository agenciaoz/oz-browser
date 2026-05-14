// OZ Browser — BookmarkManager remote-apply helpers (D-4 mini b CORE).
//
// Standalone functions that apply a remote bookmark record to a local
// BookmarkManager WITHOUT emitting 'changed' (which would feed back into
// the sync engine and create an infinite remote → local → push → remote
// loop). They emit 'remote-applied' on the manager instead.
//
// Unlike identities and workspaces (per-record sync), bookmarks sync as
// a SINGLE record per ADR 0026 §1 — recordId='all', body is the entire
// bookmarks collection. The apply side replaces the local array
// wholesale; LWW is decided by sync-merge on the header's updatedAt.
//
// applyRemoteDelete on bookmarks is a no-op + warn. Deleting "all bookmarks"
// isn't a normal sync operation — bookmarks are added/removed individually
// (which trigger upserts of the new whole-collection), or the user clears
// their local bookmarks (which would publish an empty body, not a tombstone).
//
// Spec: docs/architecture/0026-sync-engine.md §1 (bookmarks full-file),
//       §4 (pull-side apply).

'use strict'

const log = require('./logger')

const BOOKMARKS_RECORD_ID = 'all'

function _nowIso() {
  return new Date().toISOString()
}

function _emitRemoteApplied(bm, payload) {
  try {
    bm.emit('remote-applied', payload)
  } catch (err) {
    log.warn('bookmark-manager-sync', "'remote-applied' listener threw", {
      message: err.message,
    })
  }
}

/**
 * Apply a remote bookmark collection to a local BookmarkManager WITHOUT
 * emitting 'changed'. Replaces the entire local bookmarks array with
 * body.bookmarks. Stamps bm._updatedAt from body.updatedAt (or nowIso
 * defensively) and persists.
 *
 * @param {BookmarkManager} bm
 * @param {object} body - decoded body. Must have `id === 'all'` and an
 *   array `bookmarks`. Records without an ISO `updatedAt` get backfilled.
 * @returns {{op: 'update', count}|null} null on rejection.
 */
function applyRemoteUpsert(bm, body) {
  if (!body || typeof body !== 'object') {
    // H-1: never log the full body — bookmark bodies carry the full URL
    // collection (browsing PII). Only metadata is safe.
    log.warn('bookmark-manager-sync', 'applyRemoteUpsert: invalid body', {
      bodyType: typeof body,
    })
    return null
  }
  if (body.id !== BOOKMARKS_RECORD_ID) {
    log.warn('bookmark-manager-sync', 'applyRemoteUpsert: unexpected recordId', {
      id: body.id,
    })
    return null
  }
  if (!Array.isArray(body.bookmarks)) {
    log.warn('bookmark-manager-sync', 'applyRemoteUpsert: bookmarks not an array', {
      type: typeof body.bookmarks,
    })
    return null
  }

  const updatedAt =
    typeof body.updatedAt === 'string' && !Number.isNaN(Date.parse(body.updatedAt))
      ? body.updatedAt
      : _nowIso()

  // Replace the whole collection. Defensive: skip entries missing required
  // fields (id, identityId, url) rather than corrupt local state.
  const filtered = body.bookmarks.filter(
    (b) =>
      b &&
      typeof b === 'object' &&
      typeof b.id === 'string' &&
      typeof b.identityId === 'string' &&
      typeof b.url === 'string',
  )
  const dropped = body.bookmarks.length - filtered.length
  if (dropped > 0) {
    log.warn('bookmark-manager-sync', 'applyRemoteUpsert: dropped malformed entries', {
      dropped,
    })
  }

  bm.bookmarks = filtered.map((b) => ({ ...b }))
  bm._updatedAt = updatedAt
  bm._save()
  bm._saveMeta()
  log.info('bookmark-manager-sync', 'applyRemoteUpsert', {
    count: bm.bookmarks.length,
    updatedAt,
  })
  _emitRemoteApplied(bm, {
    op: 'update',
    recordType: 'bookmark',
    recordId: BOOKMARKS_RECORD_ID,
    count: bm.bookmarks.length,
    updatedAt,
  })
  return { op: 'update', count: bm.bookmarks.length }
}

/**
 * Apply a remote tombstone — for bookmarks this is a no-op: deletion isn't
 * a meaningful collection-level op (individual removes round-trip as
 * upserts of the new whole-collection state). Warn + return null so the
 * sync engine doesn't think anything happened.
 */
function applyRemoteDelete(bm, recordId, deletedAt) {
  log.warn(
    'bookmark-manager-sync',
    'applyRemoteDelete: ignored (bookmarks have no tombstone)',
    {
      recordId,
      deletedAt,
    },
  )
  return null
}

module.exports = {
  applyRemoteUpsert,
  applyRemoteDelete,
  BOOKMARKS_RECORD_ID,
}
