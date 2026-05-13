// OZ Browser — Sync Bootstrap handlers + settings smoke test (D-3c-3c).
//
// Sister file to sync-bootstrap.smoketest.js — extracts handler-map +
// settings-manager validateKey tests to stay under 500 LOC per ADR 0005.
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-bootstrap-handlers.smoketest.js

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  makeFakeSettings,
  makeFakeDropbox,
  makeFakeDeviceInfo,
  makeFakeSync,
  makeBrowser,
  makeRunner,
} = require('./_helpers-sync-bootstrap')

const { ok, run, summarize } = makeRunner()

const { createSyncBootstrap } = require('../browser/sync-bootstrap')
const { buildSyncHandlers } = require('../browser/sync-handlers')
const { SettingsManager } = require('../browser/settings-manager')

// ---------- Tests ----------------------------------------------------------

run('handler map — setEnabled rejects non-boolean', async () => {
  const browser = makeBrowser({
    settingsManager: makeFakeSettings(),
    dropboxClient: makeFakeDropbox(),
    deviceInfo: makeFakeDeviceInfo(),
  })
  const sb = createSyncBootstrap(browser, { setupSync: () => makeFakeSync() })
  browser.syncBootstrap = sb
  const h = buildSyncHandlers(browser)
  const r1 = h.setEnabled('not a bool')
  ok('rejects string', r1.ok === false && r1.reason === 'BAD_ARG')
  const r2 = h.setEnabled(undefined)
  ok('rejects undefined', r2.ok === false && r2.reason === 'BAD_ARG')
  const r3 = h.setEnabled(true)
  ok('accepts boolean true', r3.ok === true)
})

run('handler map — NOT_CONFIGURED when bootstrap absent', async () => {
  const browser = { syncBootstrap: null }
  const h = buildSyncHandlers(browser)
  ok('getStatus returns safe shape', h.getStatus().configured === false)
  ok('setEnabled returns NOT_CONFIGURED', h.setEnabled(true).reason === 'NOT_CONFIGURED')
  const pr = await h.pullNow()
  ok('pullNow returns NOT_CONFIGURED', pr.ok === false && pr.reason === 'NOT_CONFIGURED')
})

run('settings-manager validateKey accepts sync.enabled', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-bs-settings-'))
  const sm = new SettingsManager({ dataDir })
  ok('default sync.enabled = false', sm.get('sync').enabled === false)
  ok('default sync.firstEnableAt = null', sm.get('sync').firstEnableAt === null)
  // settings-manager.set returns { __error } on validation failure, or the
  // updated section object on success. Success = no __error key.
  const r1 = sm.set('sync', { enabled: true })
  ok('accepts enabled boolean', !r1.__error && r1.enabled === true)
  const r2 = sm.set('sync', { enabled: 'yes' })
  ok('rejects enabled non-boolean', !!r2.__error && r2.__error.code === 'INVALID_VALUE')
  const r3 = sm.set('sync', { firstEnableAt: 12345 })
  ok('rejects firstEnableAt number', !!r3.__error && r3.__error.code === 'INVALID_VALUE')
  const r4 = sm.set('sync', { firstEnableAt: '2026-01-01T00:00:00Z' })
  ok(
    'accepts firstEnableAt ISO string',
    !r4.__error && r4.firstEnableAt === '2026-01-01T00:00:00Z',
  )
})

summarize()
