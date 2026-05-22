// OZ Browser — Bulk action ig_like smoke test (v2 sub-bloque 5a).
//
// Fakes Electron BrowserWindow + responder pattern that simulates an IG
// post page DOM with controllable "liked" state. Validates:
//   - Like a not-liked post → action='liked'
//   - Like an already-liked post → action='already-liked' (no click)
//   - Unlike a liked post → action='unliked'
//   - Unlike a not-liked post → action='already-unliked' (no click)
//   - needs_login early detection
//   - captcha early detection
//   - Post with neither icon → not-found
//   - Click registered but state didn't flip → click-failed
//   - Params: postUrl required

'use strict'

const { EventEmitter } = require('events')
const path = require('path')

const { buildIgLikeAction } = require('../browser/bulk-actions-ig-like')

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

// ---------- fake Electron --------------------------------------------------

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

function fakeElectron() {
  return { BrowserWindow: FakeBrowserWindow }
}

function fakeIdentityManager() {
  const map = new Map([['id1', { id: 'id1', name: 'Alice', isDefault: false }]])
  return {
    get(id) {
      return map.get(id) || null
    },
    getSession() {
      return { __label: 'fake' }
    },
  }
}

// ---------- responder simulating IG post DOM -------------------------------
//
// State machine:
//   - phase: 'loading' | 'normal' | 'login' | 'captcha' | 'no-icon'
//   - liked: bool — does the Unlike icon appear instead of Like?
//   - clickShouldFail: bool — if true, click registers but state doesn't flip

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
      // Early-signals query (executeJS IIFE with needs_login / captcha logic).
      if (script.includes('needs_login') || script.includes('captcha')) {
        if (state.phase === 'login') return 'needs_login'
        if (state.phase === 'captcha') return 'captcha'
        return null
      }
      // _waitForLikeState IIFE.
      if (
        script.includes('not-liked') ||
        script.includes("'liked'") ||
        script.includes('likeSels')
      ) {
        if (state.phase === 'no-icon') return null
        return state.liked ? 'liked' : 'not-liked'
      }
      // _clickIcon IIFE — { ok, reason }.
      if (script.includes('btn.click()')) {
        if (state.phase === 'no-icon') return { ok: false, reason: 'svg-not-found' }
        if (!state.clickShouldFail) {
          // Toggle state.
          state.liked = !state.liked
        }
        return { ok: true }
      }
      // Fallback click helper (with selector lookup + nativeInputValueSetter
      // would be type-not-like; ig_like uses raw .click()).
      if (script.includes('.click()') && script.includes('document.querySelector(')) {
        if (state.phase === 'no-icon') return { ok: false, reason: 'not-found' }
        if (!state.clickShouldFail) state.liked = !state.liked
        return { ok: true }
      }
      return undefined
    },
  }
}

// ---------- tests -----------------------------------------------------------

async function main() {
  const im = fakeIdentityManager()
  const action = buildIgLikeAction({ identityManager: im, electron: fakeElectron() })

  ok('metadata: id=ig_like', action.id === 'ig_like')
  ok('metadata: platform=instagram.com', action.platform === 'instagram.com')
  ok('metadata: paramsSchema exposes unlike', !!action.paramsSchema.properties.unlike)

  section('happy path — like a not-liked post')
  {
    const responder = buildResponder({ phase: 'normal', liked: false })
    const originalCreate = FakeBrowserWindow
    // Use a small wrapper to inject responder into the window's contents.
    let createdWin
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          createdWin = this
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    const result = await a.run(
      { id: 'id1', name: 'Alice' },
      { postUrl: 'https://www.instagram.com/p/ABC/' },
      {},
    )
    ok('action=liked', result.action === 'liked', JSON.stringify(result))
    ok('state.liked = true after click', responder.state.liked === true)
    ok('navigated to postUrl', createdWin.loadUrlCalls[0].includes('/p/ABC/'))
    ok('window closed after run', createdWin._destroyed === true)
  }

  section('happy path — already liked → no-op')
  {
    const responder = buildResponder({ phase: 'normal', liked: true })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    const result = await a.run(
      { id: 'id1' },
      { postUrl: 'https://www.instagram.com/p/X/' },
      {},
    )
    ok('action=already-liked', result.action === 'already-liked')
    ok('state.liked still true', responder.state.liked === true)
  }

  section('unlike happy path')
  {
    const responder = buildResponder({ phase: 'normal', liked: true })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    const result = await a.run(
      { id: 'id1' },
      { postUrl: 'https://www.instagram.com/p/Y/', unlike: true },
      {},
    )
    ok('action=unliked', result.action === 'unliked', JSON.stringify(result))
    ok('state.liked = false after click', responder.state.liked === false)
  }

  section('unlike when already not-liked → no-op')
  {
    const responder = buildResponder({ phase: 'normal', liked: false })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    const result = await a.run(
      { id: 'id1' },
      { postUrl: 'https://www.instagram.com/p/Z/', unlike: true },
      {},
    )
    ok('action=already-unliked', result.action === 'already-unliked')
  }

  section('needs_login early')
  {
    const responder = buildResponder({ phase: 'login' })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { postUrl: 'https://x/' }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw', !!thrown)
    ok('error.code = needs_login', thrown && thrown.code === 'needs_login')
  }

  section('captcha early')
  {
    const responder = buildResponder({ phase: 'captcha' })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { postUrl: 'https://x/' }, { signal: undefined })
    } catch (e) {
      thrown = e
    }
    ok('captcha: threw', !!thrown)
    ok('captcha: error.code', thrown && thrown.code === 'captcha')
  }

  section('not-found when neither icon appears within timeout')
  {
    const responder = buildResponder({ phase: 'no-icon' })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { postUrl: 'https://x/', timeoutMs: 6000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('not-found: threw', !!thrown)
    ok('not-found: error.code', thrown && thrown.code === 'not-found')
  }

  section('click-failed when click registers but state does not flip')
  {
    const responder = buildResponder({
      phase: 'normal',
      liked: false,
      clickShouldFail: true,
    })
    const electronInj = {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor(opts) {
          super(opts)
          this.webContents.setResponder((s) => responder.respond(s))
        }
      },
    }
    const a = buildIgLikeAction({ identityManager: im, electron: electronInj })
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { postUrl: 'https://x/', timeoutMs: 8000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('click-failed: threw', !!thrown)
    ok('click-failed: error.code', thrown && thrown.code === 'click-failed')
  }

  section('params validation: postUrl required')
  {
    let thrown = null
    try {
      await action.run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('threw on missing postUrl', !!thrown)
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    }
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Test crashed:', err)
  process.exit(1)
})
