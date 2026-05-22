// OZ Browser — Bulk action ig_follow smoke test (v2 sub-bloque 5b).
//
// Fakes Electron BrowserWindow + responder pattern that walks a simulated
// IG profile DOM. Validates the 6-state decision matrix + needs_login +
// captcha + not-found + click-failed + profileUrl normalization.

'use strict'

const { EventEmitter } = require('events')

const {
  buildIgFollowAction,
  _normalizeProfile,
} = require('../browser/bulk-actions-ig-follow')

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

// ---------- responder simulating IG profile DOM ---------------------------
//
// State:
//   - phase: 'normal' | 'login' | 'captcha' | 'no-button'
//   - followState: 'not-following' | 'following' | 'pending'
//   - clickShouldFail: bool — click registers but state doesn't flip
//   - privateAccount: bool — on follow click, transition to 'pending'
//                              instead of 'following'

function buildResponder(initial = {}) {
  const state = {
    phase: 'normal',
    followState: 'not-following',
    clickShouldFail: false,
    privateAccount: false,
    ...initial,
  }
  return {
    state,
    respond(script) {
      // needs_login / captcha early signal IIFE.
      if (script.includes('needs_login') && script.includes('captcha')) {
        if (state.phase === 'login') return 'needs_login'
        if (state.phase === 'captcha') return 'captcha'
        return null
      }
      // _waitForFollowState IIFE.
      if (script.includes('not-following') && script.includes('buttons')) {
        if (state.phase === 'no-button') return null
        return state.followState
      }
      // _clickButtonByText IIFE — returns { ok, clicked? }.
      if (script.includes('btn.click()') && script.includes('labels')) {
        if (state.phase === 'no-button') return { ok: false }
        if (state.clickShouldFail) return { ok: true, clicked: 'simulated' }
        // Detect WHICH labels-array is being clicked by checking the most
        // distinctive label in each set.
        const isConfirm =
          script.includes('"Unfollow"') ||
          script.includes('"Dejar de seguir"') ||
          script.includes('"Cancel follow request"')
        const isFollowingBtn =
          !isConfirm && (script.includes('"Following"') || script.includes('"Siguiendo"'))
        const isPendingBtn =
          !isConfirm &&
          (script.includes('"Requested"') || script.includes('"Solicitado"'))
        const isFollowBtn =
          !isConfirm &&
          !isFollowingBtn &&
          !isPendingBtn &&
          (script.includes('"Follow"') || script.includes('"Seguir"'))

        if (isConfirm) {
          // Confirmation modal "Unfollow" click → state flips to not-following.
          state.followState = 'not-following'
          return { ok: true, clicked: 'Unfollow' }
        }
        if (isFollowingBtn || isPendingBtn) {
          // Clicking Following/Requested opens the modal — state stays here,
          // confirmation click flips it.
          return { ok: true, clicked: 'opens-modal' }
        }
        if (isFollowBtn) {
          state.followState = state.privateAccount ? 'pending' : 'following'
          return { ok: true, clicked: 'Follow' }
        }
        return { ok: true, clicked: 'unknown' }
      }
      return undefined
    },
  }
}

// ---------- tests -----------------------------------------------------------

async function main() {
  const im = fakeIdentityManager()

  // Metadata
  const meta = buildIgFollowAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })
  ok('metadata: id=ig_follow', meta.id === 'ig_follow')
  ok('metadata: platform=instagram.com', meta.platform === 'instagram.com')
  ok('metadata: paramsSchema exposes unfollow', !!meta.paramsSchema.properties.unfollow)

  // Normalize tests
  section('_normalizeProfile')
  {
    const r1 = _normalizeProfile('jose')
    ok('plain username → URL', r1.url === 'https://www.instagram.com/jose/')
    ok('plain username → username', r1.username === 'jose')

    const r2 = _normalizeProfile('@jose')
    ok('@username stripped', r2.username === 'jose')

    const r3 = _normalizeProfile('https://instagram.com/jose/')
    ok('full URL parsed', r3.username === 'jose')

    const r4 = _normalizeProfile('https://www.instagram.com/jose')
    ok('URL without trailing slash', r4.username === 'jose')

    const r5 = _normalizeProfile('instagram.com/jose')
    ok('protocol-less URL', r5.username === 'jose')
  }

  function makeAction(responder) {
    return buildIgFollowAction({
      identityManager: im,
      electron: {
        BrowserWindow: class extends FakeBrowserWindow {
          constructor(opts) {
            super(opts)
            this.webContents.setResponder((s) => responder.respond(s))
          }
        },
      },
    })
  }

  section('follow happy path — public account')
  {
    const r = buildResponder({ followState: 'not-following', privateAccount: false })
    const a = makeAction(r)
    const result = await a.run({ id: 'id1', name: 'A' }, { profileUrl: 'jose' }, {})
    ok('action=followed', result.action === 'followed', JSON.stringify(result))
    ok('followState=following after click', r.state.followState === 'following')
    ok('username extracted', result.username === 'jose')
  }

  section('follow happy path — private account → requested')
  {
    const r = buildResponder({ followState: 'not-following', privateAccount: true })
    const a = makeAction(r)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'private_acct' }, {})
    ok('action=requested', result.action === 'requested', JSON.stringify(result))
    ok('followState=pending after click', r.state.followState === 'pending')
  }

  section('follow when already following → no-op')
  {
    const r = buildResponder({ followState: 'following' })
    const a = makeAction(r)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose' }, {})
    ok('action=already-following', result.action === 'already-following')
  }

  section('follow when already requested → no-op')
  {
    const r = buildResponder({ followState: 'pending' })
    const a = makeAction(r)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose' }, {})
    ok('action=already-requested', result.action === 'already-requested')
  }

  section('unfollow happy path — was following')
  {
    const r = buildResponder({ followState: 'following' })
    const a = makeAction(r)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose', unfollow: true }, {})
    ok('action=unfollowed', result.action === 'unfollowed', JSON.stringify(result))
    ok('followState=not-following after confirm', r.state.followState === 'not-following')
  }

  section('unfollow when not-following → no-op')
  {
    const r = buildResponder({ followState: 'not-following' })
    const a = makeAction(r)
    const result = await a.run({ id: 'id1' }, { profileUrl: 'jose', unfollow: true }, {})
    ok('action=already-not-following', result.action === 'already-not-following')
  }

  section('needs_login early')
  {
    const r = buildResponder({ phase: 'login' })
    const a = makeAction(r)
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { profileUrl: 'jose' }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw needs_login', thrown && thrown.code === 'needs_login')
  }

  section('captcha early')
  {
    const r = buildResponder({ phase: 'captcha' })
    const a = makeAction(r)
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { profileUrl: 'jose' }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw captcha', thrown && thrown.code === 'captcha')
  }

  section('not-found when no follow button appears')
  {
    const r = buildResponder({ phase: 'no-button' })
    const a = makeAction(r)
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { profileUrl: 'ghost', timeoutMs: 6000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw not-found', thrown && thrown.code === 'not-found')
  }

  section('click-failed when click registers but state does not flip')
  {
    const r = buildResponder({
      followState: 'not-following',
      clickShouldFail: true,
    })
    const a = makeAction(r)
    let thrown = null
    try {
      await a.run({ id: 'id1' }, { profileUrl: 'jose', timeoutMs: 8000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw click-failed', thrown && thrown.code === 'click-failed')
  }

  section('params validation: profileUrl required')
  {
    const a = makeAction(buildResponder())
    let thrown = null
    try {
      await a.run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('threw on missing profileUrl', !!thrown)
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
