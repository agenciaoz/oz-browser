// OZ Browser — Sync Merge (D-3a CORE).
//
// Pure conflict-resolution logic for the sync engine. Last-Write-Wins by
// `updatedAt`, deterministic lex desempate on equal timestamps by
// `deviceFolder` (LOWER deviceFolder wins). Tombstone-aware. Zero I/O —
// every input/output is a plain object so this module is trivially
// unit-testable.
//
// Spec: docs/architecture/0026-sync-engine.md §3 (conflict resolution),
//       §9 (tombstones + GC).
//
// Consumer: browser/sync-engine.js (D-3b/c) calls mergeRecords() once per
// remote/local record pair during pull or push pre-flight.
//
// Header shape (subset relevant to merge):
//   {
//     schemaVersion: number,                              // 1
//     updatedAt:     ISO 8601 string,                     // "2026-05-11T10:00:23.456Z"
//     deviceFolder:  string,                              // "mac-bff00ff9"
//     recordType:    'identity' | 'workspace' | 'bookmarks',
//     recordId:      string,
//     deleted:       boolean,
//     deletedAt?:    ISO 8601 string (only when deleted)
//   }

'use strict'

const TOMBSTONE_GC_DAYS = 30
const TOMBSTONE_GC_MS = TOMBSTONE_GC_DAYS * 24 * 60 * 60 * 1000

/**
 * Compare two ISO 8601 timestamps. Returns -1 / 0 / 1 as Date(a) < / === / > Date(b).
 * Throws on unparseable input — last line of defense; callers should
 * validate upstream via assertValidHeader.
 */
function compareTimestamps(a, b) {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) {
    throw new Error(`compareTimestamps: invalid updatedAt "${a}"`)
  }
  if (Number.isNaN(tb)) {
    throw new Error(`compareTimestamps: invalid updatedAt "${b}"`)
  }
  if (ta < tb) return -1
  if (ta > tb) return 1
  return 0
}

/**
 * Decide which side wins given two record headers. Idempotent on every
 * device given the same inputs — equal updatedAt is broken deterministically
 * by lex order on `deviceFolder` (LOWER deviceFolder wins, per ADR 0026 §3.3).
 *
 * Returns one of:
 *   { action: 'keep-local',  reason }  — local wins; sync engine should
 *                                        ensure remote eventually mirrors.
 *   { action: 'take-remote', reason }  — remote wins; sync engine should
 *                                        overwrite local with remote.
 *   { action: 'noop',        reason }  — already in sync (same content
 *                                        AND same provenance); skip.
 *
 * Edge cases (ADR §3 + §9):
 *   - local null + remote present       → 'take-remote'   (download)
 *   - local present + remote null       → 'keep-local'    (upload)
 *   - both null                         → 'noop'
 *   - same device, same ts              → 'noop'          (idempotent)
 *   - local.deleted XOR remote.deleted  → newer wins
 *                                        (edit-after-delete resurrects)
 *   - both deleted                      → newer wins; equal ts noop
 *
 * Headers are NOT mutated. Callers can read the returned reason for logging.
 */
function mergeRecords(local, remote) {
  if (!local && !remote) {
    return { action: 'noop', reason: 'both-missing' }
  }
  if (!local) {
    return { action: 'take-remote', reason: 'local-missing' }
  }
  if (!remote) {
    return { action: 'keep-local', reason: 'remote-missing' }
  }

  const cmp = compareTimestamps(local.updatedAt, remote.updatedAt)

  if (cmp > 0) {
    return { action: 'keep-local', reason: 'local-newer' }
  }
  if (cmp < 0) {
    return { action: 'take-remote', reason: 'remote-newer' }
  }

  // Equal timestamp — break by deviceFolder lex order (LOWER wins).
  if (local.deviceFolder == null || remote.deviceFolder == null) {
    throw new Error(
      'mergeRecords: equal updatedAt requires both sides to declare deviceFolder',
    )
  }
  if (local.deviceFolder === remote.deviceFolder) {
    // Same device, same timestamp → same write. Idempotent no-op even when
    // both sides are tombstones.
    return { action: 'noop', reason: 'identical-provenance' }
  }
  if (local.deviceFolder < remote.deviceFolder) {
    return { action: 'keep-local', reason: 'tied-lex-local' }
  }
  return { action: 'take-remote', reason: 'tied-lex-remote' }
}

/**
 * True when a tombstone is older than the GC window (30 days per ADR 0026 §9).
 * Used by the sync engine's periodic sweep to know which tombstone files are
 * safe to hard-delete from Dropbox. A NON-tombstone header returns false
 * regardless of age.
 *
 * @param {object} header - the record's tombstone header.
 * @param {number} [now=Date.now()] - inject for tests.
 */
function isTombstoneGcEligible(header, now = Date.now()) {
  if (!header || header.deleted !== true) return false
  if (typeof header.deletedAt !== 'string') return false
  const t = Date.parse(header.deletedAt)
  if (Number.isNaN(t)) return false
  return now - t >= TOMBSTONE_GC_MS
}

/**
 * Validate a record header against the minimum sync schema. Throws a
 * descriptive Error on the first violation. Cheap to call before every
 * push or after every decode.
 *
 * Returns true on success (chainable in assertions).
 */
function assertValidHeader(header) {
  if (header == null || typeof header !== 'object') {
    throw new Error('header must be an object')
  }
  if (
    typeof header.schemaVersion !== 'number' ||
    !Number.isInteger(header.schemaVersion) ||
    header.schemaVersion < 1
  ) {
    throw new Error('header.schemaVersion must be a positive integer')
  }
  if (
    typeof header.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(header.updatedAt))
  ) {
    throw new Error('header.updatedAt must be an ISO 8601 string')
  }
  if (typeof header.deviceFolder !== 'string' || header.deviceFolder.length < 2) {
    throw new Error('header.deviceFolder must be a non-empty string (>=2 chars)')
  }
  if (typeof header.recordType !== 'string' || header.recordType.length < 1) {
    throw new Error('header.recordType must be a non-empty string')
  }
  if (typeof header.recordId !== 'string' || header.recordId.length < 1) {
    throw new Error('header.recordId must be a non-empty string')
  }
  if (typeof header.deleted !== 'boolean') {
    throw new Error('header.deleted must be a boolean')
  }
  if (header.deleted && header.deletedAt !== undefined) {
    if (
      typeof header.deletedAt !== 'string' ||
      Number.isNaN(Date.parse(header.deletedAt))
    ) {
      throw new Error('header.deletedAt (if present) must be an ISO 8601 string')
    }
  }
  return true
}

module.exports = {
  mergeRecords,
  compareTimestamps,
  isTombstoneGcEligible,
  assertValidHeader,
  TOMBSTONE_GC_DAYS,
  TOMBSTONE_GC_MS,
}
