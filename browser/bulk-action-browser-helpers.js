// OZ Browser — Bulk action browser automation helpers (v2 sub-bloque 3a).
//
// Utilities reutilizables que cualquier action que necesite real browser
// automation va a usar: spawn de BrowserWindow per identity, navigate
// con timeout, waitForSelector, click, type, screenshot, safeClose.
//
// Todos los helpers honran `ctx.signal` (AbortSignal) — si el run se
// cancela, las operaciones largas (navigate, waitForSelector) rechazan
// con error name='AbortError' que el BulkRunner reconoce.
//
// Pattern de uso desde un action handler:
//   const { spawnIdentityWindow, safeClose, navigate, waitForSelector,
//           executeJS, screenshot } = require('./bulk-action-browser-helpers')
//
//   const win = await spawnIdentityWindow({ identityManager, identityId, signal })
//   try {
//     await navigate(win, 'https://instagram.com', { signal, timeoutMs: 30000 })
//     await waitForSelector(win, 'input[name="username"]', { signal, timeoutMs: 10000 })
//     ...
//   } finally {
//     await safeClose(win)
//   }
//
// Tests: tests/bulk-action-browser-helpers.smoketest.js con fakes de
// Electron (BrowserWindow + webContents stubs). Validation real end-to-end
// requiere smoke manual con OZ corriendo — documentado en ADR 0030.
//
// Doc: docs/modules/bulk-action-browser-helpers.md

'use strict'

const DEFAULT_NAV_TIMEOUT_MS = 30_000
const DEFAULT_SELECTOR_POLL_MS = 200
const DEFAULT_SELECTOR_TIMEOUT_MS = 10_000

/**
 * Spawn a hidden BrowserWindow bound to the given identity's session
 * (partition). The window is configured with sandbox + contextIsolation +
 * the identity's per-session settings (proxy, fingerprint, UA — all wired
 * upstream by IdentityManager). Caller MUST safeClose() when done.
 *
 * @param {object} opts
 * @param {object} opts.identityManager - browser.identityManager
 * @param {string} opts.identityId
 * @param {boolean} [opts.show=false] - true para ventana visible (debugging)
 * @param {object} [opts.electron] - inyectable para tests (default: require('electron'))
 * @param {object} [opts.signal] - AbortSignal (rechaza si ya está abortado)
 * @returns {object} BrowserWindow (real o fake según Electron injection)
 */
async function spawnIdentityWindow(opts = {}) {
  const {
    identityManager,
    identityId,
    show = false,
    signal,
    electron = _requireElectron(),
  } = opts
  if (!identityManager) throw new Error('spawnIdentityWindow: identityManager required')
  if (!identityId) throw new Error('spawnIdentityWindow: identityId required')
  if (signal && signal.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
  const ident = identityManager.get(identityId)
  if (!ident) throw new Error(`identity not found: ${identityId}`)
  // Trigger session creation so any per-identity hooks (proxy, FP, UA)
  // are wired before we open the window.
  identityManager.getSession(identityId)
  const partition = ident.isDefault ? undefined : `persist:identity-${identityId}`
  const win = new electron.BrowserWindow({
    show,
    width: 1280,
    height: 800,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  return win
}

/**
 * Close a BrowserWindow without throwing. Idempotent — calling on a
 * destroyed window is a no-op.
 */
async function safeClose(win) {
  if (!win) return
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return
    if (typeof win.destroy === 'function') win.destroy()
    else if (typeof win.close === 'function') win.close()
  } catch (_err) {
    // noop — best effort.
  }
}

/**
 * Navigate a window to URL and wait for did-finish-load (or fail).
 *
 * @param {object} win - BrowserWindow
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {object} [opts.signal] - AbortSignal
 * @returns {Promise<{url, title}>}
 */
function navigate(win, url, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_NAV_TIMEOUT_MS
  const { signal } = opts
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(_abortError())
    const wc = win.webContents
    let settled = false
    const cleanup = () => {
      try {
        wc.removeListener('did-finish-load', onLoad)
        wc.removeListener('did-fail-load', onFail)
      } catch (_e) {
        // noop
      }
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const onLoad = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ url: _safeCall(wc, 'getURL'), title: _safeCall(wc, 'getTitle') })
    }
    const onFail = (_evt, errorCode, errorDesc, validatedURL, isMainFrame) => {
      // Only treat main-frame failures as navigation failures. Subresource
      // (frames, scripts, images) failures are noise we ignore.
      if (isMainFrame === false) return
      if (settled) return
      settled = true
      cleanup()
      const err = new Error(
        `navigate failed: ${errorDesc} (code ${errorCode}) at ${validatedURL || url}`,
      )
      err.code = errorCode
      reject(err)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(_abortError())
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`navigate timeout after ${timeoutMs}ms: ${url}`))
    }, timeoutMs)
    wc.on('did-finish-load', onLoad)
    wc.on('did-fail-load', onFail)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      win.loadURL(url)
    } catch (err) {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
  })
}

/**
 * Poll DOM for `selector` to appear (existence, not visibility).
 *
 * @param {object} win
 * @param {string} selector - CSS selector
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @param {number} [opts.pollMs=200]
 * @param {object} [opts.signal]
 */
async function waitForSelector(win, selector, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_SELECTOR_TIMEOUT_MS
  const pollMs = opts.pollMs != null ? opts.pollMs : DEFAULT_SELECTOR_POLL_MS
  const { signal } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw _abortError()
    const found = await executeJS(
      win,
      `(()=>!!document.querySelector(${JSON.stringify(selector)}))()`,
    )
    if (found) return true
    await _sleep(pollMs, signal)
  }
  throw new Error(`waitForSelector timeout after ${timeoutMs}ms: ${selector}`)
}

/**
 * Click an element matching `selector`. Throws if not found.
 * Note: synthetic click via JS, not a real OS-level click — sufficient
 * for most cases, won't trip every anti-bot detector. Future work can
 * add real mouse-coordinate clicks if needed.
 */
async function click(win, selector, opts = {}) {
  const { signal } = opts
  if (signal && signal.aborted) throw _abortError()
  const script = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { ok: false, reason: 'not-found' }
      el.click()
      return { ok: true }
    })()
  `
  const result = await executeJS(win, script)
  if (!result || !result.ok) {
    throw new Error(
      `click failed: ${(result && result.reason) || 'unknown'} (${selector})`,
    )
  }
  return result
}

/**
 * Type `text` into an input/textarea matching `selector`. Triggers
 * input/change events so React/Vue-bound forms see the value.
 */
async function type(win, selector, text, opts = {}) {
  const { signal } = opts
  if (signal && signal.aborted) throw _abortError()
  const script = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { ok: false, reason: 'not-found' }
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ) || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )
      if (nativeInputValueSetter && nativeInputValueSetter.set) {
        nativeInputValueSetter.set.call(el, ${JSON.stringify(text)})
      } else {
        el.value = ${JSON.stringify(text)}
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    })()
  `
  const result = await executeJS(win, script)
  if (!result || !result.ok) {
    throw new Error(
      `type failed: ${(result && result.reason) || 'unknown'} (${selector})`,
    )
  }
  return result
}

/**
 * Execute arbitrary JS in the page. Wraps webContents.executeJavaScript.
 */
async function executeJS(win, script) {
  if (!win || !win.webContents) {
    throw new Error('executeJS: window or webContents missing')
  }
  return win.webContents.executeJavaScript(script, /* userGesture */ true)
}

/**
 * Capture a screenshot of the page. Returns a base64 PNG string.
 * If `filePath` is provided, also writes to disk.
 */
async function screenshot(win, opts = {}) {
  if (!win || !win.webContents) {
    throw new Error('screenshot: window or webContents missing')
  }
  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  const base64 = png.toString('base64')
  if (opts.filePath) {
    const fs = require('fs')
    fs.writeFileSync(opts.filePath, png)
  }
  return base64
}

// ---------- internals --------------------------------------------------------

function _abortError() {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function _safeCall(obj, method) {
  try {
    return obj[method]()
  } catch (_e) {
    return null
  }
}

function _sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true },
      )
    }
  })
}

function _requireElectron() {
  return require('electron')
}

module.exports = {
  spawnIdentityWindow,
  safeClose,
  navigate,
  waitForSelector,
  click,
  type,
  executeJS,
  screenshot,
  // Exposed for tests.
  _internals: { _requireElectron },
}
