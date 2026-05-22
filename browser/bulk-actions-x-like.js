// OZ Browser — Bulk Action: x_like (v2 sub-bloque 5c).
//
// Like (or unlike) a tweet on X (Twitter) desde una identity. Reusa el
// pattern de ig_like: spawn + navigate + needs_login/captcha + locate
// target button by data-testid + click + verify state flip.
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate al tweet URL
//   3. needs_login / captcha check
//   4. Detect state via data-testid:
//      - button[data-testid="like"]   → not-liked
//      - button[data-testid="unlike"] → liked
//   5. Decision matrix:
//      - unlike=false + not-liked → click → verify testid=unlike
//      - unlike=false + liked     → 'already-liked' (no click)
//      - unlike=true  + liked     → click → verify testid=like
//      - unlike=true  + not-liked → 'already-not-liked' (no click)
//   6. safeClose
//
// Params:
//   { tweetUrl: string (required), unlike?: boolean, timeoutMs? }
//
// Result: { tweetUrl, action: liked|unliked|already-liked|already-not-liked, ... }
// Errors: needs_login | captcha | not-found | click-failed
//
// Doc: docs/modules/bulk-actions-x-like.md (TBD)

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
  likeButton: ['button[data-testid="like"]', 'div[data-testid="like"]'],
  unlikeButton: ['button[data-testid="unlike"]', 'div[data-testid="unlike"]'],
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

function buildXLikeAction({ identityManager, electron }) {
  return {
    id: 'x_like',
    label: 'X (Twitter): Like a tweet',
    platform: 'x.com',
    description:
      'Like (or unlike) a tweet on X from each identity. Params: tweetUrl (required), unlike (optional, default false), timeoutMs. Returns {tweetUrl, action: liked|unliked|already-liked|already-not-liked, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | click-failed. Auto-login kicks in on needs_login.',
    paramsSchema: {
      type: 'object',
      properties: {
        tweetUrl: {
          type: 'string',
          minLength: 1,
          description: 'Full URL of the tweet (e.g. https://x.com/user/status/12345).',
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
      required: ['tweetUrl'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { tweetUrl, unlike = false, timeoutMs = 30_000 } = params || {}
      if (!tweetUrl) throw new Error('tweetUrl required')
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        await navigate(win, tweetUrl, {
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

        const state = await _waitForLikeState(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!state) {
          const err = new Error(
            'neither Like nor Unlike button found — tweet may not exist OR selectors stale',
          )
          err.code = 'not-found'
          throw err
        }

        if (unlike) {
          if (state === 'liked') {
            const clicked = await _clickFirst(win, SELECTORS.unlikeButton)
            if (!clicked) {
              const err = new Error('clicked Unlike button but it did not register')
              err.code = 'click-failed'
              throw err
            }
            const verified = await _verifyState(win, 'not-liked', {
              timeoutMs: 6000,
              signal,
            })
            if (!verified) {
              const err = new Error(
                'clicked Unlike but state did not flip (rate limited / blocked)',
              )
              err.code = 'click-failed'
              throw err
            }
            return _success(tweetUrl, 'unliked', identity, t0)
          }
          return _success(tweetUrl, 'already-not-liked', identity, t0)
        }
        // unlike=false: add a like.
        if (state === 'not-liked') {
          const clicked = await _clickFirst(win, SELECTORS.likeButton)
          if (!clicked) {
            const err = new Error('clicked Like button but it did not register')
            err.code = 'click-failed'
            throw err
          }
          const verified = await _verifyState(win, 'liked', {
            timeoutMs: 6000,
            signal,
          })
          if (!verified) {
            const err = new Error(
              'clicked Like but state did not flip (rate limited / blocked)',
            )
            err.code = 'click-failed'
            throw err
          }
          return _success(tweetUrl, 'liked', identity, t0)
        }
        return _success(tweetUrl, 'already-liked', identity, t0)
      } finally {
        safeClose(win)
      }
    },
  }
}

function _success(tweetUrl, action, identity, t0) {
  return {
    tweetUrl,
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

async function _waitForLikeState(win, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 300
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return null
    try {
      const state = await executeJS(
        win,
        `(function(){
          const likeSels = ${JSON.stringify(SELECTORS.likeButton)};
          for (const s of likeSels) {
            try { if (document.querySelector(s)) return 'not-liked' } catch(_e) {}
          }
          const unlikeSels = ${JSON.stringify(SELECTORS.unlikeButton)};
          for (const s of unlikeSels) {
            try { if (document.querySelector(s)) return 'liked' } catch(_e) {}
          }
          return null
        })()`,
      )
      if (state) return state
    } catch (_e) {
      // ignore
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

async function _clickFirst(win, selectors) {
  for (const sel of selectors) {
    try {
      const result = await executeJS(
        win,
        `(function(){
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { ok: false };
          el.click();
          return { ok: true };
        })()`,
      )
      if (result && result.ok) return true
    } catch (_e) {
      // ignore
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
  buildXLikeAction,
  SELECTORS,
}
