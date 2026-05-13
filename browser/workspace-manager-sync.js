// OZ Browser — WorkspaceManager remote-apply helpers (D-4 mini CORE).
//
// Standalone functions that mutate a WorkspaceManager's state in response
// to remote sync events, WITHOUT emitting 'changed' (which would feed back
// into the sync engine and create an infinite remote → local → push →
// remote loop). They emit 'remote-applied' on the manager instead, so UI
// consumers can still react.
//
// Mirrors browser/identity-manager-sync.js — same pattern, same contract.
//
// Privacy carveout for tabSpecs / activeTabId:
//   The remote record may carry tabSpecs[] (URLs + titles of the team
//   member's open tabs at push time) — that's session state, not shared
//   team config. On apply we STRIP those fields and preserve the LOCAL
//   tabSpecs / activeTabId. This matches ADR 0026 §1 "Cookies + history
//   quedan FUERA del sync v1" — tab URLs sit in the same privacy bucket.
//
// Wire-up pattern (D-3c-3b sync-setup.js):
//   puller.on('remote-apply', (evt) => {
//     if (evt.recordType !== 'workspace') return
//     if (evt.action === 'upsert') applyRemoteUpsert(wm, evt.body)
//     else if (evt.action === 'delete') applyRemoteDelete(wm, evt.recordId, evt.header.deletedAt)
//   })
//
// Spec: docs/architecture/0026-sync-engine.md §4 (pull-side apply), §1
//       (carveout: cookies/session NOT synced).

'use strict'

const log = require('./logger')

const DEFAULT_WORKSPACE_ID = 'general'

function _nowIso() {
  return new Date().toISOString()
}

function _emitRemoteApplied(wm, payload) {
  try {
    wm.emit('remote-applied', payload)
  } catch (err) {
    log.warn('workspace-manager-sync', "'remote-applied' listener threw", {
      op: payload && payload.op,
      recordId: payload && payload.recordId,
      message: err.message,
    })
  }
}

/**
 * Apply a remote upsert (from sync-pull's 'remote-apply' event) to a local
 * WorkspaceManager WITHOUT emitting 'changed'.
 *
 * The 'general' workspace (DEFAULT_WORKSPACE_ID) is rejected: it's a
 * per-device singleton like Default identity. Records without a valid ISO
 * `updatedAt` are backfilled defensively.
 *
 * tabSpecs / activeTabId from the remote record are STRIPPED — see the
 * privacy carveout in the module docstring. Local tabSpecs / activeTabId
 * are preserved.
 *
 * @param {WorkspaceManager} wm
 * @param {object} record - decoded body from the remote record. Must carry
 *   `id` (string).
 * @returns {{op: 'create'|'update', workspace}|null} null on rejection.
 */
function applyRemoteUpsert(wm, record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string') {
    log.warn('workspace-manager-sync', 'applyRemoteUpsert: invalid record', {
      record,
    })
    return null
  }
  if (record.id === DEFAULT_WORKSPACE_ID) {
    log.warn('workspace-manager-sync', 'applyRemoteUpsert: refusing General singleton', {
      remoteUpdatedAt: record.updatedAt,
    })
    return null
  }
  const updatedAt =
    typeof record.updatedAt === 'string' && !Number.isNaN(Date.parse(record.updatedAt))
      ? record.updatedAt
      : _nowIso()

  // Privacy carveout: never copy remote tabSpecs / activeTabId.
  const sanitized = {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : 'Synced Workspace',
    color: typeof record.color === 'string' ? record.color : '#5b8def',
    isDefault: false, // remote can never claim default
    isArchived: !!record.isArchived,
    isFrozen: !!record.isFrozen,
    quickTabsMode:
      typeof record.quickTabsMode === 'string' ? record.quickTabsMode : 'on-click',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    updatedAt,
    identityIds: Array.isArray(record.identityIds) ? record.identityIds.slice() : [],
  }

  const existing = wm.workspaces.find((w) => w.id === record.id)
  const op = existing ? 'update' : 'create'
  if (existing) {
    // In-place merge — preserve local tabSpecs / activeTabId.
    const localTabSpecs = Array.isArray(existing.tabSpecs) ? existing.tabSpecs : []
    const localActiveTabId = existing.activeTabId
    Object.keys(existing).forEach((k) => {
      if (k !== 'id') delete existing[k]
    })
    Object.assign(existing, sanitized, {
      tabSpecs: localTabSpecs,
      activeTabId: localActiveTabId,
    })
  } else {
    wm.workspaces.push({
      ...sanitized,
      tabSpecs: [],
      activeTabId: null,
    })
  }
  // WorkspaceManager has _saveNow (atomic) and _save (debounced). Use
  // _saveNow to guarantee the remote-applied state hits disk before we emit.
  wm._saveNow()
  log.info('workspace-manager-sync', `applyRemoteUpsert ${op}`, {
    id: record.id,
    name: sanitized.name,
  })
  const applied = wm.get(record.id)
  _emitRemoteApplied(wm, {
    op,
    recordType: 'workspace',
    recordId: record.id,
    workspace: applied,
  })
  return { op, workspace: applied }
}

/**
 * Apply a remote tombstone to a local WorkspaceManager WITHOUT emitting
 * 'changed'. Idempotent.
 *
 * NOTE: if the local workspace has identities, this still removes the
 * workspace. The identityIds[] are NOT cascaded here — the sync layer
 * will land identity deletes separately (each identity has its own
 * tombstone). For now the local IM may briefly reference a missing
 * workspace; the next pull tick reconciles. A future polish (D-4+) can
 * add a cascade hook similar to WorkspaceManager.remove.
 *
 * @param {WorkspaceManager} wm
 * @param {string} recordId
 * @param {string} [deletedAt] - ISO timestamp; informational only.
 * @returns {{op: 'delete', workspaceId}|null}
 */
function applyRemoteDelete(wm, recordId, deletedAt) {
  if (typeof recordId !== 'string' || recordId.length < 1) {
    log.warn('workspace-manager-sync', 'applyRemoteDelete: invalid recordId', {
      recordId,
    })
    return null
  }
  if (recordId === DEFAULT_WORKSPACE_ID) {
    log.warn('workspace-manager-sync', 'applyRemoteDelete: refusing General singleton', {
      deletedAt,
    })
    return null
  }
  const existing = wm.workspaces.find((w) => w.id === recordId)
  if (!existing) {
    return null // already gone — idempotent
  }
  wm.workspaces = wm.workspaces.filter((w) => w.id !== recordId)
  wm._saveNow()
  log.info('workspace-manager-sync', 'applyRemoteDelete', {
    id: recordId,
    deletedAt,
  })
  _emitRemoteApplied(wm, {
    op: 'delete',
    recordType: 'workspace',
    recordId,
    deletedAt,
  })
  return { op: 'delete', workspaceId: recordId }
}

module.exports = {
  applyRemoteUpsert,
  applyRemoteDelete,
  DEFAULT_WORKSPACE_ID,
}
