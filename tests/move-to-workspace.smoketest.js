// OZ Browser — moveToWorkspace handler smoke test (1.4d).
//
// Cómo correr:
//   cd oz-browser
//   node tests/move-to-workspace.smoketest.js
//
// Cubre:
//   - Move a workspace inexistente → reason='target-not-found'
//   - Move a workspace archivado → reason='target-archived'
//   - Move tab inexistente → reason='tab-not-found'
//   - Move al mismo WS → noop=true
//   - Move a WS no-activo: snapshot persiste en target tabSpecs, source tab destruido
//   - Move a WS activo en otra ventana: tab live recreado en destino, source destruido
//   - Move a WS frozen: permitido (frozen bloquea CRUD, no runtime)
//
// Approach: reutilizamos el FakeTabs/FakeWindow de window-workspace.smoketest.
// El handler vive en browser/tab-handlers.js — lo cargamos con el require cache
// busted y le pasamos un browser mock con workspaceManager + windows.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-mv-'))
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

// ---------- Mocks (mismo patron que window-workspace.smoketest) -------------

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
    this.locked = !!opts.locked
    this.materialized = !!opts.materialize
    this.destroyed = false
  }
  toSpec() {
    return {
      id: this.id,
      identityId: this.identityId,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
      locked: this.locked,
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
    this.closedTabsStack = []
  }
  pushClosed(spec) {
    if (!spec || !spec.id) return
    this.closedTabsStack.push({ ...spec, closedAt: Date.now() })
    while (this.closedTabsStack.length > 25) this.closedTabsStack.shift()
  }
  popClosed() {
    return this.closedTabsStack.length ? this.closedTabsStack.pop() : null
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
    t.materialized = true
    return true
  }
  toSpecs() {
    return this.tabList.map((t) => t.toSpec())
  }
}

let _winIdSeq = 200
function makeFakeWindow(workspaceId = null) {
  _winIdSeq += 1
  return {
    id: _winIdSeq,
    workspaceId,
    tabs: new FakeTabs(),
  }
}

function makeFakeBrowser(workspaceManager) {
  return {
    workspaceManager,
    windows: [],
    urls: { newtab: 'about:blank' },
    broadcastToWebUI() {},
    getFocusedWindow() {
      return this.windows[0] || null
    },
  }
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/tab-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const wmMod = require('../browser/workspace-manager.js')
  const { buildTabHandlers } = require('../browser/tab-handlers.js')
  const wm = new wmMod.WorkspaceManager()
  const browser = makeFakeBrowser(wm)
  const handlers = buildTabHandlers(browser)
  return { wm, browser, handlers }
}

// ---------- Tests -----------------------------------------------------------

console.log('OZ Browser — moveToWorkspace handler smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. Move a target inexistente
section('moveToWorkspace: target inexistente')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ url: 'https://x.com' })
  const r = handlers.moveToWorkspace(win.tabs.tabList[0].id, 'nope')
  ok('ok === false', r.ok === false)
  ok('reason === "target-not-found"', r.reason === 'target-not-found')
  ok('tab NO destruida', win.tabs.tabList.length === 1)
}

// 2. Move a target archivado
section('moveToWorkspace: target archivado')
{
  const { wm, browser, handlers } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ url: 'https://x.com' })
  const a = wm.create({ name: 'A' })
  wm.archive(a.id)
  const r = handlers.moveToWorkspace(win.tabs.tabList[0].id, a.id)
  ok('ok === false', r.ok === false)
  ok('reason === "target-archived"', r.reason === 'target-archived')
  ok('tab NO destruida', win.tabs.tabList.length === 1)
}

// 3. Move tab inexistente
section('moveToWorkspace: tabId inexistente')
{
  const { wm, browser, handlers } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  const a = wm.create({ name: 'A' })
  const r = handlers.moveToWorkspace('nonexistent-tab', a.id)
  ok('ok === false', r.ok === false)
  ok('reason === "tab-not-found"', r.reason === 'tab-not-found')
}

// 4. Move al mismo WS = noop
section('moveToWorkspace: mismo WS → noop')
{
  const { wm, browser, handlers } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ url: 'https://x.com' })
  const r = handlers.moveToWorkspace(win.tabs.tabList[0].id, wm.getDefault().id)
  ok('ok === true', r.ok === true)
  ok('noop === true', r.noop === true)
  ok('tab intacta', win.tabs.tabList.length === 1)
  ok(
    'Default tabSpecs sigue vacío (no se duplicó)',
    wm.getDefault().tabSpecs.length === 0,
  )
}

// 5. Move a WS no-activo (solo en disk)
section('moveToWorkspace: target no-activo → snapshot a tabSpecs + destroy source')
{
  const { wm, browser, handlers } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({
    id: 'mover',
    identityId: 'default',
    url: 'https://moveme.com',
    title: 'Move Me',
  })
  const a = wm.create({ name: 'A' }) // No activo en ninguna ventana

  const r = handlers.moveToWorkspace('mover', a.id)
  ok('ok === true', r.ok === true)
  ok('from === Default', r.from === wm.getDefault().id)
  ok('to === a', r.to === a.id)
  ok('tab destruida en source', win.tabs.tabList.length === 0)

  const aPersisted = wm.get(a.id)
  ok('A.tabSpecs.length === 1', aPersisted.tabSpecs.length === 1)
  ok('spec.id preservado', aPersisted.tabSpecs[0].id === 'mover')
  ok('spec.url preservado', aPersisted.tabSpecs[0].url === 'https://moveme.com')
  ok('spec.title preservado', aPersisted.tabSpecs[0].title === 'Move Me')
}

// 6. Move a WS activo en otra ventana
section('moveToWorkspace: target activo en otra ventana → recrea live ahí')
{
  const { wm, browser, handlers } = freshSetup()
  const win1 = makeFakeWindow(wm.getDefault().id)
  const a = wm.create({ name: 'A' })
  const win2 = makeFakeWindow(a.id) // win2 owns workspace A
  browser.windows.push(win1, win2)

  win1.tabs.create({
    id: 'cross',
    identityId: 'default',
    url: 'https://cross.com',
    title: 'Cross',
  })

  const r = handlers.moveToWorkspace('cross', a.id)
  ok('ok === true', r.ok === true)
  ok('source win1 sin tabs', win1.tabs.tabList.length === 0)
  ok('target win2 con 1 tab live', win2.tabs.tabList.length === 1)
  ok('tab live preserva id', win2.tabs.tabList[0].id === 'cross')
  ok('tab live preserva url', win2.tabs.tabList[0].url === 'https://cross.com')
  // Spec también persistido en disk
  ok('spec persistido en A.tabSpecs', wm.get(a.id).tabSpecs.length === 1)
}

// 7. Move a WS frozen
section('moveToWorkspace: target frozen → permitido (runtime, no CRUD)')
{
  const { wm, browser, handlers } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'frostab', url: 'https://f.com', title: 'F' })
  const a = wm.create({ name: 'A' })
  wm.freeze(a.id)

  const r = handlers.moveToWorkspace('frostab', a.id)
  ok('ok === true (frozen permite move)', r.ok === true)
  ok('spec persistido en A.tabSpecs', wm.get(a.id).tabSpecs.length === 1)
  ok('A sigue frozen', wm.get(a.id).isFrozen === true)
}

// 8. H2 — moveToWorkspace rejects locked tab
section('H2 moveToWorkspace: locked tab rejected → reason="tab-locked"')
{
  const { wm, browser, handlers } = freshSetup()
  const win = makeFakeWindow(wm.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'locktab', url: 'https://x.com', locked: true })
  const dest = wm.create({ name: 'Dest' })

  const r = handlers.moveToWorkspace('locktab', dest.id)
  ok('ok === false', r.ok === false)
  ok('reason === tab-locked', r.reason === 'tab-locked')
  ok('source tab still alive', !!win.tabs.get('locktab'))
  ok('dest workspace unchanged', wm.get(dest.id).tabSpecs.length === 0)
}

// 9. H2 — close handler rejects locked tab
section('H2 close: locked tab returns false (no destroy)')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'cantclose', locked: true })
  win.tabs.create({ id: 'normaltab' })

  const rLocked = handlers.close('cantclose')
  ok('close(locked) returns false', rLocked === false)
  ok('locked tab still alive', !!win.tabs.get('cantclose'))

  const rOk = handlers.close('normaltab')
  ok('close(unlocked) returns true', rOk === true)
  ok('unlocked tab destroyed', !win.tabs.get('normaltab'))
}

// 10. H1 — close pushes spec to closedTabsStack
section('H1 close: pushes spec to closedTabsStack')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({
    id: 'doomed',
    identityId: 'default',
    url: 'https://x.com',
    title: 'X',
  })

  ok('initial stack empty', win.tabs.closedTabsStack.length === 0)
  const r = handlers.close('doomed')
  ok('close ok', r === true)
  ok('stack has 1 entry', win.tabs.closedTabsStack.length === 1)
  ok(
    'stack entry preserves identity + url',
    win.tabs.closedTabsStack[0].identityId === 'default' &&
      win.tabs.closedTabsStack[0].url === 'https://x.com',
  )
}

// 11. H1 — close on locked tab does NOT push (rejected before remove)
section('H1 close locked: stack untouched')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  win.tabs.create({ id: 'locked', identityId: 'default', locked: true })

  const r = handlers.close('locked')
  ok('close on locked returns false', r === false)
  ok('stack still empty', win.tabs.closedTabsStack.length === 0)
}

// 12. H1 — reopenClosed pops + recreates tab
section('H1 reopenClosed: pops + recreates lazy tab')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  // Stub createWindow + getFocusedWindow already exist via makeFakeBrowser
  // (the move-to-workspace test browser has them).
  win.tabs.create({ id: 'a', identityId: 'default', url: 'https://a.com', title: 'A' })
  win.tabs.create({ id: 'b', identityId: 'default', url: 'https://b.com', title: 'B' })
  handlers.close('a')
  handlers.close('b')
  ok('stack has 2 entries', win.tabs.closedTabsStack.length === 2)

  // Reopen pops the most-recent first.
  const newId1 = handlers.reopenClosed()
  ok('reopen returns new id', typeof newId1 === 'string' && newId1.length > 0)
  ok(
    'newest restored first (B)',
    win.tabs.tabList.find((t) => t.id === newId1).url === 'https://b.com',
  )
  ok('stack has 1 entry left', win.tabs.closedTabsStack.length === 1)

  const newId2 = handlers.reopenClosed()
  ok(
    'next reopen restores A',
    win.tabs.tabList.find((t) => t.id === newId2).url === 'https://a.com',
  )
  ok('stack empty', win.tabs.closedTabsStack.length === 0)

  const noMore = handlers.reopenClosed()
  ok('reopen on empty stack returns null', noMore === null)
}

// 13. H1 — stack cap (FIFO eviction at 25)
section('H1 closedTabsStack cap: 25 entries max, FIFO eviction')
{
  const { browser, handlers } = freshSetup()
  const win = makeFakeWindow(browser.workspaceManager.getDefault().id)
  browser.windows.push(win)
  for (let i = 0; i < 30; i++) {
    win.tabs.create({ id: `t-${i}`, identityId: 'default', url: `https://${i}.com` })
    handlers.close(`t-${i}`)
  }
  ok('stack capped at 25', win.tabs.closedTabsStack.length === 25)
  // FIFO: oldest (t-0..t-4) evicted, newest (t-29) on top.
  ok('top of stack is t-29', win.tabs.closedTabsStack[24].id === 't-29')
  ok(
    'bottom of stack is t-5 (5..29 = 25 entries)',
    win.tabs.closedTabsStack[0].id === 't-5',
  )
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
