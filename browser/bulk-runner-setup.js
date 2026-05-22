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
const { buildIgLikeAction } = require('./bulk-actions-ig-like')
const { buildIgFollowAction } = require('./bulk-actions-ig-follow')
const { buildXPostAction } = require('./bulk-actions-x-post')
const { buildXLikeAction } = require('./bulk-actions-x-like')
const { buildTiktokLikeAction } = require('./bulk-actions-tiktok-like')
const { buildTiktokFollowAction } = require('./bulk-actions-tiktok-follow')
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
  if (!registry.get('ig_like')) {
    registry.register(
      buildIgLikeAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('ig_follow')) {
    registry.register(
      buildIgFollowAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('x_post')) {
    registry.register(
      buildXPostAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('x_like')) {
    registry.register(
      buildXLikeAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('tiktok_like')) {
    registry.register(
      buildTiktokLikeAction({
        identityManager: browser.identityManager,
        electron: opts.electron || _safeRequireElectron(),
      }),
    )
  }
  if (!registry.get('tiktok_follow')) {
    registry.register(
      buildTiktokFollowAction({
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
    // v2 sub-bloque 4: lazy accountsAPI thunk — account handlers are built
    // by ipc-handlers.js AFTER setupBulkRunner runs, so we resolve at the
    // moment we actually need it (on needs_login auto-login retry).
    accountsAPI: () => (browser.handlers && browser.handlers.accounts) || null,
    electron,
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
