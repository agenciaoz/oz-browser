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
    runner.on('completed', (e) => browser.broadcastToWebUI('oz:bulk:completed', e))
    runner.on('cancelling', (e) => browser.broadcastToWebUI('oz:bulk:cancelling', e))
  }

  return {
    listActions() {
      return registry.list()
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
