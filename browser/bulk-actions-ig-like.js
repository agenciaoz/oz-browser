// OZ Browser — Bulk Action: ig_like (v2 sub-bloque 5a).
//
// Like (o unlike) un post de Instagram desde una identity. Asume la
// identity tiene sesión IG activa O auto-login con vault va a rescatar
// si no.
//
// Flow:
//   1. spawnIdentityWindow para la identity
//   2. navigate al postUrl
//   3. Detectar needs_login / captcha early (~2s)
//   4. Buscar el botón Like — IG usa `svg[aria-label="Like"]` (logged-out
//      icon) o `svg[aria-label="Unlike"]` (logged-in heart filled).
//      - Si `params.unlike === true`: el target es el botón con
//        aria-label="Unlike" (post YA likeado); si no aparece, NO-OP
//        success con `alreadyUnliked: true`.
//      - Si `params.unlike` falso/ausente: target es aria-label="Like";
//        si no aparece y aria-label="Unlike" sí, NO-OP success con
//        `alreadyLiked: true`.
//   5. Click en el button ancestor del SVG (el SVG no es directamente
//      clickeable — está adentro de un <button> o <div role="button">).
//   6. Verify post-click: el aria-label del svg cambió al opuesto.
//   7. safeClose
//
// Params:
//   { postUrl: string (required), unlike?: boolean (default false),
//     timeoutMs?: number (default 30000) }
//
// Result on success:
//   { postUrl, action: 'liked' | 'unliked' | 'already-liked' | 'already-unliked',
//     identityId, identityName, durationMs }
//
// On failure: throws con error.code:
//   - 'needs_login' — auto-login retry kicks in si vault wireado
//   - 'captcha' — IG challenge, no auto-resolve
//   - 'not-found' — postUrl 404 / Like button no apareció
//   - 'click-failed' — clickeé pero el state no cambió (post protegido,
//     rate-limited, IG bloqueó la action)
//
// IG tiene rate limits agresivos en likes — 60 likes/hora es típico antes
// de soft-ban (action blocked temporarily). El bulk runner ya separa con
// delays de 30-90s default, así que en una corrida de 50 identities el
// rate per-account queda bajo. Pero si Jose corre la MISMA identity
// likeando 50 posts rápido, IG la marca. Esa lógica de rate-limit cross-run
// es v2 sub-bloque futuro.
//
// Doc: docs/modules/bulk-actions-ig-like.md (TBD)

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  click,
  executeJS,
} = require('./bulk-action-browser-helpers')

// Selectors — IG svg aria-label rota entre EN/ES. El click no es sobre el
// svg sino sobre el button ancestor — por eso usamos `closest('button, [role="button"]')`
// dentro del executeJS de click.
const SELECTORS = {
  // svg con aria-label de "Like" (post NO likeado todavía) — clicking
  // este lleva a estado "Unlike".
  likeIcon: [
    'svg[aria-label="Like"]',
    'svg[aria-label="Me gusta"]',
    'svg[aria-label="Like" i]',
  ],
  // svg con aria-label de "Unlike" (post YA likeado).
  unlikeIcon: [
    'svg[aria-label="Unlike"]',
    'svg[aria-label="Quitar Me gusta"]',
    'svg[aria-label="No me gusta"]',
    'svg[aria-label="Unlike" i]',
  ],
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

function buildIgLikeAction({ identityManager, electron }) {
  return {
    id: 'ig_like',
    label: 'Instagram: Like a post',
    platform: 'instagram.com',
    description:
      'Like (or unlike) an Instagram post from each identity. Requires identity is logged in to IG (auto-login retry kicks in if vault wired). Params: postUrl (required), unlike (optional, default false). Returns {postUrl, action: liked|unliked|already-liked|already-unliked, identityName, durationMs}. Throws with error.code: needs_login | captcha | not-found | click-failed.',
    paramsSchema: {
      type: 'object',
      properties: {
        postUrl: {
          type: 'string',
          minLength: 1,
          description:
            'Full URL of the Instagram post (e.g. https://www.instagram.com/p/ABC123/)',
        },
        unlike: {
          type: 'boolean',
          description:
            'If true, remove an existing like instead of adding one. Default false (= add a like).',
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
        await navigate(win, postUrl, { timeoutMs: Math.min(20_000, timeoutMs), signal })

        // Early needs_login / captcha check.
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

        // Poll for either icon — IG hydrates the post asynchronously.
        const state = await _waitForLikeState(win, {
          timeoutMs: Math.min(15_000, timeoutMs),
          signal,
        })
        if (!state) {
          const err = new Error(
            'neither Like nor Unlike button found — selectors may be stale OR post does not exist',
          )
          err.code = 'not-found'
          throw err
        }

        // Decide action based on params.unlike + current state.
        if (unlike) {
          if (state === 'liked') {
            // Need to remove the like.
            const clicked = await _clickIcon(win, SELECTORS.unlikeIcon)
            if (!clicked) {
              const err = new Error('clicked Unlike icon but click did not register')
              err.code = 'click-failed'
              throw err
            }
            const verified = await _verifyStateAfterClick(win, 'not-liked', {
              timeoutMs: 6000,
              signal,
            })
            if (!verified) {
              const err = new Error(
                'clicked Unlike but post still shows liked state (rate limited / blocked)',
              )
              err.code = 'click-failed'
              throw err
            }
            return _success(postUrl, 'unliked', identity, t0)
          }
          // Already not-liked — no-op success.
          return _success(postUrl, 'already-unliked', identity, t0)
        }
        // unlike=false: we want to add a like.
        if (state === 'not-liked') {
          const clicked = await _clickIcon(win, SELECTORS.likeIcon)
          if (!clicked) {
            const err = new Error('clicked Like icon but click did not register')
            err.code = 'click-failed'
            throw err
          }
          const verified = await _verifyStateAfterClick(win, 'liked', {
            timeoutMs: 6000,
            signal,
          })
          if (!verified) {
            const err = new Error(
              'clicked Like but post still shows not-liked state (rate limited / blocked)',
            )
            err.code = 'click-failed'
            throw err
          }
          return _success(postUrl, 'liked', identity, t0)
        }
        // Already liked — no-op success.
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

/**
 * Returns 'needs_login' | 'captcha' | null. Quick check, ~2s window.
 */
async function _checkEarlySignals(win) {
  try {
    const res = await executeJS(
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
                  if (el.textContent && el.textContent.includes(text)) {
                    return 'needs_login'
                  }
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
    return res
  } catch (_e) {
    return null
  }
}

/**
 * Polls for either Like or Unlike icon. Returns 'not-liked' | 'liked' | null.
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
          const likeSels = ${JSON.stringify(SELECTORS.likeIcon)};
          for (const s of likeSels) {
            try { if (document.querySelector(s)) return 'not-liked' } catch(_e) {}
          }
          const unlikeSels = ${JSON.stringify(SELECTORS.unlikeIcon)};
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
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

/**
 * Click the closest button/role=button ancestor of the first matching svg.
 * Returns true if a click was dispatched. The SVG itself isn't clickable
 * in IG's DOM — the click target is the parent button.
 */
async function _clickIcon(win, selectorList) {
  for (const sel of selectorList) {
    try {
      const result = await executeJS(
        win,
        `(function(){
          const svg = document.querySelector(${JSON.stringify(sel)});
          if (!svg) return { ok: false, reason: 'svg-not-found' };
          const btn = svg.closest('button, [role="button"], a');
          if (!btn) return { ok: false, reason: 'no-button-ancestor' };
          btn.click();
          return { ok: true };
        })()`,
      )
      if (result && result.ok) return true
    } catch (_e) {
      // try next selector
    }
  }
  // Fallback: try synthetic click() helper directly on selectors.
  for (const sel of selectorList) {
    try {
      await click(win, sel)
      return true
    } catch (_e) {
      // ignore
    }
  }
  return false
}

/**
 * Polls until the page shows the desired post-click state, or timeout.
 */
async function _verifyStateAfterClick(win, expected, { timeoutMs, signal } = {}) {
  const start = Date.now()
  const pollMs = 300
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) return false
    const state = await _waitForLikeState(win, { timeoutMs: pollMs, signal })
    if (state === expected) return true
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

module.exports = {
  buildIgLikeAction,
  // Exported for tests.
  SELECTORS,
}
