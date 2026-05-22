// OZ Browser — Bulk Action: fb_like (v2 sub-bloque 5e).
//
// Like (or unlike) a Facebook post desde una identity. FB es notoriamente
// agresivo con anti-bot detection — el approach del bulk runner mitiga:
//   - Per-identity window con FP/proxy únicos
//   - Delays 30-90s entre identities
//   - Auto-login retry usa creds del vault (FB 2FA via TOTP)
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate al postUrl (FB post permalink)
//   3. needs_login / captcha / checkpoint check
//   4. Detect state via button aria-label OR aria-pressed:
//      - aria-pressed="true" en Like button → liked
//      - aria-pressed="false"               → not-liked
//   5. Decision matrix idéntico a tiktok_like / x_like.
//   6. safeClose
//
// Params:
//   { postUrl: string (required), unlike?: boolean, timeoutMs? }
//
// Result: { postUrl, action: liked|unliked|already-*, ... }
// Errors: needs_login | captcha | not-found | click-failed
//
// Rate limit FB likes: ~200-500/día per account es relatively safe pero
// FB monitorea patterns: like-only sessions sin scroll/clicks intermedio
// se marcan rápido. Por eso bulk runner delays + diversidad de identities
// son críticos.

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
  likeButton: [
    'div[aria-label="Like"][role="button"]',
    'div[aria-label="Me gusta"][role="button"]',
    'span[aria-label="Like" i][role="button"]',
    'button[aria-label="Like" i]',
    'button[aria-label="Me gusta" i]',
  ],
  loginIndicator: ['a[href*="/login"]', 'input[name="email"]', 'div[id="loginbutton"]'],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    'div[role="dialog"]:has(iframe)',
  ],
  // FB checkpoint screen (security challenge) — surface as captcha.
  checkpointIndicator: ['div[role="dialog"]:has(h2)', 'form[action*="checkpoint"]'],
}

function buildFbLikeAction({ identityManager, electron }) {
  return {
    id: 'fb_like',
    label: 'Facebook: Like a post',
    platform: 'facebook.com',
    description:
      'Like (or unlike) a Facebook post from each identity. Params: postUrl (required), unlike (optional, default false), timeoutMs. Returns {postUrl, action: liked|unliked|already-liked|already-not-liked, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | click-failed. Auto-login retry kicks in on needs_login if vault is wired. NOTE: FB is aggressive about anti-bot — keep delays high and identity diversity high.',
    paramsSchema: {
      type: 'object',
      properties: {
        postUrl: {
          type: 'string',
          minLength: 1,
          description:
            'Full URL of the FB post (e.g. https://www.facebook.com/user/posts/12345).',
        },
        unlike: {
          type: 'boolean',
          description: 'If true, remove an existing like. Default false.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 5000,
          maximum: 120_000,
        },
      },
      required: ['postUrl'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { postUrl, unlike = false, timeoutMs = 30_000 } = params || {}
      if (!postUrl) throw new Error('postUrl required')
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        await navigate(win, postUrl, {
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
          const err = new Error('Facebook showed a captcha or checkpoint challenge')
          err.code = 'captcha'
          throw err
        }

        const state = await _waitForLikeState(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!state) {
          const err = new Error(
            'like button not found — post may not be accessible OR selectors stale',
          )
          err.code = 'not-found'
          throw err
        }

        if (unlike) {
          if (state === 'liked') {
            const clicked = await _clickButton(win)
            if (!clicked) {
              const err = new Error('clicked but no like button found')
              err.code = 'click-failed'
              throw err
            }
            const verified = await _verifyState(win, 'not-liked', {
              timeoutMs: 6000,
              signal,
            })
            if (!verified) {
              const err = new Error(
                'clicked but state did not flip (rate-limited / blocked)',
              )
              err.code = 'click-failed'
              throw err
            }
            return _success(postUrl, 'unliked', identity, t0)
          }
          return _success(postUrl, 'already-not-liked', identity, t0)
        }
        if (state === 'not-liked') {
          const clicked = await _clickButton(win)
          if (!clicked) {
            const err = new Error('clicked but no like button found')
            err.code = 'click-failed'
            throw err
          }
          const verified = await _verifyState(win, 'liked', {
            timeoutMs: 6000,
            signal,
          })
          if (!verified) {
            const err = new Error(
              'clicked but state did not flip (rate-limited / blocked)',
            )
            err.code = 'click-failed'
            throw err
          }
          return _success(postUrl, 'liked', identity, t0)
        }
        return _success(postUrl, 'already-liked', identity, t0)
      } finally {
        safeClose(win)
      }
    },
  }
}

function _success(postUrl, action, identity, t0) {
  return {
    postUrl,
    action,
    identityId: identity.id,
    identityName: identity.name || null,
    durationMs: Date.now() - t0,
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
        const cpSels = ${JSON.stringify(SELECTORS.checkpointIndicator)};
        for (const s of cpSels) {
          try { if (document.querySelector(s)) return 'captcha' } catch(_e) {}
        }
        return null
      })()`,
    )
  } catch (_e) {
    return null
  }
}

/**
 * Returns 'liked' | 'not-liked' | null based on the aria-pressed state of
 * the FB like button.
 */
async function _waitForLikeState(win, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 300
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return null
    try {
      const state = await executeJS(
        win,
        `(function(){
          const sels = ${JSON.stringify(SELECTORS.likeButton)};
          for (const s of sels) {
            try {
              const el = document.querySelector(s);
              if (el) {
                const pressed = el.getAttribute('aria-pressed');
                if (pressed === 'true') return 'liked';
                if (pressed === 'false') return 'not-liked';
                // FB sometimes uses parent button for aria-pressed.
                const btn = el.closest('[aria-pressed]');
                if (btn) {
                  const bp = btn.getAttribute('aria-pressed');
                  if (bp === 'true') return 'liked';
                  if (bp === 'false') return 'not-liked';
                }
                // Last resort: button is present but no aria — assume not-liked.
                return 'not-liked';
              }
            } catch(_e) {}
          }
          return null
        })()`,
      )
      if (state) return state
    } catch (_e) {
      // ignore — keep polling
    }
    await _sleep(pollMs, signal)
  }
  return null
}

async function _verifyState(win, expected, { timeoutMs, signal } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return false
    const state = await _waitForLikeState(win, { timeoutMs: 600, signal })
    if (state === expected) return true
    await _sleep(300, signal)
  }
  return false
}

async function _clickButton(win) {
  for (const sel of SELECTORS.likeButton) {
    try {
      const result = await executeJS(
        win,
        `(function(){
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { ok: false };
          const target = el.closest('[role="button"], button') || el;
          target.click();
          return { ok: true };
        })()`,
      )
      if (result && result.ok) return true
    } catch (_e) {
      // try next selector
    }
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
  buildFbLikeAction,
  SELECTORS,
}
