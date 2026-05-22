// OZ Browser — Bulk Runner setup glue (v2 sub-bloque 1).
//
// Mismo patrón que scheduled-setup.js: una función `setupBulkRunner` que
// main.js llama ANTES de registerIpcHandlers. Instancia el runner, registra
// las built-in actions, attach a `browser.bulkRunner` y
// `browser.bulkActionsRegistry`.
//
// Las actions reales (postear IG, comentar, like, etc.) se registran en
// sub-bloques siguientes — sub-bloque 1 solo expone `echo` para validar
// el motor end-to-end.

'use strict'

const log = require('./logger')
const registry = require('./bulk-actions-registry')
const { echoAction } = require('./bulk-actions-echo')
const { buildNavigateAction } = require('./bulk-actions-navigate')
const { buildIgCommentAction } = require('./bulk-actions-ig-comment')
const { buildIgPostAction } = require('./bulk-actions-ig-post')
const { BulkRunner } = require('./bulk-runner')

function setupBulkRunner(browser, opts = {}) {
  if (browser.bulkRunner) return browser.bulkRunner

  const electron = opts.electron || _safeRequireElectron()
  const userDataDir =
    opts.userDataDir ||
    (electron && electron.app ? electron.app.getPath('userData') : null)

  if (!userDataDir) {
    log.warn('bulk-runner-setup', 'no userDataDir; bulk runner disabled')
    return null
  }
  if (!browser.identityManager) {
    log.warn('bulk-runner-setup', 'no identityManager; bulk runner disabled')
    return null
  }

  // Register built-in actions exactly once per process. The registry is a
  // module-level singleton, so we guard with a flag.
  if (!registry.get('echo')) {
    registry.register(echoAction)
  }
  if (!registry.get('navigate')) {
    registry.register(
      buildNavigateAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('ig_comment')) {
    registry.register(
      buildIgCommentAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('ig_post')) {
    registry.register(
      buildIgPostAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }

  const runner = new BulkRunner({
    userDataDir,
    identityManager: browser.identityManager,
    registry,
    logger: log,
  })

  // Surface lifecycle events to the central log without flooding.
  runner.on('created', (e) => log.info('bulk-runner', 'created', { runId: e.runId }))
  runner.on('started', (e) => log.info('bulk-runner', 'started', { runId: e.runId }))
  runner.on('completed', (e) =>
    log.info('bulk-runner', 'completed', {
      runId: e.runId,
      status: e.meta.status,
      stats: e.meta.stats,
    }),
  )

  browser.bulkRunner = runner
  browser.bulkActionsRegistry = registry
  log.info('bulk-runner-setup', 'instantiated', {
    knownRuns: runner.list().length,
    registeredActions: registry.list().length,
  })
  return runner
}

function _safeRequireElectron() {
  try {
    return require('electron')
  } catch {
    return null
  }
}

module.exports = { setupBulkRunner }
