// OZ Browser — Bulk Action: fb_post (v2 Publishing Etapa 6).
//
// Postea un estado de texto en Facebook desde una identity. Reusa el pattern
// de x_post (contenteditable + dispatch input + click submit + verify) pero
// con el flujo del composer de FB (abrir el cuadro "¿Qué estás pensando?",
// escribir en el dialog, click "Publicar").
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate a https://www.facebook.com/
//   3. needs_login / captcha / checkpoint check (early)
//   4. Click composer opener ("What's on your mind" / "Qué estás pensando")
//   5. Wait dialog textbox: div[role="dialog"] [role="textbox"][contenteditable]
//   6. Type via execCommand insertText (React-friendly)
//   7. Click submit: div[aria-label="Post"|"Publicar"][role="button"]
//   8. Verify: dialog cerrado
//   9. safeClose
//
// Params:
//   { text: string (required, 1-5000 chars), timeoutMs?: number (default 60000) }
//
// Result: { text, identityId, identityName, durationMs }
// Errors: needs_login | captcha | not-found | submit-failed
//
// FB es MUY agresivo con anti-bot: el bulk runner mitiga con FP/proxy por
// identity + delays altos. Media (foto/video) se agrega después (Etapa 6).
//
// Doc: docs/modules/bulk-actions-fb-post.md (TBD) · ADR 0038.

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  type: typeText,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
  // Opener: the "What's on your mind" box on the home feed.
  composerOpener: [
    'div[role="button"][aria-label*="mind" i]',
    'div[role="button"][aria-label*="piensas" i]',
    'div[role="button"][aria-label*="pensando" i]',
    'div[role="button"]:has(span)',
  ],
  // The actual editor inside the create-post dialog.
  composeTextarea: [
    'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="mind" i][role="textbox"][contenteditable="true"]',
    'div[aria-label*="pensando" i][role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
  submitButton: [
    'div[role="dialog"] div[aria-label="Post"][role="button"]',
    'div[role="dialog"] div[aria-label="Publicar"][role="button"]',
    'div[aria-label="Post"][role="button"]',
    'div[aria-label="Publicar"][role="button"]',
  ],
  loginIndicator: ['a[href*="/login"]', 'input[name="email"]', 'div[id="loginbutton"]'],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
  ],
  // FB checkpoint (security challenge) — surface as captcha.
  checkpointIndicator: ['form[action*="checkpoint"]'],
}

function buildFbPostAction({ identityManager, electron }) {
  return {
    id: 'fb_post',
    label: 'Facebook: Post a status',
    platform: 'facebook.com',
    description:
      'Post a text status on Facebook from each identity. Params: text (required, 1-5000 chars), timeoutMs. Returns {text, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | submit-failed. Auto-login retry kicks in on needs_login if vault is wired. NOTE: FB is aggressive about anti-bot — keep delays and identity diversity high. Media (photo/video) is not supported yet.',
    paramsSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 5000,
          description: 'Body of the status update (max 5000 chars).',
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
        await navigate(win, 'https://www.facebook.com/', {
          timeoutMs: Math.min(20_000, timeoutMs),
          signal,
        })

        const early = await _checkEarlySignals(win)
        if (early === 'needs_login') {
          const err = new Error('identity not logged in to Facebook')
          err.code = 'needs_login'
          throw err
        }
        if (early === 'captcha') {
          const err = new Error('Facebook showed a captcha/checkpoint challenge')
          err.code = 'captcha'
          throw err
        }

        // Open the composer dialog (best-effort — some layouts open inline).
        await _clickFirstAvailable(win, SELECTORS.composerOpener)

        const textareaSel = await _waitForAnyAvailable(win, SELECTORS.composeTextarea, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!textareaSel) {
          const err = new Error(
            'compose textbox not found — selectors may be stale OR not logged in',
          )
          err.code = 'not-found'
          throw err
        }

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
          const err = new Error('Post button not found / never enabled')
          err.code = 'not-found'
          throw err
        }

        await _clickButton(win, submitSel)

        const ok = await _waitForConfirmation(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!ok) {
          const err = new Error(
            'clicked Post but the status did not appear to publish (rate limited / blocked)',
          )
          err.code = 'submit-failed'
          throw err
        }

        const ev = await require('./bulk-action-evidence').captureEvidence(win, {
          identityId: identity.id,
          actionId: 'fb_post',
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
        const capSels = ${JSON.stringify(
          SELECTORS.captchaIndicator.concat(SELECTORS.checkpointIndicator),
        )};
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

async function _clickFirstAvailable(win, selectors) {
  try {
    await executeJS(
      win,
      `(function(){
        const sels = ${JSON.stringify(selectors)};
        for (const s of sels) {
          try {
            const el = document.querySelector(s);
            if (el) { el.click(); return true }
          } catch(_e) {}
        }
        return false
      })()`,
    )
  } catch (_e) {
    // best-effort — composer may already be inline
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

async function _typeContentEditable(win, selector, text) {
  const result = await executeJS(
    win,
    `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.focus();
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
          // Create-post dialog gone → published (or cancelled). We treat the
          // editor textbox disappearing as success.
          const sels = ${JSON.stringify(SELECTORS.composeTextarea)};
          for (const s of sels) {
            try { if (document.querySelector(s)) return false } catch(_e) {}
          }
          return true;
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
  buildFbPostAction,
  SELECTORS,
}
