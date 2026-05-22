// OZ Browser — Bulk Action: tiktok_like (v2 sub-bloque 5d).
//
// Like (or unlike) a TikTok video desde una identity. Reusa pattern de
// x_like — detection via data-e2e attributes (TikTok uses data-e2e
// instead of data-testid, but same idea: stable test selectors).
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate al videoUrl
//   3. needs_login / captcha check
//   4. Detect state via data-e2e:
//      - [data-e2e="like-icon"][aria-pressed="false"]  → not-liked
//      - [data-e2e="like-icon"][aria-pressed="true"]   → liked
//      Fallback: detect heart icon color (filled = liked).
//   5. Decision matrix mismo que x_like: liked / unliked / already-* / *-no-op.
//   6. safeClose
//
// Params:
//   { videoUrl: string (required), unlike?: boolean, timeoutMs? }
//
// Result: { videoUrl, action: liked|unliked|already-liked|already-not-liked, ... }
// Errors: needs_login | captcha | not-found | click-failed
//
// Rate limit TikTok likes: ~500/día per account es típico. Más permisivo que
// IG. Pero TikTok detecta patterns repetitivos rápido — los delays 30-90s
// del bulk runner ayudan.

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
  // Estado actual del like via data-e2e + aria-pressed.
  likeButton: [
    '[data-e2e="like-icon"]',
    '[data-e2e="browse-like-icon"]',
    'button[aria-label*="Like" i]',
    'button[aria-label*="Me gusta" i]',
  ],
  loginIndicator: [
    'a[href*="/login"]',
    'a[data-e2e="login-button"]',
    'div[data-e2e="login-button"]',
  ],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    '[class*="captcha-verify"]',
    '[id*="captcha"]',
  ],
}

function buildTiktokLikeAction({ identityManager, electron }) {
  return {
    id: 'tiktok_like',
    label: 'TikTok: Like a video',
    platform: 'tiktok.com',
    description:
      'Like (or unlike) a TikTok video from each identity. Params: videoUrl (required), unlike (optional, default false), timeoutMs. Returns {videoUrl, action: liked|unliked|already-liked|already-not-liked, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | click-failed.',
    paramsSchema: {
      type: 'object',
      properties: {
        videoUrl: {
          type: 'string',
          minLength: 1,
          description:
            'Full URL of the TikTok video (e.g. https://www.tiktok.com/@user/video/12345).',
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
      required: ['videoUrl'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { videoUrl, unlike = false, timeoutMs = 30_000 } = params || {}
      if (!videoUrl) throw new Error('videoUrl required')
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        await navigate(win, videoUrl, {
          timeoutMs: Math.min(20_000, timeoutMs),
          signal,
        })

        const early = await _checkEarlySignals(win)
        if (early === 'needs_login') {
          const err = new Error('identity not logged in to TikTok')
          err.code = 'needs_login'
          throw err
        }
        if (early === 'captcha') {
          const err = new Error('TikTok showed a captcha challenge')
          err.code = 'captcha'
          throw err
        }

        const state = await _waitForLikeState(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!state) {
          const err = new Error(
            'like button not found — video may not exist OR selectors stale',
          )
          err.code = 'not-found'
          throw err
        }

        if (unlike) {
          if (state === 'liked') {
            const clicked = await _clickButton(win)
            if (!clicked) {
              const err = new Error('clicked like button but it did not register')
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
            return _success(videoUrl, 'unliked', identity, t0)
          }
          return _success(videoUrl, 'already-not-liked', identity, t0)
        }
        // unlike=false: add a like.
        if (state === 'not-liked') {
          const clicked = await _clickButton(win)
          if (!clicked) {
            const err = new Error('clicked like button but it did not register')
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
          return _success(videoUrl, 'liked', identity, t0)
        }
        return _success(videoUrl, 'already-liked', identity, t0)
      } finally {
        safeClose(win)
      }
    },
  }
}

function _success(videoUrl, action, identity, t0) {
  return {
    videoUrl,
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
        return null
      })()`,
    )
  } catch (_e) {
    return null
  }
}

/**
 * Returns 'liked' | 'not-liked' | null based on the aria-pressed state of
 * the like button. TikTok toggles aria-pressed when the user likes.
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
                // aria-pressed='true' on the like icon/button means liked.
                const pressed = el.getAttribute('aria-pressed');
                if (pressed === 'true') return 'liked';
                if (pressed === 'false') return 'not-liked';
                // Fallback: check the parent button for aria-pressed.
                const btn = el.closest('button, [role="button"]');
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
          const btn = el.closest('button, [role="button"]') || el;
          btn.click();
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
  buildTiktokLikeAction,
  SELECTORS,
}
