// OZ Browser — Bulk Runner IPC handlers (v2 sub-bloque 1).
//
// Wire-up entre el preload bridge (`window.oz.bulk.*`) y el motor
// `BulkRunner`. Sigue el mismo pattern que `identity-handlers.js` etc.
//
// Eventos broadcast a la UI:
//   - oz:bulk:created          { runId, meta }
//   - oz:bulk:started          { runId, meta }
//   - oz:bulk:progress         { runId, item, index, total }
//   - oz:bulk:completed        { runId, meta }
//   - oz:bulk:cancelling       { runId }
//
// Doc: docs/modules/bulk-handlers.md

'use strict'

const licenseManager = require('./license-manager')

function buildBulkHandlers(browser) {
  const runner = browser.bulkRunner
  if (!runner) throw new Error('buildBulkHandlers: browser.bulkRunner required')
  const registry = browser.bulkActionsRegistry
  if (!registry) {
    throw new Error('buildBulkHandlers: browser.bulkActionsRegistry required')
  }

  // Wire runner events → UI broadcast.
  if (!runner._wiredToBroadcast) {
    runner._wiredToBroadcast = true
    runner.on('created', (e) => browser.broadcastToWebUI('oz:bulk:created', e))
    runner.on('started', (e) => browser.broadcastToWebUI('oz:bulk:started', e))
    runner.on('progress', (e) => browser.broadcastToWebUI('oz:bulk:progress', e))
    runner.on('completed', (e) => {
      browser.broadcastToWebUI('oz:bulk:completed', e)
      const m = (e && e.meta) || {}
      licenseManager.reportEvent('bulk-run', {
        actionId: m.actionId,
        status: m.status,
        stats: m.stats,
      })
    })
    runner.on('cancelling', (e) => browser.broadcastToWebUI('oz:bulk:cancelling', e))
  }

  return {
    listActions() {
      return registry.list()
    },
    // v2 Etapa 2.2 — rate-limit stats exposed for UI / MCP.
    // Returns: { asOf, entries:[{identityId, platform, actionId, day, count, cap, remaining}] }
    // If opts.identityId is set, filter to that identity.
    rateLimitStats(opts = {}) {
      const rl = browser.bulkRateLimit
      if (!rl) {
        return {
          __error: {
            code: 'NOT_AVAILABLE',
            message: 'rate-limit registry not initialized',
          },
        }
      }
      const identityId =
        opts && typeof opts === 'object' && typeof opts.identityId === 'string'
          ? opts.identityId
          : undefined
      let raw
      try {
        raw = rl.stats(identityId)
      } catch (err) {
        return {
          __error: { code: err.code || 'ERROR', message: err.message },
        }
      }
      const entries = []
      for (const e of Object.values(raw || {})) {
        const platform = e.platform === '_' ? null : e.platform
        const actionId = e.actionId === '_' ? null : e.actionId
        const cap = rl.getCap(platform, actionId)
        const isFinite = cap !== Infinity && Number.isFinite(cap)
        entries.push({
          identityId: e.identityId,
          platform,
          actionId,
          day: e.day,
          count: e.count,
          cap: isFinite ? cap : null,
          remaining: isFinite ? Math.max(0, cap - e.count) : null,
        })
      }
      entries.sort(
        (a, b) =>
          (a.identityId || '').localeCompare(b.identityId || '') ||
          (a.platform || '').localeCompare(b.platform || '') ||
          (a.actionId || '').localeCompare(b.actionId || '') ||
          (a.day || '').localeCompare(b.day || ''),
      )
      const today = new Date().toISOString().slice(0, 10)
      return { asOf: today, entries }
    },
    async create(spec) {
      try {
        return await runner.create(spec || {})
      } catch (err) {
        return { __error: { code: err.code || 'ERROR', message: err.message } }
      }
    },
    start(runId) {
      try {
        runner.start(runId)
        return { ok: true }
      } catch (err) {
        return { __error: { code: err.code || 'ERROR', message: err.message } }
      }
    },
    async run(spec) {
      try {
        const runId = await runner.run(spec || {})
        return { ok: true, runId }
      } catch (err) {
        return { __error: { code: err.code || 'ERROR', message: err.message } }
      }
    },
    cancel(runId) {
      try {
        return { ok: true, cancelled: runner.cancel(runId) }
      } catch (err) {
        return { __error: { code: err.code || 'ERROR', message: err.message } }
      }
    },
    get(runId) {
      return runner.get(runId)
    },
    list() {
      return runner.list()
    },
  }
}

module.exports = { buildBulkHandlers }
