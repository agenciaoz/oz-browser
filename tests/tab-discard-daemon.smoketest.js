// OZ Browser — tab-discard-daemon smoke test (1.10d).

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-tdd-'))
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
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

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
function section(name) {
  console.log(`\n— ${name} —`)
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/tab-discard-daemon.js')]
  delete require.cache[require.resolve('../browser/settings-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
}

console.log('OZ Browser — tab-discard-daemon smoke test')

function makeFakeTab(opts = {}) {
  const t = {
    id: opts.id || 'tab-' + Math.random(),
    identityId: opts.identityId || 'id-1',
    materialized: opts.materialized !== false,
    pinned: !!opts.pinned,
    lastSelectedAt: opts.lastSelectedAt || 0,
    discardCount: 0,
  }
  t.discard = () => {
    t.discardCount += 1
    t.materialized = false
    return true
  }
  return t
}
function makeFakeBrowser(tabSpecs) {
  const tabs = tabSpecs.map(makeFakeTab)
  const broadcasts = []
  return {
    windows: [
      {
        tabs: {
          tabList: tabs,
          selected: tabs.find((t) => t.materialized) || null, // first mat as selected by default
        },
      },
    ],
    broadcastToWebUI(channel, payload) {
      broadcasts.push({ channel, payload })
    },
    _broadcasts: broadcasts,
    _tabs: tabs,
  }
}

// ---------- 1. honors autoTabDiscard=false (no discard) -------------------
section('scan: autoTabDiscard=false → no discards')
{
  freshSetup()
  const { TabDiscardDaemon } = require('../browser/tab-discard-daemon.js')
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  sm.set('performance', { autoTabDiscard: false })

  const browser = makeFakeBrowser([
    { id: 't1', materialized: true, lastSelectedAt: 0 }, // very old, would be discarded if enabled
  ])
  const daemon = new TabDiscardDaemon({
    browser,
    settingsManager: sm,
    now: () => 1000 * 60 * 60 * 24, // 1 day in
  })
  const r = daemon.scan()
  ok('no discards', r.length === 0)
  ok('tab still materialized', browser._tabs[0].materialized === true)
}

// ---------- 2. discards idle materialized tabs ---------------------------
section('scan: discards materialized + non-selected + non-pinned + idle')
{
  freshSetup()
  const { TabDiscardDaemon } = require('../browser/tab-discard-daemon.js')
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  sm.set('performance', { autoTabDiscard: true, discardIdleMin: 30 })

  // 1 hour ago
  const NOW = 1000 * 60 * 60 * 24
  const ONE_HOUR_AGO = NOW - 60 * 60 * 1000

  const browser = makeFakeBrowser([
    { id: 'selected', materialized: true, lastSelectedAt: NOW }, // selected — never discarded
    { id: 'idle', materialized: true, lastSelectedAt: ONE_HOUR_AGO },
    { id: 'pinned-idle', materialized: true, pinned: true, lastSelectedAt: ONE_HOUR_AGO },
    { id: 'lazy', materialized: false, lastSelectedAt: ONE_HOUR_AGO },
    { id: 'recent', materialized: true, lastSelectedAt: NOW - 60 * 1000 }, // 1 min ago
  ])
  // Selected is the first materialized
  browser.windows[0].tabs.selected = browser._tabs[0]

  const daemon = new TabDiscardDaemon({ browser, settingsManager: sm, now: () => NOW })
  const r = daemon.scan()
  ok('1 discarded (idle only)', r.length === 1)
  ok('discarded id is "idle"', r[0].tabId === 'idle')
  ok('"selected" still materialized', browser._tabs[0].materialized === true)
  ok('"idle" no longer materialized', browser._tabs[1].materialized === false)
  ok('"pinned-idle" still materialized (pinned)', browser._tabs[2].materialized === true)
  ok('"recent" still materialized (not idle)', browser._tabs[4].materialized === true)
  ok(
    'broadcast fired',
    browser._broadcasts.some((b) => b.channel === 'oz:tabs:updated'),
  )
}

// ---------- 3. discardIdleMin honored -----------------------------------
section('scan: discardIdleMin=120 → 1h idle is NOT discarded')
{
  freshSetup()
  const { TabDiscardDaemon } = require('../browser/tab-discard-daemon.js')
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  sm.set('performance', { autoTabDiscard: true, discardIdleMin: 120 })
  const NOW = 1000 * 60 * 60 * 24
  const browser = makeFakeBrowser([
    { id: 't1', materialized: true, lastSelectedAt: NOW - 60 * 60 * 1000 }, // 1h
  ])
  browser.windows[0].tabs.selected = null
  const daemon = new TabDiscardDaemon({ browser, settingsManager: sm, now: () => NOW })
  const r = daemon.scan()
  ok('no discard at 1h with cutoff 2h', r.length === 0)
  ok('still materialized', browser._tabs[0].materialized === true)
}

// ---------- 4. start/stop daemon idempotent -----------------------------
section('startDaemon + stopDaemon idempotent')
{
  freshSetup()
  const { TabDiscardDaemon } = require('../browser/tab-discard-daemon.js')
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  let cleared = 0
  const daemon = new TabDiscardDaemon({
    browser: { windows: [], broadcastToWebUI() {} },
    settingsManager: sm,
    setInterval: () => 'fake-timer-id',
    clearInterval: () => {
      cleared += 1
    },
  })
  ok('startDaemon true', daemon.startDaemon() === true)
  ok('startDaemon idempotent (false)', daemon.startDaemon() === false)
  ok('stopDaemon true', daemon.stopDaemon() === true)
  ok('clearInterval called once', cleared === 1)
  ok('stopDaemon idempotent (false)', daemon.stopDaemon() === false)
}

// ---------- 5. multiple windows scanned --------------------------------
section('scan: multiple windows')
{
  freshSetup()
  const { TabDiscardDaemon } = require('../browser/tab-discard-daemon.js')
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  sm.set('performance', { autoTabDiscard: true, discardIdleMin: 30 })

  const NOW = 1000 * 60 * 60 * 24
  const ONE_H = NOW - 60 * 60 * 1000

  const tabsA = [makeFakeTab({ id: 'a-idle', materialized: true, lastSelectedAt: ONE_H })]
  const tabsB = [makeFakeTab({ id: 'b-idle', materialized: true, lastSelectedAt: ONE_H })]
  const browser = {
    windows: [
      { tabs: { tabList: tabsA, selected: null } },
      { tabs: { tabList: tabsB, selected: null } },
    ],
    broadcastToWebUI() {},
  }
  const daemon = new TabDiscardDaemon({ browser, settingsManager: sm, now: () => NOW })
  const r = daemon.scan()
  ok('2 discards across 2 windows', r.length === 2)
  ok('a-idle discarded', tabsA[0].materialized === false)
  ok('b-idle discarded', tabsB[0].materialized === false)
}

// ---------- 6. Tab.discard() integration --------------------------------
section('Tab.discard(): preserves pendingUrl, marks materialized=false')
{
  // Direct test of Tab.discard via the actual Tab class. Stub the runtime
  // pieces (window.contentView.removeChildView, webContents.destroy).
  delete require.cache[require.resolve('../browser/tabs.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  // tabs.js requires electron — the fakeElectron above doesn't expose
  // WebContentsView, but the constructor doesn't call it without
  // materialize. We test discard() on a tab we manually rig.
  const { Tab } = require('../browser/tabs.js')
  const fakeWindow = {
    contentView: { addChildView() {}, removeChildView() {} },
    isDestroyed: () => false,
    on() {},
    off() {},
    getSize: () => [1280, 720],
  }
  const tab = new Tab(fakeWindow, null, { id: 't', url: 'https://orig.com' })
  // Force-materialize manually:
  tab.materialized = true
  tab.webContents = {
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    closeDevTools: () => {},
    destroy: () => {},
    getURL: () => 'https://current.com',
  }
  tab.view = { setVisible() {}, setBounds() {}, setBorderRadius() {} }
  let updates = 0
  tab.on('updated', () => (updates += 1))
  const r = tab.discard()
  ok('discard returns true', r === true)
  ok('materialized false', tab.materialized === false)
  ok('pendingUrl updated to current URL', tab.pendingUrl === 'https://current.com')
  ok('webContents nulled', tab.webContents === null)
  ok('view nulled', tab.view === null)
  ok('updated event emitted', updates >= 1)

  // Re-discard is noop
  ok('second discard noop (returns false)', tab.discard() === false)
}

// ---------- Cleanup -----------------------------------------------------
Module._load = originalLoad
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
