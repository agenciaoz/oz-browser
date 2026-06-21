// OZ Browser — Bulk action threads_post smoke test (v2 Publishing Etapa 6).
//
// Same fake-BrowserWindow responder harness as bulk-actions-fb-post.

'use strict'

const { EventEmitter } = require('events')
const { buildThreadsPostAction } = require('../browser/bulk-actions-threads-post')

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
    if (script.includes('needs_login') && script.includes('captcha')) {
      if (phase === 'login') return 'needs_login'
      if (phase === 'captcha') return 'captcha'
      return null
    }
    if (script.includes('Thread-composer textbox gone')) return true
    if (script.includes("execCommand('insertText'")) return { ok: true }
    if (script.includes('aria-disabled')) return true
    if (script.includes('!!document.querySelector')) {
      return phase !== 'no-textbox'
    }
    if (script.includes('el.click()')) return { ok: true }
    return undefined
  }
}

function makeAction(phase, im) {
  return buildThreadsPostAction({
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
  const meta = buildThreadsPostAction({
    identityManager: im,
    electron: { BrowserWindow: FakeBrowserWindow },
  })

  section('metadata')
  ok('id=threads_post', meta.id === 'threads_post')
  ok('platform=threads.net', meta.platform === 'threads.net')
  ok('schema requires text', meta.paramsSchema.required.includes('text'))
  ok('text max 500', meta.paramsSchema.properties.text.maxLength === 500)

  section('happy path')
  {
    const a = makeAction('normal', im)
    const result = await a.run({ id: 'id1', name: 'Pedro' }, { text: 'un hilo' }, {})
    ok('returns text', result.text === 'un hilo')
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

  console.log(`\nbulk-actions-threads-post: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

main()
