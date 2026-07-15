// OZ Browser — Bulk Action: linkedin_post (v2 Publishing Etapa 6, alpha.106).
//
// Postea un texto en LinkedIn desde una identity. Clona el pattern de fb_post
// (abrir composer → editor contenteditable → dispatch input → submit → verify),
// con el flujo del "Start a post" de LinkedIn (editor Quill `.ql-editor`).
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate a https://www.linkedin.com/feed/
//   3. needs_login / captcha check (early)
//   4. Click "Start a post" opener
//   5. Wait dialog editor: div[role="dialog"] div.ql-editor[contenteditable]
//   6. Type via execCommand insertText (React/Quill-friendly)
//   7. Click submit: button.share-actions__primary-action / aria-label Post
//   8. Verify: dialog cerrado
//   9. captureEvidence + safeClose
//
// Params: { text: string (required, 1-3000), timeoutMs?: number (default 60000) }
// Result: { text, identityId, identityName, durationMs, evidencePath? }
// Errors: needs_login | captcha | not-found | submit-failed
//
// LinkedIn cambia el DOM seguido — apoyarse en dry-run + screenshot.
// Doc: docs/modules/bulk-actions-linkedin-post.md · ADR 0038.

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  type: typeText,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
  composerOpener: [
    'button.share-box-feed-entry__trigger',
    'button[aria-label*="Start a post" i]',
    'button[aria-label*="Crear publicación" i]',
    'button[aria-label*="Empezar" i]',
  ],
  composeTextarea: [
    'div[role="dialog"] div.ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
  submitButton: [
    'div[role="dialog"] button.share-actions__primary-action',
    'button.share-actions__primary-action',
    'div[role="dialog"] button[aria-label="Post"]',
    'div[role="dialog"] button[aria-label="Publicar"]',
  ],
  loginIndicator: ['input[name="session_key"]', 'a[href*="/login"]', 'form.login__form'],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    'div[data-test-id*="challenge"]',
  ],
}

function buildLinkedinPostAction({ identityManager, electron }) {
  return {
    id: 'linkedin_post',
    label: 'LinkedIn: Post an update',
    platform: 'linkedin.com',
    description:
      'Post a text update on LinkedIn from each identity. Params: text (required, 1-3000 chars), timeoutMs. Returns {text, identityName, durationMs, evidencePath}. Throws with error.code: needs_login | captcha | not-found | submit-failed. Auto-login retry kicks in on needs_login if vault is wired. NOTE: LinkedIn changes its DOM often — lean on dry-run + screenshot. Media not supported yet.',
    paramsSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 3000,
          description: 'Body of the LinkedIn post (max 3000 chars).',
        },
        timeoutMs: { type: 'number', minimum: 5000, maximum: 180_000 },
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
        await navigate(win, 'https://www.linkedin.com/feed/', {
          timeoutMs: Math.min(20_000, timeoutMs),
          signal,
        })

        const early = await _checkEarlySignals(win)
        if (early === 'needs_login') {
          const err = new Error('identity not logged in to LinkedIn')
          err.code = 'needs_login'
          throw err
        }
        if (early === 'captcha') {
          const err = new Error('LinkedIn showed a captcha/challenge')
          err.code = 'captcha'
          throw err
        }

        await _clickFirstAvailable(win, SELECTORS.composerOpener)

        const textareaSel = await _waitForAnyAvailable(win, SELECTORS.composeTextarea, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!textareaSel) {
          const err = new Error(
            'compose editor not found — selectors may be stale OR not logged in',
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
            'clicked Post but the update did not appear to publish (rate limited / blocked)',
          )
          err.code = 'submit-failed'
          throw err
        }

        const ev = await require('./bulk-action-evidence').captureEvidence(win, {
          identityId: identity.id,
          actionId: 'linkedin_post',
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
          // Share dialog editor gone → published (or cancelled). Treat the
          // editor disappearing as success.
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
  buildLinkedinPostAction,
  SELECTORS,
}
