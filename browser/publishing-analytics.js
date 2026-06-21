// OZ Browser — Publishing analytics (E7 pulido). Pure, dependency-free.
//
// Computes success rates over bulk-run records produced by publishing actions
// (ig_post / x_post / fb_post). MCP-first: the agent asks "how are my posts
// doing?" and gets success-by-network / by-identity / by-hour without the UI.
//
// A record is the shape returned by BulkRunner.get():
//   { meta: { actionId, createdAt, ... }, items: [{ identityId, status,
//     startedAt, finishedAt }] }
// Item status: done | failed | skipped | cancelled | pending. Success rate is
// done / (done + failed) — skipped/cancelled/pending don't count either way.
//
// Dual-export (node require + browser window.OZ.publishingAnalytics).
//
// ADR: 0038 (publishing-studio) · 0005 (modular).

;(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    const root = typeof window !== 'undefined' ? window : globalThis
    root.OZ = root.OZ || {}
    root.OZ.publishingAnalytics = factory()
  }
})(function () {
  'use strict'

  const PUBLISH_ACTIONS = ['ig_post', 'x_post', 'fb_post']
  // actionId → human network label.
  const NETWORK_BY_ACTION = {
    ig_post: 'instagram',
    x_post: 'x',
    fb_post: 'facebook',
  }

  function _rate(done, failed) {
    const denom = done + failed
    return denom === 0 ? 0 : Math.round((done / denom) * 1000) / 1000
  }

  function _emptyBucket() {
    return { items: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 }
  }

  function _tally(bucket, status) {
    bucket.items++
    if (status === 'done') bucket.done++
    else if (status === 'failed') bucket.failed++
    else if (status === 'skipped') bucket.skipped++
    else if (status === 'cancelled') bucket.cancelled++
  }

  function _hourOf(item) {
    const ts = item.finishedAt || item.startedAt
    if (!ts) return null
    const d = new Date(ts)
    const h = d.getUTCHours()
    return Number.isNaN(h) ? null : h
  }

  function _withRate(bucket) {
    return { ...bucket, successRate: _rate(bucket.done, bucket.failed) }
  }

  /**
   * Compute publishing analytics over an array of run records.
   *
   * @param {Array<object>} records  BulkRunner.get()-shaped records.
   * @param {object} [opts]
   * @param {string[]} [opts.actions]  actionIds to include (default publish set).
   * @returns {{
   *   overall, byNetwork:{[net]:bucket}, byIdentity:{[id]:bucket},
   *   byHour:Array<{hour,...bucket}>
   * }} each bucket carries successRate.
   */
  function computeAnalytics(records, opts = {}) {
    const include = new Set(
      Array.isArray(opts.actions) && opts.actions.length ? opts.actions : PUBLISH_ACTIONS,
    )
    const overall = _emptyBucket()
    overall.runs = 0
    const byNetwork = {}
    const byIdentity = {}
    const hours = Array.from({ length: 24 }, () => _emptyBucket())

    for (const rec of Array.isArray(records) ? records : []) {
      const meta = (rec && rec.meta) || {}
      if (!include.has(meta.actionId)) continue
      const net = NETWORK_BY_ACTION[meta.actionId] || meta.actionId
      overall.runs++
      const items = Array.isArray(rec.items) ? rec.items : []
      for (const it of items) {
        const status = it && it.status
        _tally(overall, status)
        byNetwork[net] = byNetwork[net] || _emptyBucket()
        _tally(byNetwork[net], status)
        if (it && it.identityId) {
          byIdentity[it.identityId] = byIdentity[it.identityId] || _emptyBucket()
          _tally(byIdentity[it.identityId], status)
        }
        const h = _hourOf(it)
        if (h != null) _tally(hours[h], status)
      }
    }

    const byHour = hours
      .map((b, hour) => ({ hour, ..._withRate(b) }))
      .filter((b) => b.items > 0)

    return {
      overall: _withRate(overall),
      byNetwork: _mapRates(byNetwork),
      byIdentity: _mapRates(byIdentity),
      byHour,
    }
  }

  function _mapRates(obj) {
    const out = {}
    for (const k of Object.keys(obj)) out[k] = _withRate(obj[k])
    return out
  }

  /** The hour (0-23 UTC) with the best success rate (min 1 attempt). */
  function bestHour(analytics) {
    const hrs = (analytics && analytics.byHour) || []
    let best = null
    for (const h of hrs) {
      if (h.done + h.failed === 0) continue
      if (!best || h.successRate > best.successRate) best = h
    }
    return best
  }

  return {
    PUBLISH_ACTIONS,
    NETWORK_BY_ACTION,
    computeAnalytics,
    bestHour,
  }
})
