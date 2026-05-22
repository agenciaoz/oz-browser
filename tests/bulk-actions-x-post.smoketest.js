// OZ Browser — Bulk action x_post smoke test (v2 sub-bloque 5c).

'use strict'

const { EventEmitter } = require('events')

const { buildXPostAction } = require('../browser/bulk-actions-x-post')

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
  const map = new Map([['id1', { id: 'id1', name: 'Alice' }]])
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
    phase: 'normal', // 'normal' | 'login' | 'captcha' | 'no-textarea' | 'submit-no-confirm'
    composeVisible: true,
    submitEnabled: false,
    textTyped: '',
    submitClicked: false,
    ...initial,
  }
  return {
    state,
    respond(script) {
      // Early signals.
      if (script.includes('needs_login') && script.includes('captcha')) {
        if (state.phase === 'login') return 'needs_login'
        if (state.phase === 'captcha') return 'captcha'
        return null
      }
      // Simple existence query for compose textarea.
      if (script.startsWith('!!document.querySelector(')) {
        const m = script.match(/!!document\.querySelector\((".+?")\)$/)
        if (m) {
          const sel = JSON.parse(m[1])
          if (sel.includes('tweetTextarea') || sel.includes('contenteditable')) {
            return state.composeVisible && state.phase !== 'no-textarea'
          }
          return false
        }
      }
      // _waitForConfirmation IIFE — MUST come before the textContent check
      // because this script also references textContent (for toast text).
      if (script.includes('textareaStillThere')) {
        return !state.composeVisible
      }
      // _waitForAnyEnabled — checks disabled/aria-disabled.
      if (script.includes('hasAttribute') && script.includes('aria-disabled')) {
        return state.submitEnabled
      }
      // _typeContentEditable IIFE.
      if (script.includes('execCommand')) {
        const m = script.match(/insertText',\s*false,\s*("[\s\S]*?")\)/)
        if (m) {
          try {
            state.textTyped = JSON.parse(m[1])
            state.submitEnabled = state.textTyped.length > 0
          } catch (_e) {}
        }
        return { ok: true }
      }
      // _clickButton IIFE.
      if (script.includes('el.click()')) {
        state.submitClicked = true
        if (state.phase !== 'submit-no-confirm') {
          state.composeVisible = false // simulate modal close after publish
        }
        return { ok: true }
      }
      return undefined
    },
  }
}

function makeAction(responder, im) {
  return buildXPostAction({
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

  // Metadata
  const meta = buildXPostAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })
  ok('id=x_post', meta.id === 'x_post')
  ok('platform=x.com', meta.platform === 'x.com')
  ok('text required in schema', meta.paramsSchema.required.includes('text'))
  ok('text max 280', meta.paramsSchema.properties.text.maxLength === 280)

  section('happy path')
  {
    const r = buildResponder()
    const a = makeAction(r, im)
    const result = await a.run({ id: 'id1' }, { text: 'Hello world!' }, {})
    ok('returns text', result.text === 'Hello world!')
    ok('typed', r.state.textTyped === 'Hello world!')
    ok('submit clicked', r.state.submitClicked === true)
    ok('compose closed (confirm)', r.state.composeVisible === false)
  }

  section('needs_login')
  {
    const r = buildResponder({ phase: 'login' })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { text: 'x' }, {})
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
      await a.run({ id: 'id1' }, { text: 'x' }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw captcha', thrown && thrown.code === 'captcha')
  }

  section('not-found (textarea missing)')
  {
    const r = buildResponder({ phase: 'no-textarea', composeVisible: false })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { text: 'x', timeoutMs: 6000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw not-found', thrown && thrown.code === 'not-found')
  }

  section('submit-failed (compose still visible after click)')
  {
    const r = buildResponder({ phase: 'submit-no-confirm' })
    const a = makeAction(r, im)
    let thrown
    try {
      await a.run({ id: 'id1' }, { text: 'x', timeoutMs: 8000 }, {})
    } catch (e) {
      thrown = e
    }
    ok('threw submit-failed', thrown && thrown.code === 'submit-failed')
  }

  section('params: text required')
  {
    const a = buildXPostAction({
      identityManager: im,
      electron: { BrowserWindow: FakeBrowserWindow },
    })
    let thrown
    try {
      await a.run({ id: 'id1' }, {}, {})
    } catch (e) {
      thrown = e
    }
    ok('threw on missing text', !!thrown)
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
