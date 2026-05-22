// OZ Browser — Bulk action tiktok_like smoke test (v2 sub-bloque 5d).

'use strict'

const { EventEmitter } = require('events')
const { buildTiktokLikeAction } = require('../browser/bulk-actions-tiktok-like')

let passed = 0
let failed = 0

function ok(label, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}

function section(name) {
  console.log(`\n— ${name} —`)
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this._url = 'about:blank'
    this._responder = null
  }
  getURL() {
    return this._url
  }
  setResponder(fn) {
    this._responder = fn
  }
  executeJavaScript(script) {
    if (this._responder) {
      try {
        return Promise.resolve(this._responder(script, this))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    return Promise.resolve(undefined)
  }
}

class FakeBrowserWindow {
  constructor() {
    this.webContents = new FakeWebContents()
    this.loadUrlCalls = []
    this._destroyed = false
  }
  loadURL(url) {
    this.loadUrlCalls.push(url)
    this.webContents._url = url
    setImmediate(() => this.webContents.emit('did-finish-load'))
    return Promise.resolve()
  }
  isDestroyed() {
    return this._destroyed
  }
  destroy() {
    this._destroyed = true
  }
  close() {
    this._destroyed = true
  }
}

function fakeIM() {
  const map = new Map([['id1', { id: 'id1' }]])
  return {
    get(id) {
      return map.get(id) || null
    },
    getSession() {
      return { __label: 'fake' }
    },
  }
}

function buildResponder(initial = {}) {
  const state = {
    phase: 'normal',
    liked: false,
    clickShouldFail: false,
    ...initial,
  }
  return {
    state,
    respond(script) {
      if (script.includes('needs_login') && script.includes('captcha')) {
        if (state.phase === 'login') return 'needs_login'
        if (state.phase === 'captcha') return 'captcha'
        return null
      }
      // _waitForLikeState IIFE returns 'liked'/'not-liked'/null.
      if (script.includes('aria-pressed') && script.includes('like-icon')) {
        if (state.phase === 'no-button') return null
        return state.liked ? 'liked' : 'not-liked'
      }
      // _clickButton IIFE returns {ok}.
      if (script.includes('btn.click()')) {
        if (state.phase === 'no-button') return { ok: false }
        if (!state.clickShouldFail) state.liked = !state.liked
        return { ok: true }
      }
      return undefined
    },
  }
}

function makeAction(responder, im) {
  return buildTiktokLikeAction({
    identityManager: im,
    electron: {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor() {
          super()
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    },
  })
}

async function main() {
  const im = fakeIM()
  const meta = buildTiktokLikeAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })
  ok('id=tiktok_like', meta.id === 'tiktok_like')
  ok('platform=tiktok.com', meta.platform === 'tiktok.com')

  section('happy path')
  {
    const r = buildResponder({ liked: false })
    const a = makeAction(r, im)
    const result = await a.run(
      { id: 'id1' },
      { videoUrl: 'https://tiktok.com/@u/video/1' },
      {},
    )
    ok('action=liked', result.action === 'liked')
    ok('liked toggled', r.state.liked === true)
  }

  section('already liked')
  {
    const r = buildResponder({ liked: true })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { videoUrl: 'x' }, {})
    ok('action=already-liked', result.action === 'already-liked')
  }

  section('unlike happy')
  {
    const r = buildResponder({ liked: true })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { videoUrl: 'x', unlike: true }, {})
    ok('action=unliked', result.action === 'unliked')
  }

  section('unlike already not-liked')
  {
    const r = buildResponder({ liked: false })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { videoUrl: 'x', unlike: true }, {})
    ok('action=already-not-liked', result.action === 'already-not-liked')
  }

  section('needs_login / captcha / not-found / click-failed / params')
  {
    const cases = [
      { init: { phase: 'login' }, code: 'needs_login' },
      { init: { phase: 'captcha' }, code: 'captcha' },
      { init: { phase: 'no-button' }, code: 'not-found' },
      {
        init: { liked: false, clickShouldFail: true },
        code: 'click-failed',
      },
    ]
    for (const c of cases) {
      const r = buildResponder(c.init)
      const a = makeAction(r, im)
      let thrown
      try {
        await a.run({ id: 'id1' }, { videoUrl: 'x', timeoutMs: 8000 }, {})
      } catch (e) {
        thrown = e
      }
      ok(`code=${c.code}`, thrown && thrown.code === c.code)
    }
    // missing videoUrl
    let thrown
    try {
      await makeAction(buildResponder(), im).run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('threw on missing videoUrl', !!thrown)
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
