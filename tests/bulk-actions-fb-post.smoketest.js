// OZ Browser — Bulk action fb_post smoke test (v2 Publishing Etapa 6).
//
// Drives buildFbPostAction with a fake BrowserWindow whose executeJavaScript
// responder is keyed by distinctive substrings of each injected script, the
// same harness style as bulk-actions-fb-like.smoketest.js.

'use strict'

const { EventEmitter } = require('events')
const { buildFbPostAction } = require('../browser/bulk-actions-fb-post')

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
        return Promise.resolve(this._responder(script))
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
    this._destroyed = false
  }
  loadURL(url) {
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
  const map = new Map([['id1', { id: 'id1', name: 'Pedro' }]])
  return {
    get(id) {
      return map.get(id) || null
    },
    getSession() {
      return { __label: 'fake' }
    },
  }
}

// phase: 'normal' | 'login' | 'captcha' | 'no-textbox'
function buildResponder(phase = 'normal') {
  return function respond(script) {
    // 1. Early signals (needs_login + captcha both referenced).
    if (script.includes('needs_login') && script.includes('captcha')) {
      if (phase === 'login') return 'needs_login'
      if (phase === 'captcha') return 'captcha'
      return null
    }
    // 2. Confirmation: dialog-gone check → success (textbox no longer present).
    if (script.includes('Create-post dialog gone')) return true
    // 3. Type via execCommand.
    if (script.includes("execCommand('insertText'")) return { ok: true }
    // 4. Enabled check (submit button).
    if (script.includes('aria-disabled')) return true
    // 5. Availability check (textbox present?).
    if (script.includes('!!document.querySelector')) {
      return phase !== 'no-textbox'
    }
    // 6. Opener / submit clicks.
    if (script.includes('el.click()')) return { ok: true }
    return undefined
  }
}

function makeAction(phase, im) {
  return buildFbPostAction({
    identityManager: im,
    electron: {
      BrowserWindow: class extends FakeBrowserWindow {
        constructor() {
          super()
          this.webContents.setResponder(buildResponder(phase))
        }
      },
    },
  })
}

async function main() {
  const im = fakeIM()
  const meta = buildFbPostAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })

  section('metadata')
  ok('id=fb_post', meta.id === 'fb_post')
  ok('platform=facebook.com', meta.platform === 'facebook.com')
  ok('schema requires text', meta.paramsSchema.required.includes('text'))
  ok('text max 5000', meta.paramsSchema.properties.text.maxLength === 5000)

  section('happy path')
  {
    const a = makeAction('normal', im)
    const result = await a.run({ id: 'id1', name: 'Pedro' }, { text: 'hola mundo' }, {})
    ok('returns text', result.text === 'hola mundo')
    ok('returns identityName', result.identityName === 'Pedro')
    ok('durationMs is a number', typeof result.durationMs === 'number')
  }

  section('errors')
  {
    const cases = [
      { phase: 'login', code: 'needs_login' },
      { phase: 'captcha', code: 'captcha' },
      { phase: 'no-textbox', code: 'not-found' },
    ]
    for (const c of cases) {
      const a = makeAction(c.phase, im)
      let thrown
      try {
        await a.run({ id: 'id1' }, { text: 'x', timeoutMs: 8000 }, {})
      } catch (e) {
        thrown = e
      }
      ok(`${c.phase} → code=${c.code}`, thrown && thrown.code === c.code)
    }
  }

  section('validation')
  {
    const a = makeAction('normal', im)
    let thrown
    try {
      await a.run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('missing text throws', !!thrown)
  }

  console.log(`\nbulk-actions-fb-post: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

main()
