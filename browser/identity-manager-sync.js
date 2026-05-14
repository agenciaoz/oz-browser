// OZ Browser — IdentityManager remote-apply helpers (D-3c-3a CORE).
//
// Standalone functions that mutate an IdentityManager's state in response
// to remote sync events, WITHOUT emitting 'changed' (which would feed back
// into the sync engine and create an infinite remote → local → push →
// remote loop). They emit 'remote-applied' on the manager instead, so UI
// consumers can still react.
//
// Why a separate module (not methods on IdentityManager)? ADR 0005 caps
// files at 500 LOC; identity-manager.js is at the limit. These helpers
// are only called by the sync host wire-up (D-3c-3b: main.js +
// sync-setup.js), so they live near the boundary they serve.
//
// Wire-up pattern (D-3c-3b):
//   const im = new IdentityManager()
//   syncPuller.on('remote-apply', (evt) => {
//     if (evt.action === 'upsert') {
//       applyRemoteUpsert(im, evt.body)
//     } else if (evt.action === 'delete') {
//       applyRemoteDelete(im, evt.recordId, evt.header.deletedAt)
//     }
//   })
//
// Spec: docs/architecture/0026-sync-engine.md §4 (pull-side apply).

'use strict'

const log = require('./logger')

function _nowIso() {
  return new Date().toISOString()
}

function _emitRemoteApplied(im, payload) {
  try {
    im.emit('remote-applied', payload)
  } catch (err) {
    log.warn('identity-manager-sync', "'remote-applied' listener threw", {
      op: payload && payload.op,
      recordId: payload && payload.recordId,
      message: err.message,
    })
  }
}

/**
 * Apply a remote upsert (from sync-pull's 'remote-apply' event) to a local
 * IdentityManager WITHOUT emitting 'changed'.
 *
 * The 'default' identity is rejected: it's a per-device singleton.
 * Records without a valid ISO `updatedAt` are backfilled defensively
 * with the current time.
 *
 * @param {IdentityManager} im
 * @param {object} record - decoded body from the remote record. Must
 *   carry at least `id` (string).
 * @returns {{op: 'create'|'update', identity}|null} null on rejection.
 */
function applyRemoteUpsert(im, record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string') {
    // H-1: never log the full record — identity records carry
    // `fingerprintSeed` (entropy source for anti-detection) which must not
    // hit disk logs. Log only metadata.
    log.warn('identity-manager-sync', 'applyRemoteUpsert: invalid record', {
      recordType: typeof record,
      hasId: !!(record && typeof record.id === 'string'),
    })
    return null
  }
  if (record.id === 'default') {
    log.warn('identity-manager-sync', 'applyRemoteUpsert: refusing Default', {
      remoteUpdatedAt: record.updatedAt,
    })
    return null
  }
  const updatedAt =
    typeof record.updatedAt === 'string' && !Number.isNaN(Date.parse(record.updatedAt))
      ? record.updatedAt
      : _nowIso()

  const existing = im.identities.find((i) => i.id === record.id)
  const op = existing ? 'update' : 'create'
  if (existing) {
    // Whole-record replace via in-place mutation (preserves any identity
    // references the host holds). isDefault is forced to false — a remote
    // upload should never be able to claim Default.
    Object.keys(existing).forEach((k) => {
      if (k !== 'id') delete existing[k]
    })
    Object.assign(existing, record, { isDefault: false, updatedAt })
  } else {
    im.identities.push({ ...record, isDefault: false, updatedAt })
  }
  im._save()
  log.info('identity-manager-sync', `applyRemoteUpsert ${op}`, {
    id: record.id,
    name: record.name,
    workspaceId: record.workspaceId,
  })
  if (op === 'create') {
    im._fireWorkspaceSync('add', record.id, null, record.workspaceId)
  }
  const applied = im.get(record.id)
  _emitRemoteApplied(im, {
    op,
    recordType: 'identity',
    recordId: record.id,
    identity: { ...applied },
  })
  return { op, identity: { ...applied } }
}

/**
 * Apply a remote tombstone (from sync-pull's 'remote-apply' event) to a
 * local IdentityManager WITHOUT emitting 'changed'. Idempotent.
 *
 * @param {IdentityManager} im
 * @param {string} recordId
 * @param {string} [deletedAt] - ISO timestamp; informational only.
 * @returns {{op: 'delete', identityId}|null}
 */
function applyRemoteDelete(im, recordId, deletedAt) {
  if (typeof recordId !== 'string' || recordId.length < 1) {
    log.warn('identity-manager-sync', 'applyRemoteDelete: invalid recordId', {
      recordId,
    })
    return null
  }
  if (recordId === 'default') {
    log.warn('identity-manager-sync', 'applyRemoteDelete: refusing Default', {
      deletedAt,
    })
    return null
  }
  const existing = im.identities.find((i) => i.id === recordId)
  if (!existing) {
    return null // already gone — idempotent
  }
  const wsId = existing.workspaceId
  im.identities = im.identities.filter((i) => i.id !== recordId)
  im.sessionCache.delete(recordId)
  im._save()
  log.info('identity-manager-sync', 'applyRemoteDelete', {
    id: recordId,
    deletedAt,
  })
  im._fireWorkspaceSync('remove', recordId, wsId, null)
  _emitRemoteApplied(im, {
    op: 'delete',
    recordType: 'identity',
    recordId,
    deletedAt,
  })
  return { op: 'delete', identityId: recordId }
}

module.exports = {
  applyRemoteUpsert,
  applyRemoteDelete,
}
