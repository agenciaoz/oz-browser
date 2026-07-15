// OZ Browser — Bulk Action: x_post (v2 sub-bloque 5c).
//
// Postea un tweet en X (Twitter) desde una identity. Reusa el pattern de
// ig_post: spawn + navigate + needs_login/captcha check + locate compose
// textarea + type + click submit + verify confirmation.
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate a https://x.com/compose/post (modal de compose directo)
//   3. Detectar needs_login / captcha early
//   4. Wait textarea: div[data-testid="tweetTextarea_0"][role="textbox"]
//   5. Type via native input setter
//   6. Click submit: button[data-testid="tweetButton"] o testid=tweetButtonInline
//   7. Wait confirmation: modal cerrado O nav volvió a /home O testid del
//      compose textarea desapareció
//   8. safeClose
//
// Params:
//   { text: string (required, 1-280 chars), timeoutMs?: number (default 60000) }
//
// Result: { text, identityId, identityName, durationMs }
// Errors: needs_login | captcha | not-found | submit-failed
//
// Rate limits X posts: 2400/día per account es el cap oficial. Soft-bans
// para spam patterns suelen pegar mucho antes (~50-100 tweets idénticos).
//
// Doc: docs/modules/bulk-actions-x-post.md (TBD)

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  type: typeText,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
  composeTextarea: [
    'div[data-testid="tweetTextarea_0"][role="textbox"]',
    'div[aria-label*="Post text" i][role="textbox"]',
    'div[aria-label*="Texto del Post" i][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  submitButton: [
    'button[data-testid="tweetButtonInline"]',
    'button[data-testid="tweetButton"]',
    'div[data-testid="tweetButtonInline"]',
    'div[data-testid="tweetButton"]',
  ],
  loginIndicator: [
    'a[href="/i/flow/login"]',
    'a[href*="/login"]',
    'input[autocomplete="username"]',
  ],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="arkose"]',
    'iframe[src*="funcaptcha"]',
    '[id*="captcha"]',
  ],
}

function buildXPostAction({ identityManager, electron }) {
  return {
    id: 'x_post',
    label: 'X (Twitter): Post a tweet',
    platform: 'x.com',
    description:
      'Post a tweet on X (Twitter) from each identity. Params: text (required, 1-280 chars), timeoutMs. Returns {text, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | submit-failed. Auto-login retry kicks in on needs_login if vault is wired.',
    paramsSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 280,
          description: 'Body of the tweet (max 280 chars).',
        },
        timeoutMs: {
          type: 'number',
          minimum: 5000,
          maximum: 180_000,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { text, timeoutMs = 60_000 } = params || {}
      if (!text) throw new Error('text required')
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        await navigate(win, 'https://x.com/compose/post', {
          timeoutMs: Math.min(20_000, timeoutMs),
          signal,
        })

        const early = await _checkEarlySignals(win)
        if (early === 'needs_login') {
          const err = new Error('identity not logged in to X')
          err.code = 'needs_login'
          throw err
        }
        if (early === 'captcha') {
          const err = new Error('X showed a captcha challenge')
          err.code = 'captcha'
          throw err
        }

        const textareaSel = await _waitForAnyAvailable(win, SELECTORS.composeTextarea, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!textareaSel) {
          const err = new Error(
            'compose textarea not found — selectors may be stale OR not logged in',
          )
          err.code = 'not-found'
          throw err
        }

        // X uses contenteditable, NOT a textarea. Native input setter
        // doesn't apply — we set textContent + dispatch input event.
        await _typeContentEditable(win, textareaSel, text)
        if (signal && signal.aborted) {
          const err = new Error('aborted')
          err.code = 'aborted'
          throw err
        }

        const submitSel = await _waitForAnyEnabled(win, SELECTORS.submitButton, {
          timeoutMs: 6000,
          signal,
        })
        if (!submitSel) {
          const err = new Error('submit button not found / never enabled')
          err.code = 'not-found'
          throw err
        }

        await _clickButton(win, submitSel)

        // Verify confirmation: compose textarea disappeared OR URL navigated.
        const ok = await _waitForConfirmation(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!ok) {
          const err = new Error(
            'clicked submit but post did not appear to publish (rate limited / blocked)',
          )
          err.code = 'submit-failed'
          throw err
        }

        const ev = await require('./bulk-action-evidence').captureEvidence(win, {
          identityId: identity.id,
          actionId: 'x_post',
          electron,
        })
        return {
          text,
          identityId: identity.id,
          identityName: identity.name || null,
          durationMs: Date.now() - t0,
          ...ev,
        }
      } finally {
        safeClose(win)
      }
    },
  }
}

async function _checkEarlySignals(win) {
  try {
    return await executeJS(
      win,
      `(function(){
        const loginSels = ${JSON.stringify(SELECTORS.loginIndicator)};
        for (const s of loginSels) {
          try { if (document.querySelector(s)) return 'needs_login' } catch(_e) {}
        }
        const capSels = ${JSON.stringify(SELECTORS.captchaIndicator)};
        for (const s of capSels) {
          try { if (document.querySelector(s)) return 'captcha' } catch(_e) {}
        }
        return null
      })()`,
    )
  } catch (_e) {
    return null
  }
}

async function _waitForAnyAvailable(win, selectors, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 300
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
        // ignore
      }
    }
    await _sleep(pollMs, signal)
  }
  return null
}

/**
 * Returns the selector of the first match that is also NOT disabled (X
 * disables the submit button while the textarea is empty).
 */
async function _waitForAnyEnabled(win, selectors, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 300
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return null
    for (const sel of selectors) {
      try {
        const enabled = await executeJS(
          win,
          `(function(){
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) return false;
            if (el.hasAttribute('disabled')) return false;
            if (el.getAttribute('aria-disabled') === 'true') return false;
            return true;
          })()`,
        )
        if (enabled) return sel
      } catch (_e) {
        // ignore
      }
    }
    await _sleep(pollMs, signal)
  }
  return null
}

/**
 * Type into a contenteditable element. Native input value setter doesn't
 * apply — we set textContent + dispatch 'input' so React picks it up.
 */
async function _typeContentEditable(win, selector, text) {
  const result = await executeJS(
    win,
    `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.focus();
      // Use document.execCommand for the most React-compatible insertion path.
      // Falls back to direct text content if execCommand is unsupported.
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
      } catch(_e) {}
      if (!ok) {
        el.textContent = ${JSON.stringify(text)};
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
      }
      return { ok: true };
    })()`,
  )
  if (!result || !result.ok) {
    // Fallback: native typeText helper which clicks input events.
    await typeText(win, selector, text)
  }
}

async function _clickButton(win, selector) {
  await executeJS(
    win,
    `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.click();
      return { ok: true };
    })()`,
  )
}

async function _waitForConfirmation(win, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 400
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return false
    try {
      const verdict = await executeJS(
        win,
        `(function(){
          // Compose textarea gone or url navigated away?
          const textareaSels = ${JSON.stringify(SELECTORS.composeTextarea)};
          let textareaStillThere = false;
          for (const s of textareaSels) {
            try { if (document.querySelector(s)) { textareaStillThere = true; break } } catch(_e) {}
          }
          if (!textareaStillThere) return true;
          // Toast/snackbar confirmation? X sometimes shows "Your post was sent".
          const toast = document.querySelector('[data-testid*="toast" i]');
          if (toast && /sent|published|publicad|envia/i.test(toast.textContent || '')) {
            return true;
          }
          return false;
        })()`,
      )
      if (verdict) return true
    } catch (_e) {
      // ignore — keep polling
    }
    await _sleep(pollMs, signal)
  }
  return false
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
  buildXPostAction,
  SELECTORS,
}
