// OZ Browser — Sync Bootstrap smoke test (D-3c-3c).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-bootstrap.smoketest.js
//
// Cubre el orchestrator que vive entre setupSync y main.js:
//   - constructor validation (browser, settingsManager, identityManager, vault)
//   - init() — disabled in settings → ok:true running:false (no build)
//   - init() — enabled but no Dropbox app → ok:false NEEDS_DROPBOX_APP
//   - init() — enabled but Dropbox not authed → ok:false NEEDS_REAUTH
//   - init() — enabled + authed → builds + starts (resume path, no cold-start)
//   - setEnabled(true) first time → cold-start enqueues all + firstEnableAt set
//   - setEnabled(true) again after disable → resume without re-cold-start
//   - setEnabled(false) → stops + persists
//   - setEnabled(true) returns NEEDS_DROPBOX_APP / NEEDS_REAUTH cleanly
//   - getStatus shape + queueDepth from queue.size()
//   - pullNow NOT_RUNNING when no build, success when running
//   - engine 'pushed' updates lastPushAt + broadcast
//   - engine 'push-failed' NEEDS_REAUTH sets needsReauth + alert
//   - puller 'remote-apply' updates lastPullAt + broadcast
//   - stop() idempotent + safe before build
//   - Cold-start with empty bookmarks doesn't enqueue bookmark op
//   - setEnabled with non-boolean is rejected by handler map

'use strict'

const {
  makeFakeSettings,
  makeFakeIdentityManager,
  makeFakeWorkspaceManager,
  makeFakeBookmarkManager,
  makeFakeDropbox,
  makeFakeDeviceInfo,
  makeFakeAlertManager,
  makeFakeSync,
  makeBrowser,
  makeRunner,
} = require('./_helpers-sync-bootstrap')

const { ok, run, summarize } = makeRunner()

const { createSyncBootstrap, SyncBootstrapError } = require('../browser/sync-bootstrap')

// ---------- Tests ----------------------------------------------------------

run('constructor validation', async () => {
  let threw
  try {
    createSyncBootstrap(null)
  } catch (e) {
    threw = e
  }
  ok('throws when browser missing', threw instanceof SyncBootstrapError)
  ok('error code BAD_ARG', threw && threw.code === 'BAD_ARG')

  try {
    threw = null
    createSyncBootstrap({})
  } catch (e) {
    threw = e
  }
  ok('throws when settingsManager missing', threw && threw.code === 'BAD_ARG')

  try {
    threw = null
    createSyncBootstrap({ settingsManager: makeFakeSettings() })
  } catch (e) {
    threw = e
  }
  ok('throws when identityManager missing', threw && threw.code === 'BAD_ARG')

  try {
    threw = null
    createSyncBootstrap({
      settingsManager: makeFakeSettings(),
      identityManager: makeFakeIdentityManager(),
    })
  } catch (e) {
    threw = e
  }
  ok('throws when accountVault missing', threw && threw.code === 'BAD_ARG')

  // Happy path constructor does not throw.
  let happy
  try {
    happy = createSyncBootstrap(makeBrowser(), { setupSync: () => makeFakeSync() })
  } catch (e) {
    happy = e
  }
  ok('happy-path constructor returns api', happy && typeof happy.init === 'function')
})

run('init() — disabled in settings', async () => {
  const browser = makeBrowser()
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = await sb.init()
  ok('returns ok:true running:false', r.ok === true && r.running === false)
  ok('sync not built', sb._getSync() === null)
})

run('init() — enabled but Dropbox app not configured', async () => {
  const settings = makeFakeSettings({ sync: { enabled: true, firstEnableAt: null } })
  const browser = makeBrowser({ settingsManager: settings, dropboxClient: null })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = await sb.init()
  ok('returns ok:false', r.ok === false)
  ok('reason NEEDS_DROPBOX_APP', r.reason === 'NEEDS_DROPBOX_APP')
  ok('sync not built', sb._getSync() === null)
})

run('init() — enabled but Dropbox not authenticated', async () => {
  const settings = makeFakeSettings({
    sync: { enabled: true, firstEnableAt: '2026-01-01T00:00:00Z' },
  })
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox({ authenticated: false }),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = await sb.init()
  ok('returns ok:false', r.ok === false)
  ok('reason NEEDS_REAUTH', r.reason === 'NEEDS_REAUTH')
  ok('status.needsReauth = true', sb.getStatus().needsReauth === true)
})

run('init() — enabled + authed → resume (no cold-start)', async () => {
  let setupCalls = 0
  const settings = makeFakeSettings({
    sync: { enabled: true, firstEnableAt: '2026-01-01T00:00:00Z' },
  })
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox({ authenticated: true }),
    deviceInfo: makeFakeDeviceInfo(),
    identityManager: makeFakeIdentityManager([
      { id: 'a', updatedAt: '2026-01-01T00:00:00Z' },
    ]),
  })
  const sb = createSyncBootstrap(browser, {
    setupSync: () => {
      setupCalls += 1
      return makeFakeSync()
    },
  })
  const r = await sb.init()
  ok('returns ok:true running:true', r.ok === true && r.running === true)
  ok('setupSync called once', setupCalls === 1)
  const sync = sb._getSync()
  // firstEnableAt was non-null → no cold-start (queue should be empty).
  ok('queue empty (no cold-start)', sync.queue.size() === 0)
})

run('setEnabled(true) first time — cold-start enqueues all', async () => {
  const settings = makeFakeSettings()
  const ids = [
    { id: 'id-1', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'id-2', updatedAt: '2026-01-02T00:00:00Z' },
  ]
  const wss = [{ id: 'ws-1', updatedAt: '2026-01-03T00:00:00Z' }]
  const bms = {
    id: 'all',
    updatedAt: '2026-01-04T00:00:00Z',
    bookmarks: [{ id: 'b1' }],
  }
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox({ authenticated: true }),
    deviceInfo: makeFakeDeviceInfo(),
    identityManager: makeFakeIdentityManager(ids),
    workspaceManager: makeFakeWorkspaceManager(wss),
    bookmarkManager: makeFakeBookmarkManager(bms),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = sb.setEnabled(true)
  ok('ok:true', r.ok === true)
  ok('coldStart:true', r.coldStart === true)
  ok('counts.identities = 2', r.counts.identities === 2)
  ok('counts.workspaces = 1', r.counts.workspaces === 1)
  ok('counts.bookmarks = 1', r.counts.bookmarks === 1)
  ok(
    'settings.sync.firstEnableAt is set',
    typeof settings._data.sync.firstEnableAt === 'string',
  )
  ok('settings.sync.enabled = true', settings._data.sync.enabled === true)
  const sync = sb._getSync()
  ok('queue size = 4 (2 ids + 1 ws + 1 bm)', sync.queue.size() === 4)
})

run('setEnabled(true) again after disable — no re-cold-start', async () => {
  const settings = makeFakeSettings({
    sync: { enabled: false, firstEnableAt: '2026-01-01T00:00:00Z' },
  })
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox({ authenticated: true }),
    deviceInfo: makeFakeDeviceInfo(),
    identityManager: makeFakeIdentityManager([
      { id: 'x', updatedAt: '2026-01-01T00:00:00Z' },
    ]),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = sb.setEnabled(true)
  ok('ok:true', r.ok === true)
  ok('coldStart:false', r.coldStart === false)
  ok('counts null', !r.counts)
  const sync = sb._getSync()
  ok('queue empty (resume only)', sync.queue.size() === 0)
})

run('setEnabled(false) — stops and persists', async () => {
  const settings = makeFakeSettings()
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  sb.setEnabled(true) // build + start
  const r = sb.setEnabled(false)
  ok('ok:true', r.ok === true)
  ok('enabled:false', r.enabled === false)
  ok('settings.sync.enabled = false', settings._data.sync.enabled === false)
  ok('sync not running', sb._getSync().isRunning() === false)
})

run('setEnabled — Dropbox not configured', async () => {
  const browser = makeBrowser({
    settingsManager: makeFakeSettings(),
    dropboxClient: null,
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = sb.setEnabled(true)
  ok('ok:false', r.ok === false)
  ok('reason NEEDS_DROPBOX_APP', r.reason === 'NEEDS_DROPBOX_APP')
})

run('setEnabled — Dropbox not authenticated', async () => {
  const browser = makeBrowser({
    settingsManager: makeFakeSettings(),
    dropboxClient: makeFakeDropbox({ authenticated: false }),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = sb.setEnabled(true)
  ok('ok:false', r.ok === false)
  ok('reason NEEDS_REAUTH', r.reason === 'NEEDS_REAUTH')
})

run('getStatus shape + dynamics', async () => {
  const settings = makeFakeSettings({
    sync: { enabled: true, firstEnableAt: '2026-01-01T00:00:00Z' },
  })
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
    identityManager: makeFakeIdentityManager([
      { id: 'x', updatedAt: '2026-01-01T00:00:00Z' },
    ]),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  await sb.init()
  const s = sb.getStatus()
  const expectKeys = [
    'configured',
    'dropboxConnected',
    'enabled',
    'running',
    'queueDepth',
    'vaultUnlocked',
    'needsReauth',
    'firstEnableAt',
    'lastPullAt',
    'lastPushAt',
    'lastError',
  ]
  ok(
    'all keys present',
    expectKeys.every((k) => Object.prototype.hasOwnProperty.call(s, k)),
  )
  ok('configured:true', s.configured === true)
  ok('dropboxConnected:true', s.dropboxConnected === true)
  ok('enabled:true', s.enabled === true)
  ok('running:true', s.running === true)
  ok('vaultUnlocked:true', s.vaultUnlocked === true)
  ok('queueDepth = 0', s.queueDepth === 0)
})

run('pullNow — NOT_RUNNING when no sync built', async () => {
  const browser = makeBrowser()
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = await sb.pullNow()
  ok('ok:false', r.ok === false)
  ok('reason NOT_RUNNING', r.reason === 'NOT_RUNNING')
})

run('pullNow — success when running', async () => {
  const settings = makeFakeSettings()
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  sb.setEnabled(true)
  const r = await sb.pullNow()
  ok('ok:true', r.ok === true)
  ok('result.identity defined', !!r.result && r.result.identity)
  ok('lastPullAt set', typeof sb.getStatus().lastPullAt === 'string')
})

run('engine pushed updates lastPushAt + broadcasts', async () => {
  const settings = makeFakeSettings()
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  sb.setEnabled(true)
  browser._broadcasts.length = 0
  sb._getSync().engine.emit('pushed', { op: { recordType: 'identity', recordId: 'a' } })
  ok('lastPushAt set', typeof sb.getStatus().lastPushAt === 'string')
  ok('broadcast emitted', browser._broadcasts.includes('oz:sync:changed'))
})

run('engine push-failed NEEDS_REAUTH sets flag + alert', async () => {
  const settings = makeFakeSettings()
  const alerts = makeFakeAlertManager()
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
    alertManager: alerts,
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  sb.setEnabled(true)
  alerts._added.length = 0
  sb._getSync().engine.emit('push-failed', { code: 'NEEDS_REAUTH', message: '401' })
  ok('needsReauth flag', sb.getStatus().needsReauth === true)
  ok('alert added', alerts._added.length >= 1)
  ok('alert severity urgent', alerts._added[0] && alerts._added[0].severity === 'urgent')
})

run('puller remote-apply updates lastPullAt', async () => {
  const settings = makeFakeSettings()
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  sb.setEnabled(true)
  sb._getSync().puller.emit('remote-apply', {
    action: 'upsert',
    recordType: 'identity',
    recordId: 'a',
    body: {},
  })
  ok('lastPullAt set', typeof sb.getStatus().lastPullAt === 'string')
})

run('stop() idempotent + safe before build', async () => {
  const browser = makeBrowser()
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  let threw
  try {
    sb.stop()
    sb.stop()
  } catch (e) {
    threw = e
  }
  ok('stop before build does not throw', !threw)
  // Now with a built sync.
  const browser2 = makeBrowser({
    settingsManager: makeFakeSettings(),
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb2 = createSyncBootstrap(browser2, { setupSync: () => makeFakeSync() })
  sb2.setEnabled(true)
  sb2.stop()
  sb2.stop()
  ok('stop after build is idempotent', sb2._getSync().isRunning() === false)
})

run('cold-start skips bookmarks when empty', async () => {
  const settings = makeFakeSettings()
  const browser = makeBrowser({
    settingsManager: settings,
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
    identityManager: makeFakeIdentityManager([
      { id: 'a', updatedAt: '2026-01-01T00:00:00Z' },
    ]),
    bookmarkManager: makeFakeBookmarkManager({
      id: 'all',
      updatedAt: '2026-01-01T00:00:00Z',
      bookmarks: [],
    }),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  const r = sb.setEnabled(true)
  ok('counts.bookmarks = 0 when empty', r.counts.bookmarks === 0)
  ok('queue size only 1 (the identity)', sb._getSync().queue.size() === 1)
})

// Handler-map + settings-manager tests live in
// `sync-bootstrap-handlers.smoketest.js` (sibling file, split per ADR 0005).

summarize()
