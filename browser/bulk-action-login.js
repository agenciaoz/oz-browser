// OZ Browser — Bulk auto-login helper (v2 sub-bloque 4).
//
// Cuando una bulk action falla con `error.code === 'needs_login'` el
// runner usa este helper para intentar loguear la identity en la
// plataforma correspondiente con las credenciales del vault. Si el
// login sale ok, la action se retry-ea UNA vez.
//
// Doc: docs/modules/bulk-runner.md (sección "Auto-login retry")
// ADR: docs/architecture/0030-bulk-runner.md (sección "Auto-login retry")
//
// Pattern de uso (desde bulk-runner.js):
//   const { attemptLogin } = require('./bulk-action-login')
//   const result = await attemptLogin(win, {
//     platform: 'instagram.com',
//     identityId,
//     accountsAPI,       // browser.accountHandlersAPI from account-handlers.js
//     timeoutMs: 60_000,
//     signal,            // AbortSignal from runner
//   })
//   if (result.ok) { /* retry the original action */ }
//
// Return shape:
//   { ok: true, accountId, durationMs }
//   { ok: false, code: 'vault-locked' | 'no-credentials' | 'login-failed'
//                    | 'totp-needed-no-secret' | 'aborted' | 'unsupported-platform',
//     message }
//
// Error codes:
//   - 'vault-locked':           the vault is locked (accountsAPI.list returns LOCKED)
//   - 'no-credentials':         no account stored for (site, identityId)
//   - 'totp-needed-no-secret':  IG asked for 2FA code, vault entry has no totpSecret
//   - 'login-failed':           form filled + submitted but page still shows login
//                               (wrong password OR captcha OR rate limit)
//   - 'unsupported-platform':   no LOGIN_FLOWS entry for that site
//   - 'aborted':                signal.aborted during execution
//
// Login flow per platform lives in LOGIN_FLOWS map at the top. Each
// entry is a small object:
//   {
//     url: string,                       // login page URL
//     usernameSelectors: string[],       // input for username/email
//     passwordSelectors: string[],       // input for password
//     submitSelectors: string[],         // submit button
//     totpInputSelectors: string[],      // 2FA code input (optional)
//     totpSubmitSelectors: string[],     // confirm 2FA button (optional)
//     loggedInIndicators: string[],      // selectors present only when logged in
//     stillLoggedOutIndicators: string[],// selectors still present after fail
//     site: string,                      // canonical site id used in vault.account.site
//   }
//
// IG is implemented; X / FB / TikTok son sub-bloques siguientes con
// patrón idéntico (cambiar selectores + URL).

'use strict'

const {
  navigate,
  type: typeText,
  click,
  executeJS,
} = require('./bulk-action-browser-helpers')

// ---------- Login flow registry --------------------------------------------

const LOGIN_FLOWS = {
  'facebook.com': {
    site: 'facebook.com',
    url: 'https://www.facebook.com/login',
    usernameSelectors: [
      'input[name="email"]',
      'input[type="email"]',
      'input[id="email"]',
    ],
    passwordSelectors: [
      'input[name="pass"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ],
    submitSelectors: [
      'button[name="login"]',
      'button[type="submit"]',
      '[data-testid="royal_login_button"]',
    ],
    // FB 2FA via auth app or SMS code.
    totpInputSelectors: [
      'input[name="approvals_code"]',
      'input[autocomplete="one-time-code"]',
    ],
    totpSubmitSelectors: ['button[id="checkpointSubmitButton"]', 'button[type="submit"]'],
    loggedInIndicators: [
      'div[aria-label="Account"]',
      'a[aria-label="Home" i]',
      'a[aria-label="Inicio" i]',
      'div[role="banner"][data-pagelet="Stories"]',
      'a[href="/marketplace/"]',
    ],
    stillLoggedOutIndicators: ['input[name="email"]', 'a[href*="/login"]'],
  },
  'tiktok.com': {
    site: 'tiktok.com',
    url: 'https://www.tiktok.com/login/phone-or-email/email',
    // TikTok login: phone/email + password on same screen.
    usernameSelectors: [
      'input[name="username"]',
      'input[type="text"][placeholder*="mail" i]',
      'input[type="text"][placeholder*="orreo" i]',
    ],
    passwordSelectors: [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ],
    submitSelectors: [
      'button[type="submit"]',
      'button[data-e2e="login-button"]',
      '[data-e2e="login-button"]',
    ],
    // TikTok 2FA via SMS/email code OR authenticator code.
    totpInputSelectors: [
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="código" i]',
    ],
    totpSubmitSelectors: ['button[type="submit"]', '[data-e2e="verify-button"]'],
    loggedInIndicators: [
      'a[data-e2e="nav-foryou"]',
      'a[href="/"]',
      '[data-e2e="profile-icon"]',
      '[data-e2e="recommend-list-item-container"]',
    ],
    stillLoggedOutIndicators: ['input[type="password"]', 'a[href*="/login"]'],
  },
  'x.com': {
    site: 'x.com',
    url: 'https://x.com/i/flow/login',
    // X (formerly Twitter) login: username on screen 1, password on screen 2.
    // The submit button between screens has the same selector pattern, so we
    // just bash all submitSelectors at every step.
    usernameSelectors: [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"][autocapitalize="sentences"]',
    ],
    passwordSelectors: [
      'input[autocomplete="current-password"]',
      'input[name="password"]',
      'input[type="password"]',
    ],
    submitSelectors: [
      '[data-testid="LoginForm_Login_Button"]',
      'button[type="submit"]',
      '[role="button"][data-testid*="ogin"]',
    ],
    totpInputSelectors: [
      'input[data-testid="ocfEnterTextTextInput"]',
      'input[name="text"]',
      'input[autocomplete="one-time-code"]',
    ],
    totpSubmitSelectors: [
      '[data-testid="ocfEnterTextNextButton"]',
      'button[type="submit"]',
    ],
    loggedInIndicators: [
      'a[data-testid="AppTabBar_Home_Link"]',
      'a[href="/home"]',
      '[data-testid="primaryColumn"]',
      'a[aria-label="Home" i]',
      'a[aria-label="Inicio" i]',
    ],
    stillLoggedOutIndicators: [
      'input[autocomplete="username"]',
      'a[href="/i/flow/login"]',
    ],
  },
  'instagram.com': {
    site: 'instagram.com',
    url: 'https://www.instagram.com/accounts/login/',
    usernameSelectors: ['input[name="username"]', 'input[aria-label*="phone" i]'],
    passwordSelectors: ['input[name="password"]', 'input[type="password"]'],
    submitSelectors: ['button[type="submit"]'],
    // IG 2FA: code input + confirm button.
    totpInputSelectors: [
      'input[name="verificationCode"]',
      'input[aria-label*="security code" i]',
      'input[aria-label*="código" i]',
      'input[autocomplete="one-time-code"]',
    ],
    totpSubmitSelectors: ['button[type="button"]', 'button[type="submit"]'],
    // After login IG often shows "Save Your Login Info?" or "Turn on Notifications".
    // We don't dismiss those — we only check if there's still a login form (failure)
    // or if we're past it (success). The original action navigates to its target URL
    // afterwards, which clears any modal.
    loggedInIndicators: [
      'svg[aria-label="Home" i]',
      'svg[aria-label="Inicio" i]',
      'a[href="/"]',
      'nav a[href*="/direct/inbox/"]',
    ],
    stillLoggedOutIndicators: ['input[name="username"]', 'a[href="/accounts/login/"]'],
  },
}

// ---------- Public API ------------------------------------------------------

/**
 * Attempt to log an identity in to a platform using vault credentials.
 *
 * The caller owns the BrowserWindow lifecycle — this function navigates the
 * window to the platform's login page, fills the form, handles 2FA if
 * required, and verifies the result. It does NOT close the window.
 *
 * @param {BrowserWindow} win  - electron BrowserWindow tied to the identity.
 * @param {object} opts
 * @param {string} opts.platform        - canonical platform key (e.g. 'instagram.com').
 * @param {string} opts.identityId      - OZ identity id.
 * @param {object} opts.accountsAPI     - account-handlers API (must expose .list, .getTotpForSite).
 * @param {function} [opts.totpFn]      - optional override for TOTP generation (tests).
 * @param {number} [opts.timeoutMs=60_000]
 * @param {AbortSignal} [opts.signal]
 */
async function attemptLogin(win, opts) {
  const { platform, identityId, accountsAPI } = opts || {}
  const timeoutMs = (opts && opts.timeoutMs) || 60_000
  const signal = opts && opts.signal
  const t0 = Date.now()

  if (!win) throw new Error('attemptLogin: win required')
  if (!platform) throw new Error('attemptLogin: platform required')
  if (!identityId) throw new Error('attemptLogin: identityId required')
  if (!accountsAPI) throw new Error('attemptLogin: accountsAPI required')

  const flow = LOGIN_FLOWS[platform]
  if (!flow) {
    return _fail('unsupported-platform', `no login flow for ${platform}`)
  }

  const accounts = accountsAPI.list({ identityId, site: flow.site })
  if (accounts && accounts.__error) {
    if (accounts.__error.code === 'LOCKED') {
      return _fail('vault-locked', 'vault is locked')
    }
    return _fail('login-failed', `accountsAPI error: ${accounts.__error.message}`)
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return _fail('no-credentials', `no account for (${flow.site}, ${identityId})`)
  }
  // Pick the most recent active one (matches getCredentialsForSite policy).
  const active = accounts
    .filter((a) => a.status !== 'inactive')
    .sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0))
  if (active.length === 0) {
    return _fail('no-credentials', 'all accounts marked inactive')
  }
  const acct = active[0]
  if (!acct.username || !acct.password) {
    return _fail('no-credentials', 'account is missing username or password')
  }

  // Navigate to login page.
  try {
    await navigate(win, flow.url, { timeoutMs: Math.min(30_000, timeoutMs), signal })
  } catch (err) {
    return _fail('login-failed', `navigate to login page failed: ${err.message}`)
  }
  if (signal && signal.aborted) return _fail('aborted', 'aborted before fill')

  // Fill username.
  const userSel = await _waitForAnyAvailable(win, flow.usernameSelectors, {
    timeoutMs: 15_000,
    signal,
  })
  if (!userSel) return _fail('login-failed', 'username input not found')
  await typeText(win, userSel, acct.username)
  if (signal && signal.aborted) return _fail('aborted', 'aborted mid-fill')

  // Fill password.
  const passSel = await _waitForAnyAvailable(win, flow.passwordSelectors, {
    timeoutMs: 5_000,
    signal,
  })
  if (!passSel) return _fail('login-failed', 'password input not found')
  await typeText(win, passSel, acct.password)
  if (signal && signal.aborted) return _fail('aborted', 'aborted mid-fill')

  // Submit.
  const submitSel = await _waitForAnyAvailable(win, flow.submitSelectors, {
    timeoutMs: 5_000,
    signal,
  })
  if (!submitSel) return _fail('login-failed', 'submit button not found')
  await click(win, submitSel)

  // Wait a beat for the page to react.
  await _sleep(2500, signal)
  if (signal && signal.aborted) return _fail('aborted', 'aborted after submit')

  // Check for 2FA prompt.
  const totpSel = await _waitForAnyAvailable(win, flow.totpInputSelectors, {
    timeoutMs: 4_000,
    signal,
  })
  if (totpSel) {
    // 2FA required — pull TOTP code from vault.
    let codeResult
    if (opts.totpFn) {
      codeResult = await opts.totpFn(flow.site, identityId)
    } else {
      codeResult = accountsAPI.getTotpForSite(flow.site, identityId)
    }
    if (!codeResult || codeResult.__error) {
      const msg =
        codeResult && codeResult.__error ? codeResult.__error.message : 'no TOTP'
      return _fail('totp-needed-no-secret', `2FA required but ${msg}`)
    }
    if (!codeResult.code) {
      return _fail('totp-needed-no-secret', '2FA required but account has no totpSecret')
    }
    await typeText(win, totpSel, codeResult.code)
    if (signal && signal.aborted) return _fail('aborted', 'aborted mid-2fa')
    // Click any confirm button visible after typing the code. IG renders
    // the Confirm button enabled only after the code is filled in.
    const totpSubmitSel = await _waitForAnyAvailable(win, flow.totpSubmitSelectors, {
      timeoutMs: 4_000,
      signal,
    })
    if (totpSubmitSel) {
      await click(win, totpSubmitSel)
    }
    await _sleep(2500, signal)
    if (signal && signal.aborted) return _fail('aborted', 'aborted post-2fa')
  }

  // Verify login succeeded.
  const verdict = await _verifyLoggedIn(win, flow, { timeoutMs: 10_000, signal })
  if (!verdict.ok) {
    return _fail(verdict.code, verdict.message)
  }

  return {
    ok: true,
    accountId: acct.id,
    durationMs: Date.now() - t0,
  }

  function _fail(code, message) {
    return { ok: false, code, message, durationMs: Date.now() - t0 }
  }
}

// ---------- Internal helpers -----------------------------------------------

/**
 * Poll the page for any of the candidate selectors. Returns the first match
 * or null after timeoutMs. Honors abort signal.
 */
async function _waitForAnyAvailable(win, selectors, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 250
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return null
    for (const sel of selectors) {
      try {
        const exists = await executeJS(
          win,
          `!!document.querySelector(${JSON.stringify(sel)})`,
        )
        if (exists) return sel
      } catch (_e) {
        // ignore per-selector script failures
      }
    }
    await _sleep(pollMs, signal)
  }
  return null
}

/**
 * After submit, check whether we landed on a logged-in page or are still on
 * a login form. Use the loggedInIndicators + stillLoggedOutIndicators arrays.
 */
async function _verifyLoggedIn(win, flow, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 500
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted)
      return { ok: false, code: 'aborted', message: 'aborted' }
    // Positive signal trumps negative (some IG modals leave login form in
    // DOM but hidden — the home nav presence wins).
    const positive = await executeJS(
      win,
      `(function(){
        const sels = ${JSON.stringify(flow.loggedInIndicators)};
        for (const s of sels) { try { if (document.querySelector(s)) return true } catch(_){} }
        return false;
      })()`,
    )
    if (positive) return { ok: true }
    const negative = await executeJS(
      win,
      `(function(){
        const sels = ${JSON.stringify(flow.stillLoggedOutIndicators)};
        for (const s of sels) { try { if (document.querySelector(s)) return true } catch(_){} }
        return false;
      })()`,
    )
    if (!negative) {
      // No login form and no home nav — give the page another poll.
    }
    await _sleep(pollMs, signal)
  }
  // Timed out without positive proof of login.
  return {
    ok: false,
    code: 'login-failed',
    message: 'no logged-in indicator visible within timeout',
  }
}

function _sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(t)
        resolve()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

module.exports = {
  attemptLogin,
  LOGIN_FLOWS,
  // Internal — exposed for tests.
  _verifyLoggedIn,
  _waitForAnyAvailable,
}
