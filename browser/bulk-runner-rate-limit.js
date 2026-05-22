// OZ Browser — Bulk Runner rate-limit helpers (v2 sub-bloque 6).
//
// Lightweight wrappers around BulkRateLimit invoked by bulk-runner.js.
// Extracted from the runner per ADR 0005 LOC budget.

'use strict'

/**
 * Returns { skip: true, error } if the (identity, platform, action) would
 * exceed the daily cap. Returns null if allowed.
 *
 * Safe to call with rateLimit=null (always returns null).
 */
function checkBeforeItem(rateLimit, item, action) {
  if (!rateLimit) return null
  if (!action || !action.platform) return null
  const cap = rateLimit.getCap(action.platform, action.id)
  if (cap === Infinity) return null
  if (!rateLimit.wouldExceed(item.identityId, action.platform, action.id)) {
    return null
  }
  return {
    skip: true,
    error: {
      code: 'rate-limit',
      message: `identity hit daily cap (${cap}) for ${action.platform}/${action.id}`,
    },
  }
}

/**
 * Increment the counter after a successful action. No-op if rateLimit
 * absent or action lacks platform. Errors during increment are
 * swallowed (caller passes a logger to surface them).
 */
function incrementAfterSuccess(rateLimit, item, action, logger) {
  if (!rateLimit) return
  if (!action || !action.platform) return
  try {
    rateLimit.increment(item.identityId, action.platform, action.id)
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn('bulk-runner', 'rate-limit increment failed', {
        message: err.message,
      })
    }
  }
}

module.exports = {
  checkBeforeItem,
  incrementAfterSuccess,
}
