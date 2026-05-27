// OZ Browser — BulkNotifications smoke test (v2 Etapa 4.2).
//
// Run:
//   cd oz-browser
//   node tests/bulk-notifications.smoketest.js
//
// Covers (pure module — no Electron):
//   - formatMessage: title prefix per status, body omits zero buckets
//   - install/uninstall: subscribes to bulkRunner.on('completed')
//   - gate: skipped when settings.notifications.showOSAlert === false
//   - skip when Notification factory returns null
//   - skip when Notification.isSupported() === false
//   - click handler dispatches IPC oz:bulk-history:open-at-run

'use strict'

const { EventEmitter } = require('events')
const path = require('path')

delete require.cache[require.resolve('../browser/bulk-notifications.js')]
const { BulkNotifications } = require(path.join('..', 'browser', 'bulk-notifications.js'))

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, a === e ? '' : `got=${a} expected=${e}`)
}

function makeFakeNotification({ isSupported = true } = {}) {
  const log = []
  const handlers = []
  function FakeNotification(opts) {
    this.opts = opts
    this._handlers = {}
    log.push(opts)
    handlers.push(this)
  }
  FakeNotification.prototype.show = function () {
    this._shown = true
  }
  FakeNotification.prototype.on = function (evt, cb) {
    this._handlers[evt] = cb
  }
  FakeNotification.isSupported = () => isSupported
  return { Notification: FakeNotification, log, handlers }
}

function makeFakeBrowser() {
  const sent = []
  const broadcast = []
  const fakeWebContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  }
  const fakeWin = {
    webContents: fakeWebContents,
    focus: () => {
      fakeWin._focused = true
    },
  }
  return {
    sent,
    broadcast,
    fakeWin,
    getFocusedWindow: () => fakeWin,
    broadcastToWebUI: (channel, payload) => broadcast.push({ channel, payload }),
  }
}

function makeSettings(showOSAlert) {
  return {
    get: (section) => {
      if (section === 'notifications') return { showOSAlert }
      return null
    },
  }
}

console.log('--- formatMessage ---')

const bn = new BulkNotifications({
  bulkRunner: new EventEmitter(),
  browser: makeFakeBrowser(),
})

const m1 = bn.formatMessage({
  actionLabel: 'IG Like',
  status: 'completed',
  stats: { done: 3, failed: 1, skipped: 0, cancelled: 0 },
})
eq('completed title', m1.title, 'Bulk run finished — IG Like')
eq('body omits zero buckets', m1.body, '3 done · 1 failed')

const m2 = bn.formatMessage({
  actionLabel: 'IG Like',
  status: 'failed',
  stats: { done: 0, failed: 5, skipped: 0, cancelled: 0 },
})
eq('failed status uses "failed" prefix', m2.title, 'Bulk run failed — IG Like')
eq('only failed bucket shown', m2.body, '5 failed')

const m3 = bn.formatMessage({
  actionLabel: 'Echo',
  status: 'cancelled',
  stats: { done: 1, failed: 0, skipped: 0, cancelled: 4 },
})
eq('cancelled status uses "cancelled" prefix', m3.title, 'Bulk run cancelled — Echo')
eq('mixed buckets', m3.body, '1 done · 4 cancelled')

const m4 = bn.formatMessage({
  actionLabel: 'X Post',
  status: 'completed',
  stats: { done: 0, failed: 0, skipped: 0, cancelled: 0 },
})
eq('empty stats shows "no items"', m4.body, 'no items')

const m5 = bn.formatMessage({
  actionId: 'echo',
  status: 'completed',
  stats: { done: 2 },
})
eq('falls back to actionId when label missing', m5.title, 'Bulk run finished — echo')

console.log('\n--- install / event subscription ---')

{
  const runner = new EventEmitter()
  const fakeNotif = makeFakeNotification()
  const browser = makeFakeBrowser()
  const bnSub = new BulkNotifications({
    bulkRunner: runner,
    browser,
    notificationFactory: () => fakeNotif.Notification,
  })
  bnSub.install()
  runner.emit('completed', {
    runId: 'rX',
    meta: {
      actionLabel: 'Echo',
      status: 'completed',
      stats: { done: 1 },
    },
  })
  eq('subscribed to completed → one notification shown', fakeNotif.log.length, 1)
  eq('title built from meta', fakeNotif.log[0].title, 'Bulk run finished — Echo')

  // Idempotent install: second call must not double-subscribe.
  bnSub.install()
  runner.emit('completed', {
    runId: 'rY',
    meta: { actionLabel: 'Echo', status: 'completed', stats: { done: 1 } },
  })
  eq('install is idempotent (no double-fire)', fakeNotif.log.length, 2)

  // Uninstall stops the firing.
  bnSub.uninstall()
  runner.emit('completed', {
    runId: 'rZ',
    meta: { actionLabel: 'Echo', status: 'completed', stats: { done: 1 } },
  })
  eq('uninstall stops the listener', fakeNotif.log.length, 2)
}

console.log('\n--- settings gate ---')

{
  const runner = new EventEmitter()
  const fakeNotif = makeFakeNotification()
  const bnOff = new BulkNotifications({
    bulkRunner: runner,
    browser: makeFakeBrowser(),
    settingsManager: makeSettings(false),
    notificationFactory: () => fakeNotif.Notification,
  })
  bnOff.install()
  runner.emit('completed', {
    runId: 'r1',
    meta: { actionLabel: 'IG Like', status: 'completed', stats: { done: 1 } },
  })
  eq('showOSAlert=false suppresses notification', fakeNotif.log.length, 0)
}

{
  const runner = new EventEmitter()
  const fakeNotif = makeFakeNotification()
  const bnOn = new BulkNotifications({
    bulkRunner: runner,
    browser: makeFakeBrowser(),
    settingsManager: makeSettings(true),
    notificationFactory: () => fakeNotif.Notification,
  })
  bnOn.install()
  runner.emit('completed', {
    runId: 'r2',
    meta: { actionLabel: 'IG Like', status: 'completed', stats: { done: 1 } },
  })
  eq('showOSAlert=true allows notification', fakeNotif.log.length, 1)
}

console.log('\n--- factory edge cases ---')

{
  const runner = new EventEmitter()
  const bnNoFactory = new BulkNotifications({
    bulkRunner: runner,
    browser: makeFakeBrowser(),
    notificationFactory: () => null, // platform without Notification
  })
  bnNoFactory.install()
  let threw = false
  try {
    runner.emit('completed', {
      runId: 'r',
      meta: { actionLabel: 'x', status: 'completed', stats: {} },
    })
  } catch {
    threw = true
  }
  ok('null factory → silent skip (no throw)', threw === false)
}

{
  const runner = new EventEmitter()
  const fakeNotif = makeFakeNotification({ isSupported: false })
  const bnNotSupported = new BulkNotifications({
    bulkRunner: runner,
    browser: makeFakeBrowser(),
    notificationFactory: () => fakeNotif.Notification,
  })
  bnNotSupported.install()
  runner.emit('completed', {
    runId: 'r',
    meta: { actionLabel: 'x', status: 'completed', stats: { done: 1 } },
  })
  eq('isSupported()=false → no notification constructed', fakeNotif.log.length, 0)
}

console.log('\n--- click handler dispatches IPC ---')

{
  const runner = new EventEmitter()
  const fakeNotif = makeFakeNotification()
  const browser = makeFakeBrowser()
  const bnClick = new BulkNotifications({
    bulkRunner: runner,
    browser,
    notificationFactory: () => fakeNotif.Notification,
  })
  bnClick.install()
  runner.emit('completed', {
    runId: 'click-run-id',
    meta: { actionLabel: 'IG Like', status: 'completed', stats: { done: 1 } },
  })
  // Simulate user clicking the notification.
  const n = fakeNotif.handlers[0]
  ok('notification registered a click handler', typeof n._handlers.click === 'function')
  n._handlers.click()
  eq(
    'click → IPC channel correct',
    browser.sent.length === 1 && browser.sent[0].channel,
    'oz:bulk-history:open-at-run',
  )
  eq('click → payload contains runId', browser.sent[0].payload, {
    runId: 'click-run-id',
  })
  ok('click focuses the window', browser.fakeWin._focused === true)
}

console.log('\n--- edge: missing meta ---')

{
  const runner = new EventEmitter()
  const fakeNotif = makeFakeNotification()
  const bnNoMeta = new BulkNotifications({
    bulkRunner: runner,
    browser: makeFakeBrowser(),
    notificationFactory: () => fakeNotif.Notification,
  })
  bnNoMeta.install()
  let threw = false
  try {
    runner.emit('completed', { runId: 'r' }) // no meta
    runner.emit('completed', { runId: 'r', meta: null })
  } catch {
    threw = true
  }
  ok('missing meta → silent skip (no throw)', threw === false)
  eq('missing meta → no notification', fakeNotif.log.length, 0)
}

console.log(`\n${passed} passed · ${failed} failed`)
if (failed > 0) {
  console.error('FAILURES:')
  for (const f of failures) {
    console.error(`  - ${f.label}${f.detail ? ': ' + f.detail : ''}`)
  }
  process.exit(1)
}
