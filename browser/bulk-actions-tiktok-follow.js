// OZ Browser — Bulk Action: tiktok_follow (v2 sub-bloque 5d).
//
// Follow (or unfollow) a TikTok user. Reusa pattern de ig_follow con
// text-walker — TikTok follow button label es estable per-locale.
//
// Flow:
//   1. spawnIdentityWindow
//   2. navigate al profile URL (https://tiktok.com/@username)
//   3. needs_login / captcha check
//   4. Detect state via button text:
//      - "Follow" / "Seguir"           → not-following
//      - "Following" / "Siguiendo"     → following
//      - "Friends" / "Amigos"          → mutual (treated as following)
//   5. Decision matrix idéntico a ig_follow.
//   6. Unfollow flow: click Following → confirmation modal con "Unfollow"
//   7. safeClose
//
// Params:
//   { profileUrl: string (required), unfollow?: boolean, timeoutMs? }
//   profileUrl: 'username' o '@username' o full URL.
//
// Result: { profileUrl, username, action: followed|unfollowed|already-* ... }
// Errors: needs_login | captcha | not-found | click-failed
//
// Rate limit TikTok follows: ~200/día per account es seguro.

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  executeJS,
} = require('./bulk-action-browser-helpers')

const SELECTORS = {
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

// Per-state labels. TikTok-specific. "Friends" (mutual follow) treated
// as following for the decision matrix purposes.
const STATE_LABELS = {
  notFollowing: ['Follow', 'Seguir'],
  following: ['Following', 'Friends', 'Siguiendo', 'Amigos'],
  // Modal text after clicking Following.
  unfollowConfirm: ['Unfollow', 'Dejar de seguir'],
}

function buildTiktokFollowAction({ identityManager, electron }) {
  return {
    id: 'tiktok_follow',
    label: 'TikTok: Follow (or unfollow) a user',
    platform: 'tiktok.com',
    description:
      'Follow (or unfollow) a TikTok user from each identity. profileUrl can be a username, @username, or full URL. Params: profileUrl (required), unfollow (optional, default false), timeoutMs. Returns {profileUrl, username, action: followed|unfollowed|already-following|already-not-following, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | click-failed.',
    paramsSchema: {
      type: 'object',
      properties: {
        profileUrl: {
          type: 'string',
          minLength: 1,
          description:
            'Full URL of the TikTok profile (https://tiktok.com/@user) or just the username.',
        },
        unfollow: {
          type: 'boolean',
          description: 'If true, unfollow instead of follow. Default false.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 5000,
          maximum: 120_000,
        },
      },
      required: ['profileUrl'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { profileUrl, unfollow = false, timeoutMs = 30_000 } = params || {}
      if (!profileUrl) throw new Error('profileUrl required')
      const { url, username } = _normalizeProfile(profileUrl)
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        await navigate(win, url, {
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

        const state = await _waitForFollowState(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!state) {
          const err = new Error(
            'follow button not found — profile may not exist OR selectors stale',
          )
          err.code = 'not-found'
          throw err
        }

        if (unfollow) {
          if (state === 'following') {
            const clicked = await _clickButtonByText(win, STATE_LABELS.following)
            if (!clicked) {
              const err = new Error('Following button click did not register')
              err.code = 'click-failed'
              throw err
            }
            await _sleep(800, signal)
            await _clickButtonByText(win, STATE_LABELS.unfollowConfirm)
            const verified = await _verifyState(win, 'not-following', {
              timeoutMs: 6000,
              signal,
            })
            if (!verified) {
              const err = new Error('unfollow click registered but state did not flip')
              err.code = 'click-failed'
              throw err
            }
            return _success(url, username, 'unfollowed', identity, t0)
          }
          return _success(url, username, 'already-not-following', identity, t0)
        }
        if (state === 'not-following') {
          const clicked = await _clickButtonByText(win, STATE_LABELS.notFollowing)
          if (!clicked) {
            const err = new Error('Follow button click did not register')
            err.code = 'click-failed'
            throw err
          }
          const verified = await _verifyState(win, 'following', {
            timeoutMs: 6000,
            signal,
          })
          if (!verified) {
            const err = new Error(
              'Follow clicked but state did not flip (rate-limited / blocked)',
            )
            err.code = 'click-failed'
            throw err
          }
          return _success(url, username, 'followed', identity, t0)
        }
        return _success(url, username, 'already-following', identity, t0)
      } finally {
        safeClose(win)
      }
    },
  }
}

function _normalizeProfile(input) {
  const trimmed = String(input).trim().replace(/\/+$/, '')
  let username
  if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('tiktok.com/')) {
    const m = trimmed.match(/tiktok\.com\/(@?[^/?#]+)/)
    username = m ? m[1].replace(/^@/, '') : null
  } else {
    username = trimmed.replace(/^@/, '')
  }
  if (!username) throw new Error('cannot parse username from profileUrl')
  return {
    url: `https://www.tiktok.com/@${username}`,
    username,
  }
}

function _success(url, username, action, identity, t0) {
  return {
    profileUrl: url,
    username,
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

async function _waitForFollowState(win, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 300
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return null
    try {
      const state = await executeJS(
        win,
        `(function(){
          const sets = {
            following: ${JSON.stringify(STATE_LABELS.following)},
            'not-following': ${JSON.stringify(STATE_LABELS.notFollowing)},
          };
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const key of ['following', 'not-following']) {
            for (const label of sets[key]) {
              for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                if (txt === label || txt.toLowerCase() === label.toLowerCase()) {
                  return key;
                }
              }
            }
          }
          return null;
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
    const state = await _waitForFollowState(win, { timeoutMs: 600, signal })
    if (state === expected) return true
    await _sleep(300, signal)
  }
  return false
}

async function _clickButtonByText(win, labels) {
  try {
    const result = await executeJS(
      win,
      `(function(){
        const labels = ${JSON.stringify(labels)};
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const label of labels) {
          for (const btn of buttons) {
            const txt = (btn.textContent || '').trim();
            if (txt === label || txt.toLowerCase() === label.toLowerCase()) {
              btn.click();
              return { ok: true, clicked: label };
            }
          }
        }
        return { ok: false };
      })()`,
    )
    return !!(result && result.ok)
  } catch (_e) {
    return false
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
  buildTiktokFollowAction,
  SELECTORS,
  STATE_LABELS,
  _normalizeProfile,
}
