// OZ Browser — tab-context-handlers smoke test (1.7a).
//
// Cómo correr:
//   cd oz-browser
//   node tests/tab-context-handlers.smoketest.js
//
// Cubre los handlers nuevos del 1.7a:
//   - reload, duplicate, duplicateInTemporary, duplicateInIdentity,
//     duplicateInNewIdentity, refreshAllInIdentity, moveToNewWindow,
//     pin/unpin, mute/unmute, closeOthers, closeToRight
//
// Approach: mismo patrón que move-to-workspace.smoketest — fake Electron via
// Module._load hook + FakeTabs/FakeWindow. No requiere GUI.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-tcx-'))
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
  session: {
    defaultSession: {
      setPreloads() {},
      registerPreloadScript() {},
    },
    fromPartition(_name) {
      return {
        setPreloads() {},
        registerPreloadScript() {},
        setUserAgent() {},
        cookies: {
          on() {},
          get: async () => [],
          set: async () => {},
          remove: async () => {},
        },
      }
    },
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

// ---------- Mocks -----------------------------------------------------------

let _tabIdSeq = 0
function nextTabId() {
  _tabIdSeq += 1
  return `tab-${_tabIdSeq}`
}

class FakeTab {
  constructor(opts = {}) {
    this.id = opts.id || nextTabId()
    this.identityId = opts.identityId || 'default'
    this.url = opts.url || 'about:blank'
    this.title = opts.title || 'New Tab'
    this.favicon = opts.favicon || null
    this.pinned = !!opts.pinned
    this.materialized = opts.materialize !== undefined ? !!opts.materialize : true
    this.destroyed = false
    this.reloadCount = 0
    this.muted = false
    this.webContents = this.materialized
      ? {
          isAudioMuted: () => this.muted,
          setAudioMuted: (m) => {
            this.muted = !!m
          },
          reload: () => {
            this.reloadCount += 1
          },
        }
      : null
  }
  reload() {
    this.reloadCount += 1
  }
  toSpec() {
    return {
      id: this.id,
      identityId: this.identityId,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
    }
  }
  serialize() {
    return { ...this.toSpec(), isLoaded: this.materialized }
  }
}

class FakeTabs {
  constructor() {
    this.tabList = []
    this.selected = null
  }
  create(opts) {
    const t = new FakeTab(opts)
    this.tabList.push(t)
    return t
  }
  remove(tabId) {
    const idx = this.tabList.findIndex((t) => t.id === tabId)
    if (idx < 0) return false
    this.tabList[idx].destroyed = true
    this.tabList.splice(idx, 1)
    return true
  }
  get(tabId) {
    return this.tabList.find((t) => t.id === tabId) || null
  }
  select(tabId) {
    const t = this.get(tabId)
    if (!t) return false
    this.selected = t
    return true
  }
  toSpecs() {
    return this.tabList.map((t) => t.toSpec())
  }
}

let _winIdSeq = 300
function makeFakeWindow(workspaceId = null) {
  _winIdSeq += 1
  return { id: _winIdSeq, workspaceId, tabs: new FakeTabs() }
}

function makeFakeIdentityManager() {
  let n = 0
  const identities = [
    {
      id: 'default',
      name: 'Default',
      color: '#8a8a8a',
      isDefault: true,
    },
  ]
  return {
    list: () => identities.map((i) => ({ ...i })),
    get: (id) => identities.find((i) => i.id === id) || null,
    create: (opts) => {
      n += 1
      const id = `id-${n}`
      const ident = {
        id,
        name: (opts && opts.name) || `Identity ${n}`,
        color: (opts && opts.color) || '#5b8def',
      }
      identities.push(ident)
      return { ...ident }
    },
  }
}

function makeFakeBrowser({ wm, im }) {
  const created = []
  const broadcasts = []
  const browser = {
    workspaceManager: wm,
    identityManager: im,
    windows: [],
    urls: { newtab: 'about:blank' },
    handlers: { tabs: null }, // filled in by spread below
    broadcastToWebUI(channel, payload) {
      broadcasts.push({ channel, payload })
    },
    getFocusedWindow() {
      return this.windows[0] || null
    },
    createWindow(opts) {
      const newWin = makeFakeWindow((opts && opts.workspaceId) || null)
      this.windows.push(newWin)
      // Hydrate from workspace tabSpecs (just like real _createInitialTab).
      if (wm && newWin.workspaceId) {
        const ws = wm.get(newWin.workspaceId)
        if (ws && ws.tabSpecs && ws.tabSpecs.length > 0) {
          for (const spec of ws.tabSpecs) {
            newWin.tabs.create({ ...spec, materialize: false })
          }
        }
      }
      created.push(newWin)
      return newWin
    },
  }
  browser._created = created
  browser._broadcasts = broadcasts
  return browser
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/tab-context-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const wmMod = require('../browser/workspace-manager.js')
  const { buildTabContextHandlers } = require('../browser/tab-context-handlers.js')
  const wm = new wmMod.WorkspaceManager()
  const im = makeFakeIdentityManager()
  const browser = makeFakeBrowser({ wm, im })
  const handlers = buildTabContextHandlers(browser)
  browser.handlers.tabs = handlers
  return { wm, im, browser, handlers }
}

// ---------- Tests -----------------------------------------------------------

console.log('OZ Browser — tab-context-handlers smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. reload
section('reload: ok + tab-not-found')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 't1' })

  const r = handlers.reload('t1')
  ok('reload ok', r.ok === true)
  ok('reloadCount === 1', win.tabs.tabList[0].reloadCount === 1)

  const r2 = handlers.reload('does-not-exist')
  ok('not-found returns ok:false', r2.ok === false)
  ok('reason tab-not-found', r2.reason === 'tab-not-found')
}

// 2. duplicate
section('duplicate: clone same identity, inserted right after')
{
  const { browser, handlers, im } = freshSetup()
  const newIdent = im.create({ name: 'A' })
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'first', identityId: newIdent.id, url: 'https://orig.com' })
  win.tabs.create({ id: 'second', identityId: 'default', url: 'about:blank' })

  const r = handlers.duplicate('first')
  ok('ok', r.ok === true)
  ok('list has 3 tabs', win.tabs.tabList.length === 3)
  ok('clone right after first', win.tabs.tabList[1].id === r.newTabId)
  ok('clone preserves identity', win.tabs.tabList[1].identityId === newIdent.id)
  ok('clone preserves url', win.tabs.tabList[1].url === 'https://orig.com')
  ok('order: first/clone/second', win.tabs.tabList[2].id === 'second')
}

// 3. duplicateInTemporary
section('duplicateInTemporary: creates Temp identity + clones tab')
{
  const { browser, handlers, im } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'src', identityId: 'default', url: 'https://x.com' })
  const idsBefore = im.list().length

  const r = handlers.duplicateInTemporary('src')
  ok('ok', r.ok === true)
  ok('new identity created', im.list().length === idsBefore + 1)
  const newIdent = im.get(r.tempIdentityId)
  ok('temp identity has Temp prefix', !!newIdent && newIdent.name.startsWith('Temp '))
  ok('clone bound to temp identity', win.tabs.tabList[1].identityId === r.tempIdentityId)
  ok('list has 2 tabs', win.tabs.tabList.length === 2)
}

// 4. duplicateInIdentity
section('duplicateInIdentity: clone into existing identity')
{
  const { browser, handlers, im } = freshSetup()
  const target = im.create({ name: 'Marketing' })
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'src', identityId: 'default', url: 'https://y.com' })

  const r = handlers.duplicateInIdentity('src', target.id)
  ok('ok', r.ok === true)
  ok('clone bound to target identity', win.tabs.tabList[1].identityId === target.id)

  const r2 = handlers.duplicateInIdentity('src', 'nope')
  ok('not-found identity → ok:false', r2.ok === false)
  ok('reason identity-not-found', r2.reason === 'identity-not-found')
}

// 5. duplicateInNewIdentity
section('duplicateInNewIdentity: creates new identity + clones')
{
  const { browser, handlers, im } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'src', identityId: 'default', url: 'https://z.com' })
  const idsBefore = im.list().length

  const r = handlers.duplicateInNewIdentity('src', 'Side Project')
  ok('ok', r.ok === true)
  ok('new identity created', im.list().length === idsBefore + 1)
  ok('new identity has provided name', im.get(r.identityId).name === 'Side Project')
  ok('clone bound to new identity', win.tabs.tabList[1].identityId === r.identityId)
}

// 6. refreshAllInIdentity
section('refreshAllInIdentity: reloads only matching materialized tabs')
{
  const { browser, handlers, im } = freshSetup()
  const a = im.create({ name: 'A' })
  const b = im.create({ name: 'B' })
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: '1', identityId: a.id })
  win.tabs.create({ id: '2', identityId: a.id })
  win.tabs.create({ id: '3', identityId: b.id })
  // Lazy: materialized=false should be skipped
  win.tabs.create({ id: '4', identityId: a.id, materialize: false })

  const r = handlers.refreshAllInIdentity(a.id)
  ok('ok', r.ok === true)
  ok('count === 2 (only materialized A tabs)', r.count === 2)
  ok('1 reloaded', win.tabs.tabList[0].reloadCount === 1)
  ok('2 reloaded', win.tabs.tabList[1].reloadCount === 1)
  ok('3 NOT reloaded (different identity)', win.tabs.tabList[2].reloadCount === 0)
  ok('4 NOT reloaded (lazy)', win.tabs.tabList[3].reloadCount === 0)
}

// 7. moveToNewWindow
section('moveToNewWindow: creates Window N + new BrowserWindow + persists tabSpec')
{
  const { browser, handlers, wm } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({
    id: 'pop',
    identityId: 'default',
    url: 'https://pop.com',
    title: 'Pop',
  })

  const r = handlers.moveToNewWindow('pop')
  ok('ok', r.ok === true)
  ok('source tab destroyed', win.tabs.tabList.length === 0)
  ok('newWindowId set', typeof r.newWindowId === 'number')
  ok('newWorkspaceId set', typeof r.newWorkspaceId === 'string')
  const newWs = wm.get(r.newWorkspaceId)
  ok('new WS named "Window 2"', newWs.name === 'Window 2')
  ok('new WS has 1 tabSpec', newWs.tabSpecs.length === 1)
  ok('tabSpec preserves id', newWs.tabSpecs[0].id === 'pop')
  ok('tabSpec preserves url', newWs.tabSpecs[0].url === 'https://pop.com')

  // Second moveToNewWindow should auto-name "Window 3"
  const win2 = browser.windows[browser.windows.length - 1]
  // Add another tab so we can move again
  win2.tabs.create({ id: 'pop2', identityId: 'default', url: 'https://p2.com' })
  const r2 = handlers.moveToNewWindow('pop2')
  ok('second move ok', r2.ok === true)
  ok('second WS named "Window 3"', wm.get(r2.newWorkspaceId).name === 'Window 3')
}

// 8. pin / unpin
section('pin / unpin: toggles + persists tabSpec')
{
  const { browser, handlers, wm } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 't', identityId: 'default', url: 'https://x.com' })
  win.tabs.select('t')

  const r1 = handlers.pin('t')
  ok('pin ok', r1.ok === true)
  ok('pinned === true', r1.pinned === true)
  ok('tab.pinned === true', win.tabs.get('t').pinned === true)
  // Persisted into workspace
  const ws = wm.getDefault()
  ok(
    'tabSpec persisted with pinned=true',
    ws.tabSpecs[0] && ws.tabSpecs[0].pinned === true,
  )

  const r2 = handlers.unpin('t')
  ok('unpin ok', r2.ok === true)
  ok('tab.pinned === false', win.tabs.get('t').pinned === false)
  ok('tabSpec persisted with pinned=false', wm.getDefault().tabSpecs[0].pinned === false)
}

// 9. mute / unmute
section('mute / unmute: materialized vs lazy')
{
  const { browser, handlers, wm } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'm', materialize: true })
  win.tabs.create({ id: 'lazy', materialize: false })

  const r1 = handlers.mute('m')
  ok('mute materialized ok', r1.ok === true)
  ok('webContents.muted true', win.tabs.get('m').webContents.isAudioMuted() === true)

  const r2 = handlers.unmute('m')
  ok('unmute ok', r2.ok === true)
  ok('webContents.muted false', win.tabs.get('m').webContents.isAudioMuted() === false)

  const r3 = handlers.mute('lazy')
  ok('mute lazy → ok with lazyNoop:true', r3.ok === true && r3.lazyNoop === true)
}

// 10. closeOthers
section('closeOthers: closes everything else, preserves pinned')
{
  const { browser, handlers, wm } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'a' })
  win.tabs.create({ id: 'b', pinned: true }) // pinned should survive
  win.tabs.create({ id: 'keep' })
  win.tabs.create({ id: 'd' })

  const r = handlers.closeOthers('keep')
  ok('ok', r.ok === true)
  ok('closedCount === 2 (a + d)', r.closedCount === 2)
  ok('keep survived', !!win.tabs.get('keep'))
  ok('pinned b survived', !!win.tabs.get('b'))
  ok('a closed', !win.tabs.get('a'))
  ok('d closed', !win.tabs.get('d'))
}

// 11. closeToRight
section('closeToRight: closes only those after, preserves pinned')
{
  const { browser, handlers, wm } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'left' })
  win.tabs.create({ id: 'anchor' })
  win.tabs.create({ id: 'r1' })
  win.tabs.create({ id: 'r2', pinned: true }) // pinned survives even on right
  win.tabs.create({ id: 'r3' })

  const r = handlers.closeToRight('anchor')
  ok('ok', r.ok === true)
  ok('closedCount === 2 (r1 + r3)', r.closedCount === 2)
  ok('left survived', !!win.tabs.get('left'))
  ok('anchor survived', !!win.tabs.get('anchor'))
  ok('r1 closed', !win.tabs.get('r1'))
  ok('r2 (pinned) survived', !!win.tabs.get('r2'))
  ok('r3 closed', !win.tabs.get('r3'))
}

// ---------- Cleanup ---------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
