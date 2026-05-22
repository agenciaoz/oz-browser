// OZ Browser — Bulk action x_like smoke test (v2 sub-bloque 5c).

'use strict'

const { EventEmitter } = require('events')

const { buildXLikeAction } = require('../browser/bulk-actions-x-like')

let passed = 0
let failed = 0

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
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
    phase: 'normal', // 'normal' | 'login' | 'captcha' | 'no-button'
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
      // _waitForLikeState IIFE.
      if (script.includes('likeSels') && script.includes('unlikeSels')) {
        if (state.phase === 'no-button') return null
        return state.liked ? 'liked' : 'not-liked'
      }
      // _clickFirst IIFE.
      if (script.includes('el.click()')) {
        if (state.phase === 'no-button') return { ok: false }
        if (!state.clickShouldFail) state.liked = !state.liked
        return { ok: true }
      }
      return undefined
    },
  }
}

function makeAction(responder, im) {
  return buildXLikeAction({
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

  const meta = buildXLikeAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })
  ok('id=x_like', meta.id === 'x_like')
  ok('platform=x.com', meta.platform === 'x.com')
  ok('schema has unlike', !!meta.paramsSchema.properties.unlike)

  section('like — happy')
  {
    const r = buildResponder({ liked: false })
    const a = makeAction(r, im)
    const result = await a.run(
      { id: 'id1' },
      { tweetUrl: 'https://x.com/u/status/1' },
      {},
    )
    ok('action=liked', result.action === 'liked')
    ok('liked = true', r.state.liked === true)
  }

  section('like — already liked')
  {
    const r = buildResponder({ liked: true })
    const a = makeAction(r, im)
    const result = await a.run(
      { id: 'id1' },
      { tweetUrl: 'https://x.com/u/status/1' },
      {},
    )
    ok('action=already-liked', result.action === 'already-liked')
  }

  section('unlike — happy')
  {
    const r = buildResponder({ liked: true })
    const a = makeAction(r, im)
    const result = await a.run(
      { id: 'id1' },
      { tweetUrl: 'https://x.com/u/status/1', unlike: true },
      {},
    )
    ok('action=unliked', result.action === 'unliked')
    ok('liked = false', r.state.liked === false)
  }

  section('unlike — already not-liked')
  {
    const r = buildResponder({ liked: false })
    const a = makeAction(r, im)
    const result = await a.run(
      { id: 'id1' },
      { tweetUrl: 'https://x.com/u/status/1', unlike: true },
      {},
    )
    ok('action=already-not-liked', result.action === 'already-not-liked')
  }

  section('needs_login')
  {
    const r = buildResponder({ phase: 'login' })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { tweetUrl: 'x' }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw needs_login', thrown && thrown.code === 'needs_login')
  }

  section('captcha')
  {
    const r = buildResponder({ phase: 'captcha' })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { tweetUrl: 'x' }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw captcha', thrown && thrown.code === 'captcha')
  }

  section('not-found')
  {
    const r = buildResponder({ phase: 'no-button' })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { tweetUrl: 'x', timeoutMs: 6000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw not-found', thrown && thrown.code === 'not-found')
  }

  section('click-failed')
  {
    const r = buildResponder({ liked: false, clickShouldFail: true })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { tweetUrl: 'x', timeoutMs: 8000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw click-failed', thrown && thrown.code === 'click-failed')
  }

  section('params: tweetUrl required')
  {
    const a = makeAction(buildResponder(), im)
    let thrown
    try {
      await a.run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('threw on missing tweetUrl', !!thrown)
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
