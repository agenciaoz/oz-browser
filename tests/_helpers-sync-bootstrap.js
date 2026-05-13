// OZ Browser — Shared test helpers for sync-bootstrap.smoketest.js +
// sync-bootstrap-handlers.smoketest.js (D-3c-3c).
//
// Extracted to keep each test file under 500 LOC per ADR 0005. Boots the
// Electron module mock once + exposes fake builders for vault / IM / WM /
// BM / dropbox / device-info / alert manager / sync object / browser.

'use strict'

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-sb-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getAppPath: () => path.resolve(__dirname, '..'),
    on() {},
    whenReady: () => Promise.resolve(),
  },
  session: { defaultSession: {}, fromPartition: () => ({}) },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

function makeFakeSettings(initial = {}) {
  const data = {
    version: 1,
    sync: { enabled: false, firstEnableAt: null },
    ...initial,
  }
  return {
    get: (section) => (data[section] ? JSON.parse(JSON.stringify(data[section])) : null),
    set: (section, patch) => {
      data[section] = { ...(data[section] || {}), ...patch }
      return { ...data[section] }
    },
    _data: data,
  }
}

function makeFakeVault({ unlocked = true } = {}) {
  let _u = unlocked
  return {
    get isUnlocked() {
      return _u
    },
    getMasterKey: () => Buffer.alloc(32, 0xaa),
    _setUnlocked: (v) => {
      _u = v
    },
  }
}

function makeFakeIdentityManager(initial = []) {
  const items = [...initial]
  return Object.assign(new EventEmitter(), {
    list: () => items.map((i) => ({ ...i })),
    get: (id) => items.find((i) => i.id === id) || null,
  })
}

function makeFakeWorkspaceManager(initial = []) {
  const items = [...initial]
  return Object.assign(new EventEmitter(), {
    list: () => items.map((i) => ({ ...i })),
    get: (id) => items.find((i) => i.id === id) || null,
  })
}

function makeFakeBookmarkManager(records) {
  return Object.assign(new EventEmitter(), { getSyncRecord: () => records })
}

function makeFakeDropbox({ authenticated = true } = {}) {
  return {
    _auth: authenticated,
    isAuthenticated() {
      return this._auth
    },
  }
}

function makeFakeDeviceInfo(folder = 'test-mac-abc12345') {
  return {
    ensureDeviceInfo: () => ({ shortId: 'abc12345', deviceFolder: folder }),
  }
}

function makeFakeAlertManager() {
  const added = []
  return { add: (opts) => added.push(opts), _added: added }
}

// Fake sync object returned by setupSyncImpl in tests.
function makeFakeSync({ failPushNow = null } = {}) {
  const engine = new EventEmitter()
  const puller = new EventEmitter()
  const queue = Object.assign(new EventEmitter(), {
    _ops: new Map(),
    enqueue(op) {
      const k = `${op.recordType}:${op.recordId}`
      this._ops.set(k, op)
      this.emit('enqueued', { op })
      return { coalesced: false }
    },
    size() {
      return this._ops.size
    },
  })
  let running = false
  return {
    engine,
    puller,
    queue,
    start: () => {
      running = true
      if (failPushNow) {
        setImmediate(() => engine.emit('push-failed', failPushNow))
      }
    },
    stop: () => {
      running = false
    },
    isRunning: () => running,
    pullNow: async () => ({ identity: { applied: 0 } }),
  }
}

function makeBrowser(opts = {}) {
  const broadcasts = []
  return {
    settingsManager: opts.settingsManager || makeFakeSettings(),
    accountVault: opts.accountVault || makeFakeVault(),
    identityManager: opts.identityManager || makeFakeIdentityManager(),
    workspaceManager: opts.workspaceManager,
    bookmarkManager: opts.bookmarkManager,
    dropboxClient: opts.dropboxClient,
    deviceInfo: opts.deviceInfo,
    alertManager: opts.alertManager || makeFakeAlertManager(),
    broadcastToWebUI: (ch) => broadcasts.push(ch),
    _broadcasts: broadcasts,
  }
}

// Lightweight runner shared by both test files.
function makeRunner() {
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

  async function run(label, fn) {
    console.log(`\n[${label}]`)
    try {
      await fn()
    } catch (err) {
      failed++
      failures.push({ label, detail: err && err.stack })
      console.log(`  ✗ threw: ${err && err.message}`)
    }
  }

  function summarize() {
    setTimeout(() => {
      console.log(`\n========================================`)
      console.log(`  Tests: ${passed} passed, ${failed} failed`)
      console.log(`========================================\n`)
      if (failed > 0) {
        for (const f of failures) {
          console.log(`FAIL: ${f.label}`)
          if (f.detail) console.log(`  ${f.detail}`)
        }
        process.exit(1)
      }
      process.exit(0)
    }, 100)
  }

  return { ok, run, summarize }
}

module.exports = {
  TEST_USERDATA,
  makeFakeSettings,
  makeFakeVault,
  makeFakeIdentityManager,
  makeFakeWorkspaceManager,
  makeFakeBookmarkManager,
  makeFakeDropbox,
  makeFakeDeviceInfo,
  makeFakeAlertManager,
  makeFakeSync,
  makeBrowser,
  makeRunner,
}
