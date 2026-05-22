// OZ Browser — Bulk action tiktok_follow smoke test (v2 sub-bloque 5d).

'use strict'

const { EventEmitter } = require('events')
const {
  buildTiktokFollowAction,
  _normalizeProfile,
} = require('../browser/bulk-actions-tiktok-follow')

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
    followState: 'not-following',
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
      if (script.includes('not-following') && script.includes('buttons')) {
        if (state.phase === 'no-button') return null
        return state.followState
      }
      if (script.includes('btn.click()') && script.includes('labels')) {
        if (state.phase === 'no-button') return { ok: false }
        if (state.clickShouldFail) return { ok: true }
        const isConfirm =
          script.includes('"Unfollow"') || script.includes('"Dejar de seguir"')
        const isFollowing =
          !isConfirm &&
          (script.includes('"Following"') ||
            script.includes('"Friends"') ||
            script.includes('"Siguiendo"'))
        const isFollow =
          !isConfirm &&
          !isFollowing &&
          (script.includes('"Follow"') || script.includes('"Seguir"'))
        if (isConfirm) {
          state.followState = 'not-following'
          return { ok: true }
        }
        if (isFollowing) {
          return { ok: true }
        }
        if (isFollow) {
          state.followState = 'following'
          return { ok: true }
        }
        return { ok: true }
      }
      return undefined
    },
  }
}

function makeAction(responder, im) {
  return buildTiktokFollowAction({
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
  const meta = buildTiktokFollowAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })
  ok('id=tiktok_follow', meta.id === 'tiktok_follow')
  ok('platform=tiktok.com', meta.platform === 'tiktok.com')

  section('_normalizeProfile')
  {
    ok('plain', _normalizeProfile('jose').username === 'jose')
    ok('@', _normalizeProfile('@jose').username === 'jose')
    ok('URL', _normalizeProfile('https://tiktok.com/@jose').username === 'jose')
    ok('URL w/o @', _normalizeProfile('https://www.tiktok.com/jose/').username === 'jose')
  }

  section('follow happy')
  {
    const r = buildResponder({ followState: 'not-following' })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose' }, {})
    ok('action=followed', result.action === 'followed')
    ok('username=jose', result.username === 'jose')
  }

  section('already following')
  {
    const r = buildResponder({ followState: 'following' })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose' }, {})
    ok('action=already-following', result.action === 'already-following')
  }

  section('unfollow happy')
  {
    const r = buildResponder({ followState: 'following' })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose', unfollow: true }, {})
    ok('action=unfollowed', result.action === 'unfollowed')
  }

  section('unfollow already not')
  {
    const r = buildResponder({ followState: 'not-following' })
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose', unfollow: true }, {})
    ok('action=already-not-following', result.action === 'already-not-following')
  }

  section('errors')
  {
    const cases = [
      { init: { phase: 'login' }, code: 'needs_login' },
      { init: { phase: 'captcha' }, code: 'captcha' },
      { init: { phase: 'no-button' }, code: 'not-found' },
      {
        init: { followState: 'not-following', clickShouldFail: true },
        code: 'click-failed',
      },
    ]
    for (const c of cases) {
      const r = buildResponder(c.init)
      const a = makeAction(r, im)
      let thrown
      try {
        await a.run({ id: 'id1' }, { profileUrl: 'jose', timeoutMs: 8000 }, {})
      } catch (e) {
        thrown = e
      }
      ok(`code=${c.code}`, thrown && thrown.code === c.code)
    }
    let thrown
    try {
      await makeAction(buildResponder(), im).run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('threw on missing profileUrl', !!thrown)
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
