// OZ Browser — IG Post action smoke test (v2 sub-bloque 3c).
//
// Fakes Electron BrowserWindow + webContents + debugger CDP.
// executeJavaScript devuelve resultados pre-seteados que simulan el DOM
// de IG en cada etapa del flow (home → create → file input → next → next
// → caption → share → confirmation).
//
// Cubre:
//   - happy path completo con caption
//   - happy path sin caption (caption='' bypass del step)
//   - image-missing: imagePath inexistente → throws code='image-missing'
//   - needs_login: detected after navigate → throws code='needs_login'
//   - captcha: detected after navigate → throws code='captcha'
//   - not-found: Create button never appears → throws code='not-found'
//   - submit-failed: confirmation never observed
//   - params validation
//
// Validation real con IG queda como smoke manual de Jose.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { buildIgPostAction } = require('../browser/bulk-actions-ig-post')

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

// ---------- fakes ------------------------------------------------------------

class FakeDebugger {
  constructor() {
    this.commands = []
    this.attached = false
  }
  attach() {
    this.attached = true
  }
  detach() {
    this.attached = false
  }
  async sendCommand(method, params) {
    this.commands.push({ method, params })
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 42 }
    if (method === 'DOM.setFileInputFiles') return {}
    return {}
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this._url = 'about:blank'
    this._title = ''
    this.debugger = new FakeDebugger()
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
    // Each test provides a responder via this.responder
    if (this.responder) return Promise.resolve(this.responder(script))
    return Promise.resolve(null)
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

function buildElectronWithResponder(responder) {
  return {
    BrowserWindow: function (opts) {
      const win = new FakeBrowserWindow(opts)
      win.webContents.responder = responder
      return win
    },
  }
}

/**
 * Build a stateful responder that returns plausible results based on the
 * step. `state` controls behavior — see field comments.
 */
function makeStatefulResponder(state) {
  const s = {
    earlySignals: 'ok',
    createClickable: true,
    fileInputAvailable: true,
    nextClickable: true,
    captionAvailable: true,
    shareClickable: true,
    confirmed: true,
    nextClickCount: 0,
    ...state,
  }
  return (script) => {
    // _checkEarlySignals.
    if (script.includes("'captcha'") && script.includes("'needs_login'")) {
      return s.earlySignals
    }
    // _findAndClickByText — DOM walker. Inspect labels for which step we're in.
    // The action lowercases labels before embedding them in the script.
    if (script.includes('candidates') && script.includes('Array.from')) {
      const lowScript = script.toLowerCase()
      // Determine intent by what's embedded in the labels array.
      if (
        lowScript.includes('"new post"') ||
        lowScript.includes('"nueva publicación"') ||
        lowScript.includes('"crear"')
      ) {
        return s.createClickable ? { ok: true, label: 'new post' } : { ok: false }
      }
      // alpha.117: diálogo best-effort de reel ("OK/Aceptar/Got it") al subir
      // video. Se chequea ANTES de next para no confundir con nada.
      if (
        lowScript.includes('"ok"') ||
        lowScript.includes('"aceptar"') ||
        lowScript.includes('"entendido"') ||
        lowScript.includes('"got it"')
      ) {
        return s.reelDialogClickable !== false ? { ok: true, label: 'ok' } : { ok: false }
      }
      if (lowScript.includes('"next"') || lowScript.includes('"siguiente"')) {
        s.nextClickCount++
        return s.nextClickable ? { ok: true, label: 'next' } : { ok: false }
      }
      if (lowScript.includes('"share"') || lowScript.includes('"compartir"')) {
        return s.shareClickable ? { ok: true, label: 'share' } : { ok: false }
      }
      return { ok: false }
    }
    // _waitForConfirmation — check FIRST because its script contains
    // `!!document.querySelector('main[role="main"]')` which would otherwise
    // match the generic waitForAnySelector branch below.
    if (
      script.includes('post has been shared') ||
      script.includes('publicación se compartió')
    ) {
      return !!s.confirmed
    }
    // _waitForAnySelector single-selector check.
    if (script.includes('!!document.querySelector')) {
      if (script.includes('input[type="file"]')) {
        return !!s.fileInputAvailable
      }
      if (
        script.includes('caption') ||
        script.includes('pie de foto') ||
        script.includes('contenteditable')
      ) {
        return !!s.captionAvailable
      }
      return true
    }
    // _typeIntoField.
    if (script.includes('proto = el.tagName')) {
      return { ok: true }
    }
    return null
  }
}

// ---------- tests ------------------------------------------------------------

async function main() {
  // Create a temp image file for tests.
  const TEST_IMAGE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'oz-ig-post-')),
    'test.jpg',
  )
  fs.writeFileSync(TEST_IMAGE, Buffer.from('fake-jpeg-bytes'))
  const TEST_VIDEO = path.join(path.dirname(TEST_IMAGE), 'test.mp4')
  fs.writeFileSync(TEST_VIDEO, Buffer.from('fake-mp4-bytes'))

  const im = fakeIdentityManager([{ id: 'id1', name: 'Alice', isDefault: false }])

  // 1. Action metadata
  section('Action metadata')
  const meta = buildIgPostAction({
    identityManager: im,
    electron: buildElectronWithResponder(makeStatefulResponder({})),
  })
  ok('id is ig_post', meta.id === 'ig_post')
  ok('label has Instagram', /Instagram/.test(meta.label))
  // alpha.117: ig_post ahora acepta imagen O video (Reel) — ya no hay
  // `required:['imagePath']`; la validación "uno de los dos" vive en run().
  ok(
    'schema acepta imagePath y videoPath',
    !!meta.paramsSchema.properties.imagePath && !!meta.paramsSchema.properties.videoPath,
  )

  // 2. Happy path with caption
  section('Happy path: with caption')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({})),
    })
    const result = await action.run(
      { id: 'id1', name: 'Alice' },
      { imagePath: TEST_IMAGE, caption: 'Hola mundo' },
      {},
    )
    ok('returns imagePath', result.imagePath === TEST_IMAGE)
    ok('returns caption', result.caption === 'Hola mundo')
    ok('returns identityId', result.identityId === 'id1')
    ok('returns identityName', result.identityName === 'Alice')
    ok('durationMs > 0', typeof result.durationMs === 'number' && result.durationMs >= 0)
  }

  // 2b. Happy path: video/Reel (alpha.117)
  section('Happy path: video (Reel)')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({})),
    })
    const result = await action.run(
      { id: 'id1', name: 'Alice' },
      { videoPath: TEST_VIDEO, caption: 'Mi reel' },
      {},
    )
    ok('returns videoPath', result.videoPath === TEST_VIDEO)
    ok('mediaType = video', result.mediaType === 'video')
    ok('no devuelve imagePath', result.imagePath === undefined)
    ok('returns caption', result.caption === 'Mi reel')
  }

  // 2c. Video sigue funcionando si el diálogo de reel NO aparece (best-effort)
  section('Video: sin diálogo de reel (best-effort skip)')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(
        makeStatefulResponder({ reelDialogClickable: false }),
      ),
    })
    const result = await action.run(
      { id: 'id1', name: 'Alice' },
      { videoPath: TEST_VIDEO },
      {},
    )
    ok('completa igual sin el diálogo', result.mediaType === 'video')
  }

  // video-missing
  section('Error: video not found')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({})),
    })
    let err
    try {
      await action.run({ id: 'id1', name: 'Alice' }, { videoPath: '/nope/x.mp4' }, {})
    } catch (e) {
      err = e
    }
    ok('video inexistente → image-missing code', err && err.code === 'image-missing')
  }

  // 3. Happy path without caption
  section('Happy path: caption empty')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({})),
    })
    const result = await action.run(
      { id: 'id1', name: 'Alice' },
      { imagePath: TEST_IMAGE },
      {},
    )
    ok('returns empty caption', result.caption === '')
    ok('still completes', !!result.imagePath)
  }

  // 4. image-missing
  section('image-missing')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({})),
    })
    let err
    try {
      await action.run(
        { id: 'id1', name: 'Alice' },
        { imagePath: '/tmp/does-not-exist-xyz.jpg', caption: 'x' },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === image-missing', err && err.code === 'image-missing')
  }

  // 5. needs_login
  section('needs_login')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(
        makeStatefulResponder({ earlySignals: 'needs_login' }),
      ),
    })
    let err
    try {
      await action.run(
        { id: 'id1', name: 'Alice' },
        { imagePath: TEST_IMAGE, caption: 'x' },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === needs_login', err && err.code === 'needs_login')
  }

  // 6. captcha
  section('captcha')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(
        makeStatefulResponder({ earlySignals: 'captcha' }),
      ),
    })
    let err
    try {
      await action.run(
        { id: 'id1', name: 'Alice' },
        { imagePath: TEST_IMAGE, caption: 'x' },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === captcha', err && err.code === 'captcha')
  }

  // 7. not-found — Create button missing
  section('not-found — Create button missing')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(
        makeStatefulResponder({ createClickable: false }),
      ),
    })
    let err
    try {
      await action.run(
        { id: 'id1', name: 'Alice' },
        { imagePath: TEST_IMAGE, caption: 'x', timeoutMs: 15_000 },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === not-found', err && err.code === 'not-found')
  }

  // 8. submit-failed — no confirmation
  section('submit-failed — no confirmation')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({ confirmed: false })),
    })
    let err
    try {
      await action.run(
        { id: 'id1', name: 'Alice' },
        { imagePath: TEST_IMAGE, caption: 'x', timeoutMs: 11_000 },
        {},
      )
    } catch (e) {
      err = e
    }
    ok('throws', !!err)
    ok('error.code === submit-failed', err && err.code === 'submit-failed')
  }

  // 9. params validation
  section('params validation')
  {
    const action = buildIgPostAction({
      identityManager: im,
      electron: buildElectronWithResponder(makeStatefulResponder({})),
    })
    let err
    try {
      await action.run({ id: 'id1', name: 'Alice' }, { caption: 'no media' }, {})
    } catch (e) {
      err = e
    }
    ok(
      'missing image/video throws',
      err && /imagePath or videoPath required/.test(err.message),
    )
    // imagePath + videoPath juntos → error.
    let errBoth
    try {
      await action.run(
        { id: 'id1', name: 'Alice' },
        { imagePath: '/a.jpg', videoPath: '/b.mp4' },
        {},
      )
    } catch (e) {
      errBoth = e
    }
    ok(
      'imagePath + videoPath juntos → throws',
      errBoth && /not both/.test(errBoth.message),
    )
  }

  // Done
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
