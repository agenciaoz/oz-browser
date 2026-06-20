// OZ Browser — page-handlers smoke test (v3-A) with a FAKE webContents.
//
// Verifies the handler wiring (resolve tab → materialize → executeJavaScript /
// sendInputEvent / capturePage) without a real Electron runtime. The fake wc
// inspects the injected JS to return plausible values. Catches wire-up bugs
// the pure page-utils tests can't (arg passing, event sequence, error paths).
//
// Run: node tests/page-handlers.smoketest.js

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/page-handlers.js')]
const { buildPageHandlers } = require(path.join('..', 'browser', 'page-handlers.js'))

let passed = 0
function ok(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed++
    console.log('  ✓ ' + name)
  })
}

// --- fakes ------------------------------------------------------------------
function makeFakeWC() {
  const wc = {
    evals: [],
    inputs: [],
    captured: false,
    isDestroyed: () => false,
    executeJavaScript(code) {
      wc.evals.push(code)
      if (code.includes('getBoundingClientRect')) return Promise.resolve({ x: 10, y: 20 })
      if (code.includes('.focus()')) return Promise.resolve(true)
      if (code.includes('!!document.querySelector')) return Promise.resolve(true)
      // extract first — its snippet also contains getAttribute/textContent
      if (code.includes('var k in s')) return Promise.resolve({ title: 'T' })
      if (code.includes('querySelectorAll('))
        return Promise.resolve({ count: 2, items: [] })
      if (code.includes('getAttribute(')) return Promise.resolve('ATTR_VAL')
      if (code.includes('textContent')) return Promise.resolve('TEXT_VAL')
      return Promise.resolve('EVAL_VAL')
    },
    sendInputEvent(ev) {
      wc.inputs.push(ev)
    },
    capturePage() {
      wc.captured = true
      return Promise.resolve({ toPNG: () => Buffer.from('PNG') })
    },
  }
  return wc
}

function makeFakeBrowser() {
  const wc = makeFakeWC()
  const tab = {
    id: 'tab1',
    identityId: 'id1',
    materialized: true,
    webContents: wc,
    loadedUrl: null,
    materialize() {
      this.materialized = true
    },
    loadURL(u) {
      this.loadedUrl = u
    },
    serialize: () => ({ url: 'https://ex.com', title: 'Example' }),
  }
  const win = {
    id: 1,
    tabs: {
      get: (id) => (id === 'tab1' ? tab : null),
      tabList: [tab],
      created: null,
      create(opts) {
        this.created = opts
        return { id: 'tabNew', serialize: () => ({ url: opts.url }) }
      },
    },
  }
  return {
    _wc: wc,
    _tab: tab,
    _win: win,
    windows: [win],
    getFocusedWindow: () => win,
    broadcastToWebUI() {},
  }
}

async function main() {
  console.log('page-handlers smoke test (fake wc)')

  await ok('navigate loads the normalized URL into the tab', () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    const r = h.navigate({ identityId: 'id1', tabId: 'tab1', url: 'ex.com' })
    assert.strictEqual(r.ok, true)
    // normalizeOmniboxInput adds the https:// scheme (no trailing slash forced).
    assert.strictEqual(b._tab.loadedUrl, 'https://ex.com')
    assert.strictEqual(r.url, 'https://ex.com')
  })

  await ok('navigate without a tab creates one in the focused window', () => {
    const b = makeFakeBrowser()
    b._win.tabs.get = () => null
    b._win.tabs.tabList = []
    const h = buildPageHandlers(b)
    const r = h.navigate({ identityId: 'idX', url: 'https://new.com' })
    assert.strictEqual(r.created, true)
    assert.strictEqual(b._win.tabs.created.identityId, 'idX')
  })

  await ok('getText runs the textContent snippet and returns its value', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    const r = await h.getText({ identityId: 'id1', selector: 'h1' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.result, 'TEXT_VAL')
    assert.ok(b._wc.evals[0].includes('document.querySelector("h1")'))
  })

  await ok('click computes coords then fires mouseMove/Down/Up at them', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    const r = await h.click({ identityId: 'id1', selector: 'button' })
    assert.strictEqual(r.ok, true)
    const types = b._wc.inputs.map((e) => e.type)
    assert.deepStrictEqual(types, ['mouseMove', 'mouseDown', 'mouseUp'])
    assert.strictEqual(b._wc.inputs[1].x, 10)
    assert.strictEqual(b._wc.inputs[1].y, 20)
  })

  await ok('click human:true emits a Bézier trail of many mouseMoves', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    await h.click({ identityId: 'id1', selector: 'button', human: true })
    const moves = b._wc.inputs.filter((e) => e.type === 'mouseMove')
    assert.ok(moves.length > 5, `expected many moves, got ${moves.length}`)
  })

  await ok('type focuses then sends one char event per character', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    const r = await h.type({ identityId: 'id1', selector: 'input', text: 'abc' })
    assert.strictEqual(r.typed, 3)
    const chars = b._wc.inputs.filter((e) => e.type === 'char')
    assert.deepStrictEqual(
      chars.map((e) => e.keyCode),
      ['a', 'b', 'c'],
    )
  })

  await ok('screenshot returns base64 PNG', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    const r = await h.screenshot({ identityId: 'id1' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.mime, 'image/png')
    assert.strictEqual(Buffer.from(r.base64, 'base64').toString(), 'PNG')
  })

  await ok('extract returns the mapped object', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    const r = await h.extract({ identityId: 'id1', schema: { title: 'h1' } })
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(r.result, { title: 'T' })
  })

  await ok('TAB_NOT_FOUND when the identity has no tab', async () => {
    const b = makeFakeBrowser()
    b._win.tabs.get = () => null
    b._win.tabs.tabList = []
    const h = buildPageHandlers(b)
    const r = await h.getText({ identityId: 'ghost', selector: 'h1' })
    assert.ok(r.__error && r.__error.code === 'TAB_NOT_FOUND')
  })

  await ok('detectCaptcha: classifies result + raises an urgent alert', async () => {
    const b = makeFakeBrowser()
    const alerts = []
    b.alertManager = { add: (a) => alerts.push(a) }
    b._wc.executeJavaScript = () =>
      Promise.resolve({ detected: true, types: ['recaptcha'], signals: ['recaptcha'] })
    const h = buildPageHandlers(b)
    const r = await h.detectCaptcha({ identityId: 'id1' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.detected, true)
    assert.strictEqual(r.primaryType, 'recaptcha')
    assert.strictEqual(alerts.length, 1)
    assert.strictEqual(alerts[0].severity, 'urgent')
    assert.strictEqual(alerts[0].type, 'captcha-detected')
    assert.strictEqual(alerts[0].identityId, 'id1')
  })

  await ok('detectCaptcha: alert=false suppresses the alert', async () => {
    const b = makeFakeBrowser()
    const alerts = []
    b.alertManager = { add: (a) => alerts.push(a) }
    b._wc.executeJavaScript = () =>
      Promise.resolve({ detected: true, types: ['hcaptcha'], signals: ['hcaptcha'] })
    const h = buildPageHandlers(b)
    const r = await h.detectCaptcha({ identityId: 'id1', alert: false })
    assert.strictEqual(r.detected, true)
    assert.strictEqual(alerts.length, 0)
  })

  await ok('detectCaptcha: clean page → not detected, no alert', async () => {
    const b = makeFakeBrowser()
    const alerts = []
    b.alertManager = { add: (a) => alerts.push(a) }
    b._wc.executeJavaScript = () =>
      Promise.resolve({ detected: false, types: [], signals: [] })
    const h = buildPageHandlers(b)
    const r = await h.detectCaptcha({ identityId: 'id1' })
    assert.strictEqual(r.detected, false)
    assert.strictEqual(r.primaryType, null)
    assert.strictEqual(alerts.length, 0)
  })

  await ok('bad selector / bad code are rejected before touching the page', async () => {
    const b = makeFakeBrowser()
    const h = buildPageHandlers(b)
    assert.strictEqual(
      (await h.getText({ identityId: 'id1', selector: '' })).__error.code,
      'BAD_SELECTOR',
    )
    assert.strictEqual(
      (await h.eval({ identityId: 'id1', code: '  ' })).__error.code,
      'BAD_CODE',
    )
  })

  console.log(`\npage-handlers: ${passed} checks passed ✓`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
