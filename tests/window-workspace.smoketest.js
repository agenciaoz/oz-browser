// OZ Browser — window-workspace switch logic smoke test (1.4b).
//
// Cómo correr:
//   cd oz-browser
//   node tests/window-workspace.smoketest.js
//
// Cubre:
//   - switchWorkspace() snapshot + destroy + hydrate
//   - Lock exclusivo: 1 workspace = max 1 ventana
//   - Switch a workspace inexistente → reason='not-found'
//   - Switch al mismo WS → noop
//   - Workspace recién creado (sin tabSpecs) → crea newtab fresh
//   - Workspace con tabSpecs → recrea lazy + selecciona activeTabId persistido
//   - hydrate idempotente (segunda llamada con tabs ya cargadas no rompe — defensivo)
//   - releaseOnDestroy snapshot + libera workspaceId
//   - findWindowOwning encuentra correctamente
//
// Approach: mockeamos `Tabs` con un fake mínimo (tabList + selected + create +
// remove + select + toSpecs + get) y un `BrowserWindow` fake. Probamos la
// lógica de switch sin necesitar WebContentsView real. Tabs reales se cubren
// en visual smoke test del cierre del bloque.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ---------- Electron mock + isolated test userData ---------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-wsw-'))
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
  // window-workspace.js doesn't touch BrowserWindow / WebContentsView directly,
  // but logger does pull in Electron app on require.
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

// ---------- Test runner ------------------------------------------------------

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

// ---------- Mocks ------------------------------------------------------------

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
    this.materialized = !!opts.materialize
    this.destroyed = false
    this.source = opts.source
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
    this._destroyed = false
  }
  create(opts) {
    const t = new FakeTab(opts)
    this.tabList.push(t)
    if (opts.materialize) t.materialized = true
    return t
  }
  remove(tabId) {
    const idx = this.tabList.findIndex((t) => t.id === tabId)
    if (idx < 0) return false
    const t = this.tabList[idx]
    t.destroyed = true
    this.tabList.splice(idx, 1)
    if (this.selected === t) this.selected = this.tabList[0] || null
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
  destroy() {
    this._destroyed = true
    for (const t of this.tabList) t.destroyed = true
    this.tabList = []
    this.selected = null
  }
}

let _winIdSeq = 100
function makeFakeWindow() {
  _winIdSeq += 1
  return {
    id: _winIdSeq,
    workspaceId: null,
    tabs: new FakeTabs(),
  }
}

function makeFakeBrowser(workspaceManager) {
  return {
    workspaceManager,
    windows: [],
    urls: { newtab: 'about:blank' },
    broadcastToWebUI() {},
  }
}

function freshWMSnapshot() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  delete require.cache[require.resolve('../browser/window-workspace.js')]
  const wmMod = require('../browser/workspace-manager.js')
  const wsw = require('../browser/window-workspace.js')
  // Use synchronous save for tests (default 0).
  const wm = new wmMod.WorkspaceManager()
  return { wmMod, wsw, wm }
}

// ---------- Tests ------------------------------------------------------------

console.log('OZ Browser — window-workspace switch logic smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. switchWorkspace básico: sin tabSpecs en el target → crea newtab
section('switchWorkspace: target sin tabSpecs → crea newtab')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  win.workspaceId = wm.getDefault().id
  browser.windows.push(win)

  // Inject one live tab in the Default WS
  win.tabs.create({ url: 'https://default.com', title: 'Default Tab', materialize: true })
  win.tabs.select(win.tabs.tabList[0].id)

  const a = wm.create({ name: 'A' })
  const result = wsw.switchWorkspace({
    window: win,
    browser,
    targetWorkspaceId: a.id,
  })

  ok('switch ok', result.ok === true)
  ok('window.workspaceId actualizado', win.workspaceId === a.id)
  ok('tabs nuevas: 1 (newtab)', win.tabs.tabList.length === 1)
  ok('newtab url === about:blank', win.tabs.tabList[0].url === 'about:blank')
  ok('Default WS recibió snapshot', wm.get(wm.getDefault().id).tabSpecs.length === 1)
  ok(
    'Default tabSpec preserva url original',
    wm.get(wm.getDefault().id).tabSpecs[0].url === 'https://default.com',
  )
}

// 2. Lock exclusivo: WS abierto en otra ventana → reason='already-open'
section('Lock exclusivo: WS ya abierto en otra ventana')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win1 = makeFakeWindow()
  const win2 = makeFakeWindow()
  const a = wm.create({ name: 'A' })
  win1.workspaceId = a.id
  win2.workspaceId = wm.getDefault().id
  browser.windows.push(win1, win2)

  const result = wsw.switchWorkspace({
    window: win2,
    browser,
    targetWorkspaceId: a.id,
  })

  ok('switch ok === false', result.ok === false)
  ok(`reason === "already-open"`, result.reason === 'already-open')
  ok('ownerWindowId === win1.id', result.ownerWindowId === win1.id)
  ok('win2.workspaceId NO cambió', win2.workspaceId === wm.getDefault().id)
}

// 3. Switch al mismo WS = noop
section('Switch al mismo WS → noop')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  const a = wm.create({ name: 'A' })
  win.workspaceId = a.id
  browser.windows.push(win)

  win.tabs.create({ url: 'https://stay.com', title: 'Stay', materialize: true })
  const tabsBefore = win.tabs.tabList.length

  const result = wsw.switchWorkspace({
    window: win,
    browser,
    targetWorkspaceId: a.id,
  })

  ok('switch ok', result.ok === true)
  ok('result.noop === true', result.noop === true)
  ok('tabs intactas', win.tabs.tabList.length === tabsBefore)
  ok('tab no destruida', win.tabs.tabList[0].destroyed === false)
}

// 4. Switch a WS inexistente
section('Switch a WS inexistente → reason="not-found"')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  win.workspaceId = wm.getDefault().id
  browser.windows.push(win)

  const result = wsw.switchWorkspace({
    window: win,
    browser,
    targetWorkspaceId: 'nope-not-real',
  })

  ok('switch ok === false', result.ok === false)
  ok('reason === "not-found"', result.reason === 'not-found')
  ok('window.workspaceId NO cambió', win.workspaceId === wm.getDefault().id)
}

// 5. Switch a WS con tabSpecs persistidos → recrea lazy + selecciona activeTabId
section('Switch a WS con tabSpecs → recrea lazy + selecciona activeTabId')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  win.workspaceId = wm.getDefault().id
  browser.windows.push(win)

  // Pre-populate workspace A with 3 tabSpecs and an activeTabId pointing to t2
  const a = wm.create({ name: 'A' })
  wm.setTabSpecs(
    a.id,
    [
      { id: 't1', identityId: 'default', url: 'https://1.com', title: 'One' },
      { id: 't2', identityId: 'default', url: 'https://2.com', title: 'Two' },
      { id: 't3', identityId: 'default', url: 'https://3.com', title: 'Three' },
    ],
    't2',
  )

  const result = wsw.switchWorkspace({
    window: win,
    browser,
    targetWorkspaceId: a.id,
  })

  ok('switch ok', result.ok === true)
  ok('3 tabs recreadas', win.tabs.tabList.length === 3)
  ok('ids preservados', win.tabs.tabList.map((t) => t.id).join(',') === 't1,t2,t3')
  ok('urls preservadas', win.tabs.tabList[1].url === 'https://2.com')
  ok('activeTabId t2 seleccionado', win.tabs.selected && win.tabs.selected.id === 't2')
  ok(
    't2 materialized post-select',
    win.tabs.selected && win.tabs.selected.materialized === true,
  )
}

// 6. activeTabId stale → fallback a primera tab
section('activeTabId stale → fallback a tab[0]')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  win.workspaceId = wm.getDefault().id
  browser.windows.push(win)

  const a = wm.create({ name: 'A' })
  wm.setTabSpecs(
    a.id,
    [{ id: 'first', identityId: 'default', url: 'https://1.com', title: 'One' }],
    'ghost-tab-that-doesnt-exist',
  )

  wsw.switchWorkspace({ window: win, browser, targetWorkspaceId: a.id })

  ok(
    'seleccionó tab[0] como fallback',
    win.tabs.selected && win.tabs.selected.id === 'first',
  )
}

// 7. releaseOnDestroy snapshot + libera workspaceId
section('releaseOnDestroy snapshot + libera lock')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  const a = wm.create({ name: 'A' })
  win.workspaceId = a.id
  browser.windows.push(win)

  win.tabs.create({ url: 'https://snap.com', title: 'Snap', materialize: true })
  win.tabs.select(win.tabs.tabList[0].id)

  wsw.releaseOnDestroy(win, browser)

  ok('window.workspaceId === null', win.workspaceId === null)
  ok('workspace tabSpecs persistidas', wm.get(a.id).tabSpecs.length === 1)
  ok('tabSpec.url correcto', wm.get(a.id).tabSpecs[0].url === 'https://snap.com')
  ok('activeTabId persistido', wm.get(a.id).activeTabId !== null)

  // Después de release, otro window puede tomar el WS
  const win2 = makeFakeWindow()
  win2.workspaceId = wm.getDefault().id
  browser.windows.push(win2)
  const result = wsw.switchWorkspace({
    window: win2,
    browser,
    targetWorkspaceId: a.id,
  })
  ok('otra ventana puede tomar el WS post-release', result.ok === true)
  ok('tabSpecs recreadas en la nueva ventana', win2.tabs.tabList.length === 1)
}

// 8. findWindowOwning encuentra correctamente
section('findWindowOwning')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win1 = makeFakeWindow()
  const win2 = makeFakeWindow()
  const a = wm.create({ name: 'A' })
  win1.workspaceId = a.id
  win2.workspaceId = wm.getDefault().id
  browser.windows.push(win1, win2)

  ok('encuentra owner de A', wsw.findWindowOwning(browser, a.id) === win1)
  ok(
    'encuentra owner de Default',
    wsw.findWindowOwning(browser, wm.getDefault().id) === win2,
  )
  ok('null si nadie lo tiene', wsw.findWindowOwning(browser, 'nope') === null)
}

// 9. Snapshot post-switch overrides el state previo del WS
section('Snapshot al switch sobrescribe tabSpecs viejas')
{
  const { wsw, wm } = freshWMSnapshot()
  const browser = makeFakeBrowser(wm)
  const win = makeFakeWindow()
  const a = wm.create({ name: 'A' })
  win.workspaceId = a.id
  browser.windows.push(win)

  // WS A arranca con 3 tabs persistidas
  wm.setTabSpecs(
    a.id,
    [
      { id: 'old1', identityId: 'default', url: 'https://old1.com', title: 'Old 1' },
      { id: 'old2', identityId: 'default', url: 'https://old2.com', title: 'Old 2' },
      { id: 'old3', identityId: 'default', url: 'https://old3.com', title: 'Old 3' },
    ],
    'old1',
  )

  // Recreamos solo 1 tab viva (simulando que el user cerró 2)
  win.tabs.create({
    id: 'survivor',
    url: 'https://survivor.com',
    title: 'Survivor',
    materialize: true,
  })
  win.tabs.select('survivor')

  // Switch a default
  wsw.switchWorkspace({
    window: win,
    browser,
    targetWorkspaceId: wm.getDefault().id,
  })

  const aAfter = wm.get(a.id)
  ok('A.tabSpecs.length === 1 (sobrescribió 3 viejas)', aAfter.tabSpecs.length === 1)
  ok('A.tabSpecs[0].id === survivor', aAfter.tabSpecs[0].id === 'survivor')
  ok('A.activeTabId === survivor', aAfter.activeTabId === 'survivor')
}

// ---------- Cleanup ----------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
