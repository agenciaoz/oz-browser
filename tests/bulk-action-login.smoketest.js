// OZ Browser — Bulk auto-login helper smoke test (v2 sub-bloque 4).
//
// Fakes Electron BrowserWindow + accountsAPI. Stateful responder pattern
// that simulates the IG login DOM evolving across navigation + form fill
// + submit + (optional) 2FA + verify.
//
// Validation real con IG sigue siendo smoke manual de Jose: selectores IG
// rotan frecuente — el test garantiza la lógica del helper (form-fill
// sequence, 2FA branch, vault-locked path, no-credentials path,
// verify-fail path) pero NO garantiza que los selectores actuales
// matcheen el DOM real de IG hoy.

'use strict'

const { EventEmitter } = require('events')

const { attemptLogin } = require('../browser/bulk-action-login')

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

// ---------- fake Electron ---------------------------------------------------

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this._url = 'about:blank'
    this.executeJavaScriptCalls = []
    this._responder = null
  }
  getURL() {
    return this._url
  }
  setResponder(fn) {
    this._responder = fn
  }
  executeJavaScript(script) {
    this.executeJavaScriptCalls.push(script)
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
    // Simulate the page-loaded event a tick later.
    setImmediate(() => {
      this.webContents.emit('did-finish-load')
    })
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

// ---------- fake accountsAPI ------------------------------------------------

function makeAccountsAPI({ accounts, totpCode, vaultLocked = false } = {}) {
  return {
    list(filter) {
      if (vaultLocked) return { __error: { code: 'LOCKED', message: 'locked' } }
      let result = (accounts || []).slice()
      if (filter && filter.identityId) {
        result = result.filter((a) => a.identityId === filter.identityId)
      }
      if (filter && filter.site) {
        result = result.filter((a) => a.site === filter.site)
      }
      return result
    },
    getTotpForSite(_site, _id) {
      if (vaultLocked) return { __error: { code: 'LOCKED', message: 'locked' } }
      if (!totpCode) return null
      return { code: totpCode, accountId: 'acc-1' }
    },
  }
}

// ---------- IG DOM state simulator ------------------------------------------
//
// Phases:
//   'login' - login form visible
//   '2fa'   - 2FA code form visible
//   'home'  - successfully logged in
//   'fail'  - submit landed back on login form (wrong creds or rate limit)

// Extract the first JSON-encoded string literal that appears immediately
// after a given anchor substring. Returns the parsed string or null.
function _extractStringAfter(script, anchor) {
  const idx = script.indexOf(anchor)
  if (idx < 0) return null
  let i = idx + anchor.length
  // Skip whitespace.
  while (i < script.length && /\s/.test(script[i])) i++
  const quote = script[i]
  if (quote !== '"' && quote !== "'") return null
  let end = i + 1
  while (end < script.length) {
    if (script[end] === '\\') {
      end += 2
      continue
    }
    if (script[end] === quote) break
    end++
  }
  if (end >= script.length) return null
  const lit = script.slice(i, end + 1)
  try {
    // Convert single-quote JSON to double-quoted for parser tolerance.
    if (quote === "'") {
      return JSON.parse('"' + lit.slice(1, -1).replace(/"/g, '\\"') + '"')
    }
    return JSON.parse(lit)
  } catch (_e) {
    return null
  }
}

function buildIgResponder(initialPhase = 'login') {
  const state = {
    phase: initialPhase,
    usernameTyped: '',
    passwordTyped: '',
    totpTyped: '',
    needs2fa: false,
  }

  return {
    state,
    respond(script) {
      // 1. Simple selector existence query: `!!document.querySelector("…")`.
      if (script.trim().startsWith('!!document.querySelector(')) {
        const sel = _extractStringAfter(script, 'document.querySelector(')
        if (sel != null) return _selectorExists(sel, state)
      }
      // 2. type() IIFE — find selector + value + return shape.
      if (
        script.includes('nativeInputValueSetter') &&
        script.includes('document.querySelector(')
      ) {
        const sel = _extractStringAfter(script, 'document.querySelector(')
        if (sel == null) return { ok: false, reason: 'parse' }
        if (!_selectorExists(sel, state)) return { ok: false, reason: 'not-found' }
        const val = _extractStringAfter(script, '.set.call(el, ')
        if (/username/.test(sel)) state.usernameTyped = val || ''
        else if (/password/.test(sel)) state.passwordTyped = val || ''
        else if (/verificationCode|one-time-code|security code|código/.test(sel)) {
          state.totpTyped = val || ''
        }
        return { ok: true }
      }
      // 3. click() IIFE — querySelector + .click().
      if (script.includes('.click()') && script.includes('document.querySelector(')) {
        const sel = _extractStringAfter(script, 'document.querySelector(')
        if (sel == null) return { ok: false, reason: 'parse' }
        if (!_selectorExists(sel, state)) return { ok: false, reason: 'not-found' }
        _advancePhaseOnClick(state, sel)
        return { ok: true }
      }
      // 4. _verifyLoggedIn aggregator queries with inlined selector arrays.
      if (script.includes('function()') && script.includes('document.querySelector(s)')) {
        // Pull out the `sels = [...]` array. Walk char by char to honor
        // brackets inside JSON-escaped selector strings like
        // "svg[aria-label=\"Home\" i]".
        const sels = _extractInlinedSelectorArray(script)
        if (sels) {
          for (const sel of sels) {
            if (_selectorExists(sel, state)) return true
          }
          return false
        }
      }
      return undefined
    },
  }
}

function _extractInlinedSelectorArray(script) {
  const tag = 'sels = ['
  const start = script.indexOf(tag)
  if (start < 0) return null
  const open = start + tag.length - 1 // position of `[`
  let i = open + 1
  let depth = 1
  while (i < script.length && depth > 0) {
    const ch = script[i]
    if (ch === '"') {
      // skip string respecting escapes
      i++
      while (i < script.length) {
        if (script[i] === '\\') {
          i += 2
          continue
        }
        if (script[i] === '"') break
        i++
      }
    } else if (ch === '[') depth++
    else if (ch === ']') depth--
    if (depth === 0) break
    i++
  }
  const slice = script.slice(open, i + 1)
  try {
    return JSON.parse(slice)
  } catch (_e) {
    return null
  }
}

function _selectorExists(sel, state) {
  if (state.phase === 'login') {
    if (sel === 'input[name="username"]') return true
    if (sel === 'input[name="password"]') return true
    if (sel === 'button[type="submit"]') return true
    if (sel === 'a[href="/accounts/login/"]') return true
    return false
  }
  if (state.phase === '2fa') {
    if (sel === 'input[name="verificationCode"]') return true
    if (sel === 'button[type="submit"]') return true
    if (sel === 'button[type="button"]') return true
    return false
  }
  if (state.phase === 'home') {
    if (sel === 'svg[aria-label="Home" i]') return true
    if (sel === 'a[href="/"]') return true
    return false
  }
  if (state.phase === 'fail') {
    if (sel === 'input[name="username"]') return true
    if (sel === 'a[href="/accounts/login/"]') return true
    return false
  }
  return false
}

function _advancePhaseOnClick(state, _script) {
  if (state.phase === 'login') {
    // Decide based on what got typed
    if (state.passwordTyped === 'wrongpass') {
      state.phase = 'fail'
    } else if (state.needs2fa) {
      state.phase = '2fa'
    } else {
      state.phase = 'home'
    }
    return true
  }
  if (state.phase === '2fa') {
    if (state.totpTyped && state.totpTyped.length >= 6) {
      state.phase = 'home'
    } else {
      state.phase = 'fail'
    }
    return true
  }
  return true
}

// ---------- test cases ------------------------------------------------------

async function main() {
  // Happy path — no 2FA.
  section('happy path without 2FA')
  {
    const win = new FakeBrowserWindow()
    const responder = buildIgResponder('login')
    win.webContents.setResponder((script) => responder.respond(script))
    const accountsAPI = makeAccountsAPI({
      accounts: [
        {
          id: 'acc-1',
          identityId: 'id-1',
          site: 'instagram.com',
          username: 'jose',
          password: 'goodpass',
          status: 'active',
          lastLoginAt: Date.now(),
        },
      ],
    })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 8000,
    })
    ok('result.ok = true', result.ok === true, JSON.stringify(result))
    ok('accountId returned', result.accountId === 'acc-1')
    ok('typed username', responder.state.usernameTyped === 'jose')
    ok('typed password', responder.state.passwordTyped === 'goodpass')
    ok('final phase = home', responder.state.phase === 'home')
    ok(
      'navigated to login url',
      win.loadUrlCalls.some((u) => u.includes('/accounts/login/')),
    )
  }

  // 2FA happy path.
  section('happy path WITH 2FA')
  {
    const win = new FakeBrowserWindow()
    const responder = buildIgResponder('login')
    responder.state.needs2fa = true
    win.webContents.setResponder((script) => responder.respond(script))
    const accountsAPI = makeAccountsAPI({
      accounts: [
        {
          id: 'acc-1',
          identityId: 'id-1',
          site: 'instagram.com',
          username: 'jose',
          password: 'goodpass',
          totpSecret: 'JBSWY3DPEHPK3PXP',
          status: 'active',
          lastLoginAt: Date.now(),
        },
      ],
      totpCode: '123456',
    })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 8000,
    })
    ok('2fa: result.ok = true', result.ok === true, JSON.stringify(result))
    ok('2fa: totp typed', responder.state.totpTyped === '123456')
    ok('2fa: final phase = home', responder.state.phase === 'home')
  }

  // Vault locked.
  section('vault locked')
  {
    const win = new FakeBrowserWindow()
    win.webContents.setResponder(() => false)
    const accountsAPI = makeAccountsAPI({ vaultLocked: true })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 2000,
    })
    ok('locked: result.ok = false', result.ok === false)
    ok('locked: code = vault-locked', result.code === 'vault-locked')
    ok('locked: did not navigate', win.loadUrlCalls.length === 0)
  }

  // No credentials.
  section('no credentials for identity')
  {
    const win = new FakeBrowserWindow()
    win.webContents.setResponder(() => false)
    const accountsAPI = makeAccountsAPI({ accounts: [] })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 2000,
    })
    ok('no-creds: result.ok = false', result.ok === false)
    ok('no-creds: code = no-credentials', result.code === 'no-credentials')
    ok('no-creds: did not navigate', win.loadUrlCalls.length === 0)
  }

  // Unsupported platform.
  section('unsupported platform')
  {
    const win = new FakeBrowserWindow()
    const accountsAPI = makeAccountsAPI({ accounts: [] })
    const result = await attemptLogin(win, {
      platform: 'unknown.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 2000,
    })
    ok('unsupported: result.ok = false', result.ok === false)
    ok('unsupported: code = unsupported-platform', result.code === 'unsupported-platform')
  }

  // 2FA required but no totpSecret.
  section('2FA required but no totpSecret')
  {
    const win = new FakeBrowserWindow()
    const responder = buildIgResponder('login')
    responder.state.needs2fa = true
    win.webContents.setResponder((script) => responder.respond(script))
    const accountsAPI = makeAccountsAPI({
      accounts: [
        {
          id: 'acc-1',
          identityId: 'id-1',
          site: 'instagram.com',
          username: 'jose',
          password: 'goodpass',
          status: 'active',
          lastLoginAt: Date.now(),
          // no totpSecret
        },
      ],
      totpCode: null,
    })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 8000,
    })
    ok('totp-needed: result.ok = false', result.ok === false)
    ok(
      'totp-needed: code = totp-needed-no-secret',
      result.code === 'totp-needed-no-secret',
    )
  }

  // Login failure (wrong password).
  section('login failure (wrong password lands back on login form)')
  {
    const win = new FakeBrowserWindow()
    const responder = buildIgResponder('login')
    win.webContents.setResponder((script) => responder.respond(script))
    const accountsAPI = makeAccountsAPI({
      accounts: [
        {
          id: 'acc-1',
          identityId: 'id-1',
          site: 'instagram.com',
          username: 'jose',
          password: 'wrongpass',
          status: 'active',
          lastLoginAt: Date.now(),
        },
      ],
    })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 6000,
    })
    ok('wrongpass: result.ok = false', result.ok === false, JSON.stringify(result))
    ok('wrongpass: code = login-failed', result.code === 'login-failed')
  }

  // Aborted before completion.
  section('abort signal triggers early')
  {
    const ctrl = new AbortController()
    ctrl.abort()
    const win = new FakeBrowserWindow()
    win.webContents.setResponder(() => false)
    const accountsAPI = makeAccountsAPI({
      accounts: [
        {
          id: 'acc-1',
          identityId: 'id-1',
          site: 'instagram.com',
          username: 'jose',
          password: 'p',
          status: 'active',
          lastLoginAt: Date.now(),
        },
      ],
    })
    const result = await attemptLogin(win, {
      platform: 'instagram.com',
      identityId: 'id-1',
      accountsAPI,
      timeoutMs: 4000,
      signal: ctrl.signal,
    })
    ok('aborted: result.ok = false', result.ok === false, JSON.stringify(result))
    ok(
      'aborted: code is aborted OR login-failed (navigate threw)',
      result.code === 'aborted' || result.code === 'login-failed',
    )
  }

  console.log('')
  console.log(`Passed: ${passed} · Failed: ${failed}`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Test crashed:', err)
  process.exit(1)
})
