// OZ Browser — Scheduled Actions handler map smoke test (Bloque F-3, v1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/scheduled-handlers.smoketest.js
//
// Cubre:
//   - NOT_CONFIGURED early-boot path (no browser.scheduledActions yet)
//   - list / get / create / update / remove / setEnabled / getStatus /
//     tickNow happy paths against a real ScheduledActions
//   - BAD_ARG envelopes for missing/wrong-typed args
//   - UNKNOWN_ACTION envelope for get(missing-id)
//   - ScheduledActionsError code is mapped into envelope.reason
//   - tickNow fires due handlers + returns { ok: true }
//
// La capa IPC real (ipcMain.handle / preload exposure) se valida en
// F-4 con un integration test contra un BrowserWindow simulado.

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const { ScheduledActions } = require('../browser/scheduled-actions')
const { buildScheduledHandlers } = require('../browser/scheduled-handlers')

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
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-sched-h-'))
  return path.join(dir, name)
}

function makeClock(start) {
  const state = { now: start }
  const fn = () => state.now
  fn.advance = (ms) => {
    state.now += ms
  }
  return fn
}

// ===========================================================================
// NOT_CONFIGURED early-boot path
// ===========================================================================
console.log('\n[NOT_CONFIGURED early-boot]')

{
  const browser = {} // no scheduledActions yet
  const h = buildScheduledHandlers(browser)
  ok(
    'list() → NOT_CONFIGURED',
    h.list().ok === false && h.list().reason === 'NOT_CONFIGURED',
  )
  ok(
    'get() → NOT_CONFIGURED',
    h.get('x').ok === false && h.get('x').reason === 'NOT_CONFIGURED',
  )
  ok(
    'create() → NOT_CONFIGURED',
    h.create({}).ok === false && h.create({}).reason === 'NOT_CONFIGURED',
  )
  ok(
    'update() → NOT_CONFIGURED',
    h.update('x', {}).ok === false && h.update('x', {}).reason === 'NOT_CONFIGURED',
  )
  ok(
    'remove() → NOT_CONFIGURED',
    h.remove('x').ok === false && h.remove('x').reason === 'NOT_CONFIGURED',
  )
  ok(
    'setEnabled() → NOT_CONFIGURED',
    h.setEnabled('x', true).ok === false &&
      h.setEnabled('x', true).reason === 'NOT_CONFIGURED',
  )

  const st = h.getStatus()
  ok(
    'getStatus() returns inert object',
    st.configured === false && st.running === false && st.actionCount === 0,
  )
}

// ===========================================================================
// happy paths against real ScheduledActions
// ===========================================================================
;(async () => {
  console.log('\n[happy paths]')

  const fp = tmpFile('sa.json')
  const clock = makeClock(1_700_000_000_000)
  const fired = []
  const sa = new ScheduledActions({
    filePath: fp,
    clock,
    handlers: {
      'sync-push': async () => {
        fired.push(clock())
        return { didPush: true }
      },
    },
  })
  sa.load()

  const browser = { scheduledActions: sa }
  const h = buildScheduledHandlers(browser)

  // create — happy
  const c = h.create({
    name: 'nightly',
    action: 'sync-push',
    schedule: { type: 'every-minutes', minutes: 1 },
  })
  ok('create ok=true', c.ok === true && c.action && c.action.id)
  const id = c.action.id

  // list
  const ls = h.list()
  ok('list returns one', ls.ok === true && ls.actions.length === 1)
  ok(
    'list returns plain objects (not class instances)',
    ls.actions[0].constructor === Object,
  )

  // get
  const g = h.get(id)
  ok('get ok=true', g.ok === true && g.action.id === id)

  // get unknown
  const gMiss = h.get('does-not-exist')
  ok(
    'get unknown → UNKNOWN_ACTION envelope',
    gMiss.ok === false && gMiss.reason === 'UNKNOWN_ACTION',
  )

  // update — happy
  const u = h.update(id, { name: 'renamed', enabled: false })
  ok(
    'update ok=true with new name',
    u.ok === true && u.action.name === 'renamed' && u.action.enabled === false,
  )

  // update — error mapped to envelope
  const uBad = h.update(id, { id: 'hijack' })
  ok(
    'update reserved → RESERVED_FIELD envelope',
    uBad.ok === false && uBad.reason === 'RESERVED_FIELD',
  )
  const uUnknown = h.update('nope', { name: 'x' })
  ok(
    'update unknown → UNKNOWN_ACTION envelope',
    uUnknown.ok === false && uUnknown.reason === 'UNKNOWN_ACTION',
  )

  // re-enable for tickNow test
  h.setEnabled(id, true)
  ok('setEnabled true sets enabled back', h.get(id).action.enabled === true)

  // setEnabled bad arg
  const seBad = h.setEnabled(id, 'yes')
  ok('setEnabled non-bool → BAD_ARG', seBad.ok === false && seBad.reason === 'BAD_ARG')

  // create validation error → envelope
  const cBad = h.create({
    name: '',
    action: 'sync-push',
    schedule: { type: 'every-minutes', minutes: 1 },
  })
  ok(
    'create validation error mapped → BAD_NAME envelope',
    cBad.ok === false && cBad.reason === 'BAD_NAME',
  )

  // bad args general
  ok(
    'list still works after errors',
    h.list().ok === true && h.list().actions.length === 1,
  )
  ok(
    'get with non-string id → BAD_ARG',
    h.get(123).ok === false && h.get(123).reason === 'BAD_ARG',
  )
  ok(
    'create with non-object → BAD_ARG',
    h.create(null).ok === false && h.create(null).reason === 'BAD_ARG',
  )
  ok(
    'update with non-object patch → BAD_ARG',
    h.update(id, [1, 2]).ok === false && h.update(id, [1, 2]).reason === 'BAD_ARG',
  )
  ok(
    'remove with empty id → BAD_ARG',
    h.remove('').ok === false && h.remove('').reason === 'BAD_ARG',
  )

  // getStatus
  const st = h.getStatus()
  ok(
    'getStatus configured + actionCount',
    st.configured === true && st.actionCount === 1 && st.running === false,
  )

  // tickNow — fires due action
  clock.advance(70_000)
  const tn = await h.tickNow()
  ok('tickNow returns ok=true', tn.ok === true)
  ok('tickNow fired the underlying handler', fired.length === 1)

  // remove
  const rm = h.remove(id)
  ok('remove ok=true + removed=true', rm.ok === true && rm.removed === true)
  ok('list after remove is empty', h.list().actions.length === 0)
  const rm2 = h.remove(id)
  ok('remove again → removed=false', rm2.ok === true && rm2.removed === false)

  console.log(`\n=== passed=${passed} failed=${failed} ===`)
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
    }
    process.exit(1)
  }
})().catch((err) => {
  console.error('UNEXPECTED ERR:', err)
  process.exit(2)
})
