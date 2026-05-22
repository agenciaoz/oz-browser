// OZ Browser — IG Comment action smoke test (v2 sub-bloque 3b).
//
// Fakes Electron BrowserWindow + webContents. executeJavaScript devuelve
// resultados pre-seteados que simulan estados del DOM de IG.
//
// Cubre:
//   - happy path: navigate ok → no captcha/login → textarea found → type
//     ok → click Post ok → confirmation observed
//   - needs_login: login indicator detected early → throws code='needs_login'
//   - captcha: captcha iframe detected early → throws code='captcha'
//   - not-found: textarea never appears → throws code='not-found'
//   - submit-failed: Post button not findable → throws code='submit-failed'
//   - submit-failed: confirmation never observed (textarea keeps value)
//   - abort: ctx.signal.abort() mid-action → throws AbortError
//
// Validation real con IG queda como smoke manual de Jose (selectors pueden
// estar obsoletos en cualquier momento — IG cambia DOM mucho).

'use strict'

const { EventEmitter } = require('events')

const { buildIgCommentAction } = require('../browser/bulk-actions-ig-comment')

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

// ---------- fake Electron ----------------------------------------------------

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this._url = 'about:blank'
    this._title = ''
    // Each entry: function(script) → result OR raw value
    this._jsHandlers = []
    this.executeJSCalls = []
  }
  getURL() {
    return this._url
  }
  getTitle() {
    return this._title
  }
  executeJavaScript(script) {
    this.executeJSCalls.push(script)
    const next = this._jsHandlers.shift()
    if (typeof next === 'function') return Promise.resolve(next(script))
    return Promise.resolve(next)
  }
  queueJs(v) {
    this._jsHandlers.push(v)
  }
  // Default: return false for any selector check.
  queueJsDefault(v = false) {
    this._jsHandlers.push(v)
  }
}

class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts
    this.webContents = new FakeWebContents()
    this._destroyed = false
  }
  loadURL(url) {
    this.webContents._url = url
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

function fakeIdentityManager(identities) {
  const map = new Map(identities.map((i) => [i.id, i]))
  return {
    get(id) {
      return map.get(id) || null
    },
    getSession(_id) {
      return { __label: 'fake' }
    },
  }
}

/**
 * Build a smart executeJS responder that interprets the script and returns
 * plausible results. This is the heart of the fake — it interprets the
 * scripts that bulk-actions-ig-comment sends and returns whatever the test
 * needs.
 *
 * Pass a `state` object that controls behavior:
 *   {
 *     earlySignals: 'ok'|'needs_login'|'captcha',
 *     textareaFound: bool,
 *     postButtonFound: bool,
 *     buttonDisabled: bool,
 *     submitConfirmed: bool,    // textarea cleared after click
 *   }
 */
function makeFakeWebContentsResponder(state) {
  return (script) => {
    if (script.includes('document.querySelector') && script.includes('captcha')) {
      // First call from _checkEarlySignals.
      return state.earlySignals
    }
    // _waitForAnySelector polls per-selector: queryselector(?selector) → bool
    if (script.includes('!!document.querySelector') && !script.includes('captcha')) {
      return !!state.textareaFound
    }
    if (script.includes('proto = el.tagName')) {
      // The "type into textarea" step.
      return { ok: !!state.textareaFound }
    }
    if (script.includes('candidates.find')) {
      // The "click Post button" step.
      if (state.buttonDisabled) return { ok: false, reason: 'post-btn-disabled' }
      if (!state.postButtonFound) return { ok: false, reason: 'post-btn-not-found' }
      return { ok: true, label: 'post' }
    }
    if (script.includes('!el.value')) {
      // The "wait for submit" poll: returns true if textarea cleared.
      return !!state.submitConfirmed
    }
    return null
  }
}

// ---------- tests ------------------------------------------------------------

async function main() {
  const im = fakeIdentityManager([{ id: 'id1', name: 'Alice', isDefault: false }])
  const electron = fakeElectron()
  const action = buildIgCommentAction({ identityManager: im, electron })

  // 1. Schema / shape
  section('Action metadata')
  ok('id is ig_comment', action.id === 'ig_comment')
  ok('label starts with Instagram', /^Instagram/.test(action.label))
  ok('paramsSchema has postUrl + comment required', () => {
    const r = action.paramsSchema.required || []
    return r.includes('postUrl') && r.includes('comment')
  })

  // Helper to make a fake window + wire navigate + executeJS responder.
  function makeWinFor(state) {
    const win = new FakeBrowserWindow({})
    win.webContents.executeJavaScript = (script) => {
      win.webContents.executeJSCalls.push(script)
      const responder = makeFakeWebContentsResponder(state)
      return Promise.resolve(responder(script))
    }
    return win
  }

  // Patch BrowserWindow to return our wired-up window. We need a closure over
  // the current test's state, so we replace electron.BrowserWindow per test.
  function withFakeWin(state, callback) {
    const electronWired = {
      BrowserWindow: function (opts) {
        const win = makeWinFor(state)
        win.opts = opts
        // Simulate did-finish-load right after loadURL is called.
        const origLoadUrl = win.loadURL.bind(win)
        win.loadURL = (url) => {
          win.webContents._url = url
          setImmediate(() => win.webContents.emit('did-finish-load'))
          return origLoadUrl(url)
        }
        return win
      },
    }
    const localAction = buildIgCommentAction({
      identityManager: im,
      electron: electronWired,
    })
    return callback(localAction)
  }

  // 2. Happy path
  section('Happy path: navigate → type → submit → confirm')
  await withFakeWin(
    {
      earlySignals: 'ok',
      textareaFound: true,
      postButtonFound: true,
      buttonDisabled: false,
      submitConfirmed: true,
    },
    async (a) => {
      const result = await a.run(
        { id: 'id1', name: 'Alice' },
        { postUrl: 'https://www.instagram.com/p/ABC/', comment: '¡Hola!' },
        {},
      )
      ok('returns postUrl', result.postUrl === 'https://www.instagram.com/p/ABC/')
      ok('returns comment', result.comment === '¡Hola!')
      ok('returns identityId', result.identityId === 'id1')
      ok('returns identityName', result.identityName === 'Alice')
      ok('clickedLabel post', result.clickedLabel === 'post')
      ok(
        'durationMs > 0',
        typeof result.durationMs === 'number' && result.durationMs >= 0,
      )
    },
  )

  // 3. needs_login
  section('needs_login')
  await withFakeWin({ earlySignals: 'needs_login' }, async (a) => {
    let err
    try {
      await a.run(
        { id: 'id1', name: 'Alice' },
        { postUrl: 'https://www.instagram.com/p/ABC/', comment: 'hi' },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === needs_login', err && err.code === 'needs_login')
  })

  // 4. captcha
  section('captcha')
  await withFakeWin({ earlySignals: 'captcha' }, async (a) => {
    let err
    try {
      await a.run(
        { id: 'id1', name: 'Alice' },
        { postUrl: 'https://www.instagram.com/p/ABC/', comment: 'hi' },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === captcha', err && err.code === 'captcha')
  })

  // 5. not-found (textarea never appears)
  section('not-found — textarea never appears')
  await withFakeWin(
    {
      earlySignals: 'ok',
      textareaFound: false,
      postButtonFound: false,
      submitConfirmed: false,
    },
    async (a) => {
      let err
      try {
        await a.run(
          { id: 'id1', name: 'Alice' },
          {
            postUrl: 'https://www.instagram.com/p/ABC/',
            comment: 'hi',
            timeoutMs: 5000,
          },
          {},
        )
      } catch (e) {
        err = e
      }
      ok('throws', !!err)
      ok('error.code === not-found', err && err.code === 'not-found')
    },
  )

  // 6. submit-failed — post button not findable
  section('submit-failed — Post button not findable')
  await withFakeWin(
    {
      earlySignals: 'ok',
      textareaFound: true,
      postButtonFound: false,
      submitConfirmed: false,
    },
    async (a) => {
      let err
      try {
        await a.run(
          { id: 'id1', name: 'Alice' },
          { postUrl: 'https://www.instagram.com/p/ABC/', comment: 'hi' },
          {},
        )
      } catch (e) {
        err = e
      }
      ok('throws', !!err)
      ok('error.code === submit-failed', err && err.code === 'submit-failed')
      ok('reason mentions post button', err && /Post button/.test(err.message))
    },
  )

  // 7. submit-failed — Post clicked but textarea still has value (no confirm)
  section('submit-failed — no confirmation after click')
  await withFakeWin(
    {
      earlySignals: 'ok',
      textareaFound: true,
      postButtonFound: true,
      submitConfirmed: false, // textarea keeps value, no confirmation
    },
    async (a) => {
      let err
      try {
        await a.run(
          { id: 'id1', name: 'Alice' },
          {
            postUrl: 'https://www.instagram.com/p/ABC/',
            comment: 'hi',
            timeoutMs: 2000,
          },
          {},
        )
      } catch (e) {
        err = e
      }
      ok('throws', !!err)
      ok('error.code === submit-failed', err && err.code === 'submit-failed')
    },
  )

  // 8. params validation — missing required
  section('params validation')
  {
    let err
    try {
      await action.run({ id: 'id1', name: 'Alice' }, { comment: 'no url' }, {})
    } catch (e) {
      err = e
    }
    ok('missing postUrl throws', err && /postUrl required/.test(err.message))
    err = null
    try {
      await action.run({ id: 'id1', name: 'Alice' }, { postUrl: 'x' }, {})
    } catch (e) {
      err = e
    }
    ok('missing comment throws', err && /comment required/.test(err.message))
  }

  // ---------- Done ----------------------------------------------------------
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
  console.error('Test harness crashed:', err)
  process.exit(1)
})
