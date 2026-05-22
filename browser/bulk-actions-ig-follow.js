// OZ Browser — Bulk Action: ig_follow (v2 sub-bloque 5b).
//
// Follow (or unfollow) un usuario de Instagram desde una identity.
// Reusa el pattern de ig_like + ig_comment: spawn + navigate + early
// needs_login/captcha + locate target button + click + verify.
//
// Flow:
//   1. spawnIdentityWindow para la identity
//   2. navigate a https://instagram.com/<username>/  (perfil)
//   3. Detectar needs_login / captcha early
//   4. Detectar estado actual via button text:
//      - "Follow" / "Seguir"           → not-following
//      - "Following" / "Siguiendo"     → following
//      - "Requested" / "Solicitado"    → pending (cuenta privada)
//   5. Decisión:
//      - unfollow=false + not-following → click Follow → verify "Following"|"Requested"
//      - unfollow=false + following     → action='already-following' (no click)
//      - unfollow=false + pending       → action='already-requested' (no click)
//      - unfollow=true  + following     → click Following → confirmation modal
//                                          → click "Unfollow" → verify "Follow"
//      - unfollow=true  + not-following → action='already-not-following' (no click)
//      - unfollow=true  + pending       → click + verify (cancela request)
//
// Params:
//   { profileUrl: string (required), unfollow?: boolean (default false),
//     timeoutMs?: number (default 30000) }
//   profileUrl puede ser:
//      'https://instagram.com/jose'  o  'jose'  (username plano).
//   El action normaliza ambos a https://www.instagram.com/<username>/
//
// Result on success:
//   { profileUrl, username, action: 'followed' | 'unfollowed' | 'requested'
//                                  | 'already-following' | 'already-not-following'
//                                  | 'already-requested',
//     identityId, identityName, durationMs }
//
// Error codes:
//   - 'needs_login' — auto-login retry kicks in
//   - 'captcha'
//   - 'not-found' — perfil no existe O button no detectado (selectors stale)
//   - 'click-failed' — clickeé pero estado no flippeó (rate-limited / blocked)
//
// Rate limits IG follow: ~150/día per account es típico antes de soft-ban.
// Mucho más conservador que likes. El bulk runner ya separa con 30-90s
// delays defaults, suficiente para no triggerar rate-limit per-account
// dentro de una corrida.
//
// Doc: docs/modules/bulk-actions-ig-follow.md (TBD)

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  executeJS,
} = require('./bulk-action-browser-helpers')

// Selectors — IG cambia el DOM pero el patrón de button text es estable
// porque es text-based UI. Usamos text-walker en vez de class selectors.
const SELECTORS = {
  loginIndicator: [
    'a[href="/accounts/login/"]',
    'a[href*="/accounts/login"]',
    'button:contains("Log in")',
    'button:contains("Iniciar sesión")',
  ],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]',
  ],
}

// Button text labels per state. Each language variant grouped.
const STATE_LABELS = {
  notFollowing: ['Follow', 'Follow back', 'Seguir', 'Seguir también'],
  following: ['Following', 'Siguiendo'],
  pending: ['Requested', 'Solicitado'],
  // Confirmation modal text after clicking "Following".
  unfollowConfirm: ['Unfollow', 'Dejar de seguir', 'Cancel follow request'],
}

function buildIgFollowAction({ identityManager, electron }) {
  return {
    id: 'ig_follow',
    label: 'Instagram: Follow (or unfollow) a user',
    platform: 'instagram.com',
    description:
      'Follow (or unfollow) an Instagram profile from each identity. profileUrl can be a full URL or just the username. Params: profileUrl (required), unfollow (optional, default false). Returns {profileUrl, username, action: followed|unfollowed|requested|already-following|already-not-following|already-requested, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | click-failed. Auto-login retry kicks in on needs_login if vault is wired.',
    paramsSchema: {
      type: 'object',
      properties: {
        profileUrl: {
          type: 'string',
          minLength: 1,
          description:
            'Full URL of the IG profile (https://instagram.com/<user>) or just the username.',
        },
        unfollow: {
          type: 'boolean',
          description: 'If true, unfollow instead of follow. Default false (= follow).',
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
        await navigate(win, url, { timeoutMs: Math.min(20_000, timeoutMs), signal })

        const early = await _checkEarlySignals(win)
        if (early === 'needs_login') {
          const err = new Error('identity not logged in to Instagram')
          err.code = 'needs_login'
          throw err
        }
        if (early === 'captcha') {
          const err = new Error('Instagram showed a captcha challenge')
          err.code = 'captcha'
          throw err
        }

        // Wait for the follow button to render (any state).
        const state = await _waitForFollowState(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!state) {
          const err = new Error(
            'follow button not found — profile may not exist OR selectors are stale',
          )
          err.code = 'not-found'
          throw err
        }

        // Decision matrix.
        if (unfollow) {
          if (state === 'following' || state === 'pending') {
            // Click the Following/Requested button → opens confirm modal.
            const clicked = await _clickButtonByText(
              win,
              state === 'following' ? STATE_LABELS.following : STATE_LABELS.pending,
            )
            if (!clicked) {
              const err = new Error('Following button click did not register')
              err.code = 'click-failed'
              throw err
            }
            // Wait briefly for modal to appear, then click confirm.
            await _sleep(800, signal)
            await _clickButtonByText(win, STATE_LABELS.unfollowConfirm)
            const verified = await _verifyState(win, 'not-following', {
              timeoutMs: 6000,
              signal,
            })
            if (!verified) {
              const err = new Error(
                'unfollow click registered but profile still shows following state',
              )
              err.code = 'click-failed'
              throw err
            }
            return _success(url, username, 'unfollowed', identity, t0)
          }
          // Already not-following → no-op.
          return _success(url, username, 'already-not-following', identity, t0)
        }
        // unfollow=false: we want to follow.
        if (state === 'not-following') {
          const clicked = await _clickButtonByText(win, STATE_LABELS.notFollowing)
          if (!clicked) {
            const err = new Error('Follow button click did not register')
            err.code = 'click-failed'
            throw err
          }
          // Verify — could end up in 'following' (public) or 'pending' (private).
          const newState = await _waitForFollowState(win, {
            timeoutMs: 6000,
            signal,
          })
          if (newState === 'following') {
            return _success(url, username, 'followed', identity, t0)
          }
          if (newState === 'pending') {
            return _success(url, username, 'requested', identity, t0)
          }
          const err = new Error(
            'Follow clicked but profile still shows not-following (rate limited / blocked)',
          )
          err.code = 'click-failed'
          throw err
        }
        if (state === 'pending') {
          return _success(url, username, 'already-requested', identity, t0)
        }
        // state === 'following'
        return _success(url, username, 'already-following', identity, t0)
      } finally {
        safeClose(win)
      }
    },
  }
}

function _normalizeProfile(input) {
  const trimmed = String(input).trim().replace(/\/+$/, '')
  // If it looks like a URL, parse the last segment.
  let username
  if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('instagram.com/')) {
    const m = trimmed.match(/instagram\.com\/([^/?#]+)/)
    username = m ? m[1] : null
  } else {
    username = trimmed.replace(/^@/, '')
  }
  if (!username) throw new Error('cannot parse username from profileUrl')
  return {
    url: `https://www.instagram.com/${username}/`,
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
          try {
            if (s.includes(':contains(')) {
              const m = s.match(/^([^:]+):contains\\("([^"]+)"\\)$/)
              if (m) {
                const base = m[1]; const text = m[2]
                const els = document.querySelectorAll(base)
                for (const el of els) {
                  if (el.textContent && el.textContent.includes(text)) return 'needs_login'
                }
                continue
              }
            }
            if (document.querySelector(s)) return 'needs_login'
          } catch(_e) {}
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
 * Poll for the follow button by walking the DOM for buttons whose text
 * matches the known label sets. Returns 'not-following' | 'following' |
 * 'pending' | null.
 */
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
            'not-following': ${JSON.stringify(STATE_LABELS.notFollowing)},
            'following': ${JSON.stringify(STATE_LABELS.following)},
            'pending': ${JSON.stringify(STATE_LABELS.pending)},
          };
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          // 'following' must beat 'not-following' because IG sometimes has
          // both visible during transitions. Check most-specific first.
          for (const key of ['following', 'pending', 'not-following']) {
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

/**
 * Click the first button whose textContent matches one of `labels`.
 * Returns true if a click was dispatched.
 */
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
  buildIgFollowAction,
  SELECTORS,
  STATE_LABELS,
  // Exported for tests.
  _normalizeProfile,
}
