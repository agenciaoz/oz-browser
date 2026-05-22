// OZ Browser — Bulk Action: ig_comment (v2 sub-bloque 3b).
//
// Postea un comentario en un post de Instagram desde una identity.
// Asume la identity tiene sesión IG activa (login manual previo).
//
// Flow:
//   1. spawnIdentityWindow para la identity
//   2. navigate al postUrl
//   3. waitForSelector del comment textarea (con fallback a múltiples variantes
//      porque IG cambia DOM frecuentemente)
//   4. Detectar needs_login (presence de login button) → fail 'needs_login'
//   5. Detectar captcha (presence de captcha challenge) → fail 'captcha'
//   6. Click + type el comentario via helpers (eventos input+change disparados
//      para que React detecte el value)
//   7. Click el botón Post (texto "Post" / "Publicar" / "Comentar" o aria-label)
//   8. Espera confirmación: textarea vacío O el comment apareció en feed
//   9. safeClose la window
//
// Params:
//   { postUrl: string (required), comment: string (required),
//     timeoutMs?: number (default 60000) }
//
// Result on success: { postUrl, comment, identityId, identityName, durationMs }
// On failure: throws con error.message + (cuando aplica) error.code:
//   - 'needs_login' — la identity no está logueada en IG
//   - 'captcha' — IG mostró un challenge
//   - 'not-found' — el postUrl 404 o el textarea no apareció
//   - 'submit-failed' — escribí el comment pero el post no se reflejó
//
// IMPORTANT: IG cambia su DOM mucho. Si en producción falla con 'not-found'
// pero la URL es válida y la identity está logueada, lo más probable es que
// los selectores SELECTORS abajo estén obsoletos. Actualizarlos requiere un
// smoke manual con OZ + DevTools en el post real.
//
// Doc: docs/modules/bulk-actions-ig-comment.md (TBD)

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  waitForSelector,
  executeJS,
} = require('./bulk-action-browser-helpers')

// Selector fallbacks — el primero que matchee gana. IG rota aria-labels
// entre EN/ES y también cambia textareas vs contenteditable divs.
const SELECTORS = {
  // Textarea o contenteditable para escribir comentario.
  commentInput: [
    'textarea[aria-label="Add a comment…"]',
    'textarea[aria-label="Agregar un comentario..."]',
    'textarea[aria-label="Añade un comentario..."]',
    'textarea[placeholder*="comment" i]',
    'textarea[placeholder*="coment" i]',
    'form[method="POST"] textarea',
  ],
  // Botón Post / Publicar / Comentar.
  postButton: [
    'div[role="button"][tabindex="0"]:has(div:contains("Post"))', // unreliable
    'button[type="submit"]',
    'form[method="POST"] button[type="submit"]',
  ],
  // Indicador de needs_login.
  loginIndicator: [
    'a[href="/accounts/login/"]',
    'a[href*="/accounts/login"]',
    'button:contains("Log in")',
    'button:contains("Iniciar sesión")',
  ],
  // Indicador de captcha.
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]',
  ],
}

function buildIgCommentAction({ identityManager, electron }) {
  return {
    id: 'ig_comment',
    label: 'Instagram: Comment on a post',
    description:
      'Post a comment on an Instagram post URL using each identity\'s session. Requires the identity is already logged in to IG (no auto-login in this version). Returns {postUrl, comment, identityName, durationMs} or throws with error.code: needs_login | captcha | not-found | submit-failed. NOTE: IG changes its DOM frequently — if this fails with "not-found" but the URL is valid, the selectors likely need updating.',
    paramsSchema: {
      type: 'object',
      properties: {
        postUrl: {
          type: 'string',
          minLength: 1,
          description:
            'Full URL of the Instagram post (e.g. https://www.instagram.com/p/ABC123/)',
        },
        comment: {
          type: 'string',
          minLength: 1,
          maxLength: 2200,
          description: 'Text of the comment (IG limit ~2200 chars)',
        },
        timeoutMs: {
          type: 'number',
          minimum: 5000,
          maximum: 300_000,
        },
      },
      required: ['postUrl', 'comment'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { postUrl, comment, timeoutMs = 60_000 } = params || {}
      if (!postUrl) throw new Error('postUrl required')
      if (!comment) throw new Error('comment required')
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        // 1. Navigate.
        await navigate(win, postUrl, { timeoutMs: Math.min(30_000, timeoutMs), signal })

        // 2. Quick check: needs_login OR captcha (~2s window).
        const earlyCheck = await _checkEarlySignals(win)
        if (earlyCheck === 'needs_login') {
          const err = new Error('identity not logged in to Instagram')
          err.code = 'needs_login'
          throw err
        }
        if (earlyCheck === 'captcha') {
          const err = new Error('Instagram showed a captcha challenge')
          err.code = 'captcha'
          throw err
        }

        // 3. Wait for comment textarea (try fallback selectors).
        const remaining = Math.max(5000, timeoutMs - (Date.now() - t0))
        const matchedSel = await _waitForAnySelector(win, SELECTORS.commentInput, {
          timeoutMs: remaining,
          signal,
        })
        if (!matchedSel) {
          const err = new Error(
            'comment textarea not found — selectors may be outdated (IG DOM changed)',
          )
          err.code = 'not-found'
          throw err
        }

        // 4. Focus + type the comment via native value setter so React picks it up.
        const typeResult = await executeJS(
          win,
          `
            (() => {
              const el = document.querySelector(${JSON.stringify(matchedSel)})
              if (!el) return { ok: false, reason: 'gone' }
              el.focus()
              const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')
              if (setter && setter.set) {
                setter.set.call(el, ${JSON.stringify(comment)})
              } else {
                el.value = ${JSON.stringify(comment)}
              }
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              return { ok: true }
            })()
          `,
        )
        if (!typeResult || !typeResult.ok) {
          const err = new Error(
            `failed to type into textarea: ${(typeResult && typeResult.reason) || 'unknown'}`,
          )
          err.code = 'submit-failed'
          throw err
        }

        // 5. Click the Post button. IG has multiple variants. We use a JS
        //    walker that finds any element whose text matches Post/Publicar/
        //    Comentar inside the same form/section as the textarea.
        const clickResult = await executeJS(
          win,
          `
            (() => {
              const ta = document.querySelector(${JSON.stringify(matchedSel)})
              if (!ta) return { ok: false, reason: 'textarea-gone' }
              // Walk up to find the enclosing form/section.
              const root = ta.closest('form') || ta.closest('section') ||
                           ta.closest('[role="dialog"]') || document.body
              const candidates = Array.from(
                root.querySelectorAll('button, div[role="button"], [type="submit"]'),
              )
              const label = (el) =>
                (el.innerText || el.textContent || '').trim().toLowerCase()
              const target = candidates.find((el) => {
                const t = label(el)
                if (!t) return false
                return (
                  t === 'post' || t === 'publicar' || t === 'comentar' ||
                  t === 'share' || t === 'compartir' || t === 'enviar' ||
                  t.startsWith('post') || t.startsWith('publicar')
                )
              })
              if (!target) return { ok: false, reason: 'post-btn-not-found' }
              if (target.getAttribute && target.getAttribute('aria-disabled') === 'true') {
                return { ok: false, reason: 'post-btn-disabled' }
              }
              target.click()
              return { ok: true, label: label(target) }
            })()
          `,
        )
        if (!clickResult || !clickResult.ok) {
          const err = new Error(
            `failed to click Post button: ${(clickResult && clickResult.reason) || 'unknown'}`,
          )
          err.code = 'submit-failed'
          throw err
        }

        // 6. Wait for confirmation: textarea cleared OR captcha appeared.
        //    Poll every 300ms up to 15s.
        const confirmed = await _waitForCommentSubmit(win, matchedSel, {
          timeoutMs: 15_000,
          signal,
        })
        if (!confirmed) {
          // Re-check captcha — IG sometimes shows it after click.
          const post = await _checkEarlySignals(win)
          if (post === 'captcha') {
            const err = new Error('Instagram showed captcha after submit')
            err.code = 'captcha'
            throw err
          }
          const err = new Error(
            'comment was typed and submitted but no confirmation observed',
          )
          err.code = 'submit-failed'
          throw err
        }

        return {
          postUrl,
          comment,
          identityId: identity.id,
          identityName: identity.name,
          clickedLabel: clickResult.label || null,
          durationMs: Date.now() - t0,
        }
      } finally {
        await safeClose(win)
      }
    },
  }
}

// ---------- internals --------------------------------------------------------

/**
 * Check the page for early signals: needs_login or captcha. Returns one of:
 *   - 'needs_login'
 *   - 'captcha'
 *   - 'ok' (none detected)
 */
async function _checkEarlySignals(win) {
  const result = await executeJS(
    win,
    `
      (() => {
        const loginSel = ${JSON.stringify(SELECTORS.loginIndicator)}
        const captchaSel = ${JSON.stringify(SELECTORS.captchaIndicator)}
        for (const s of captchaSel) {
          try { if (document.querySelector(s)) return 'captcha' } catch(_e) {}
        }
        for (const s of loginSel) {
          try {
            // :contains is non-standard — only the attribute-form selectors
            // actually work via querySelector. The button:contains() fallback
            // is matched manually below.
            if (s.includes(':contains')) {
              const txt = s.match(/contains\\("([^"]+)"\\)/)
              if (!txt) continue
              const needle = txt[1].toLowerCase()
              const btns = Array.from(document.querySelectorAll('button, a'))
              if (btns.some((b) => (b.innerText || '').trim().toLowerCase() === needle)) {
                return 'needs_login'
              }
              continue
            }
            if (document.querySelector(s)) return 'needs_login'
          } catch(_e) {}
        }
        return 'ok'
      })()
    `,
  )
  return result || 'ok'
}

/**
 * Try multiple selectors in order; return the first one that matches, or null.
 */
async function _waitForAnySelector(win, selectors, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10_000
  const pollMs = opts.pollMs || 300
  const signal = opts.signal
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    for (const sel of selectors) {
      try {
        const exists = await executeJS(
          win,
          `(()=>!!document.querySelector(${JSON.stringify(sel)}))()`,
        )
        if (exists) return sel
      } catch (_err) {
        // Some selectors (e.g. those with :contains) throw on querySelector;
        // skip them.
      }
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, pollMs)
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true },
        )
      }
    })
  }
  return null
}

/**
 * Wait until comment submit is observable — textarea cleared after our click.
 */
async function _waitForCommentSubmit(win, textareaSelector, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15_000
  const pollMs = opts.pollMs || 300
  const signal = opts.signal
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return false
    const cleared = await executeJS(
      win,
      `
        (() => {
          const el = document.querySelector(${JSON.stringify(textareaSelector)})
          if (!el) return true // textarea removed counts as confirmation
          return !el.value || el.value.length === 0
        })()
      `,
    )
    if (cleared) return true
    await new Promise((resolve) => {
      const t = setTimeout(resolve, pollMs)
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true },
        )
      }
    })
  }
  return false
}

// Use waitForSelector to satisfy unused-import lint warnings when fallback
// selectors are the primary path.
void waitForSelector

module.exports = { buildIgCommentAction }
