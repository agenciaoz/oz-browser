// OZ Browser — Scheduled action handler: bulk (v2 Etapa 2.1).
//
// Wires the v2 Bulk Runner into the v1 Scheduled Actions runner so users
// can say "every Monday 09:00, run IG Like on these 20 identities".
//
// The handler is intentionally THIN — it does NOT re-implement bulk
// execution. It just calls bulkRunner.run(spec), which returns a runId
// immediately (the actual work proceeds async, identity-by-identity,
// with anti-detect delays). The scheduled tick is therefore non-blocking
// even when the underlying run takes hours.
//
// Why thin: every bulk action (auto-login, rate-limit, retries) is
// already implemented in the runner. Duplicating any of that in a
// scheduled wrapper would diverge from the manual-Run path that Jose
// uses today and that has been tested in production. One code path =
// one set of bugs.
//
// Params shape stored in the scheduled action's `params` field:
//   {
//     spec: {
//       actionId: 'ig_like',           // required, must be a registered action
//       identityIds: ['id-1', 'id-2'], // required, 1..200 strings
//       params: { ... },               // optional, passed to the action
//       options: { minDelayMs, maxDelayMs }  // optional, anti-detect overrides
//     }
//   }
//
// Vault skip: if a bulk spec is for a platform action (ig_*, x_*, etc),
// the runner WILL need vault access for auto-login retries. To avoid
// queuing a bulk that's going to no-op all its items, we skip on locked
// vault — same policy as sync-push / backup-snapshot.
//
// Return shape (becomes lastResult.value):
//   { ok: true, runId: '<uuid>' }
//
// Doc: docs/modules/scheduled-action-bulk.md (TBD)

'use strict'

class ScheduledBulkError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'ScheduledBulkError'
  }
}

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Returns an async handler for `bulk`. The handler:
 *   - Validates params.spec (actionId string, identityIds array).
 *   - Optionally validates actionId against the registry (if provided)
 *     to surface typos as BAD_ACTION at create time, not at fire time.
 *   - Skips on locked vault (most bulk actions need vault for
 *     auto-login retries).
 *   - Delegates to bulkRunner.run(spec) and returns the runId.
 *
 * @param {object} deps
 * @param {{run: (spec: object) => Promise<string>}} deps.bulkRunner
 * @param {{get?: (actionId: string) => any}} [deps.bulkActionsRegistry]
 *   Optional registry probe for early actionId validation.
 * @param {{isLocked?: () => boolean}} [deps.vault]
 */
function createBulkHandler({ bulkRunner, bulkActionsRegistry, vault } = {}) {
  if (!bulkRunner || typeof bulkRunner.run !== 'function') {
    throw new ScheduledBulkError('createBulkHandler: bulkRunner.run required', 'BAD_DEP')
  }
  return async function bulkHandler(params) {
    const spec = params && params.spec
    if (!_isPlainObject(spec)) {
      throw new ScheduledBulkError('bulk requires params.spec (object)', 'BAD_PARAMS')
    }
    if (typeof spec.actionId !== 'string' || spec.actionId.length < 1) {
      throw new ScheduledBulkError(
        'bulk requires params.spec.actionId (string)',
        'BAD_ACTION_ID',
      )
    }
    if (!Array.isArray(spec.identityIds) || spec.identityIds.length < 1) {
      throw new ScheduledBulkError(
        'bulk requires params.spec.identityIds (non-empty array)',
        'BAD_IDENTITY_IDS',
      )
    }
    if (spec.identityIds.length > 200) {
      throw new ScheduledBulkError(
        'bulk: identityIds capped at 200 per run',
        'TOO_MANY_IDENTITIES',
      )
    }
    for (const id of spec.identityIds) {
      if (typeof id !== 'string' || id.length < 1) {
        throw new ScheduledBulkError(
          'bulk: every identityId must be a non-empty string',
          'BAD_IDENTITY_ID',
        )
      }
    }
    if (spec.params !== undefined && !_isPlainObject(spec.params)) {
      throw new ScheduledBulkError(
        'bulk: params.spec.params must be a plain object',
        'BAD_SPEC_PARAMS',
      )
    }
    if (spec.options !== undefined && !_isPlainObject(spec.options)) {
      throw new ScheduledBulkError(
        'bulk: params.spec.options must be a plain object',
        'BAD_SPEC_OPTIONS',
      )
    }
    // Early validation against the action registry — surfaces typos at
    // fire time as BAD_ACTION instead of letting the runner reject mid-flight.
    if (
      bulkActionsRegistry &&
      typeof bulkActionsRegistry.get === 'function' &&
      !bulkActionsRegistry.get(spec.actionId)
    ) {
      throw new ScheduledBulkError(
        `bulk: unknown actionId "${spec.actionId}" (not in registry)`,
        'UNKNOWN_BULK_ACTION',
      )
    }
    // Vault skip — bulk runs for platform actions need vault for
    // auto-login retries. echo / navigate don't, but skipping the
    // whole run when vault is locked is the conservative default.
    if (vault && typeof vault.isLocked === 'function' && vault.isLocked()) {
      return { skipped: true, reason: 'vault-locked' }
    }
    // Fire-and-forget — runner.run returns the runId immediately and
    // continues execution async per-identity. The scheduled tick is
    // therefore non-blocking.
    const runId = await bulkRunner.run({
      actionId: spec.actionId,
      identityIds: spec.identityIds.slice(),
      params: spec.params ? { ...spec.params } : {},
      options: spec.options ? { ...spec.options } : {},
    })
    return { ok: true, runId }
  }
}

const ACTION_BULK = 'bulk'

module.exports = {
  createBulkHandler,
  ScheduledBulkError,
  ACTION_BULK,
}
