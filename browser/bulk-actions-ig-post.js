// OZ Browser — Bulk Action: ig_post (v2 sub-bloque 3c).
//
// Postea una imagen con caption en Instagram desde una identity.
// Asume la identity tiene sesión IG activa (login manual previo —
// auto-login con vault llega en sub-bloque siguiente).
//
// Flow:
//   1. spawnIdentityWindow para la identity
//   2. navigate a https://www.instagram.com
//   3. Detect needs_login/captcha
//   4. Click el botón "+" / "Create" (multi-selector + DOM walker fallback)
//   5. waitForSelector del input[type=file] que IG inyecta en el flow
//   6. setFile() del imagePath usando webContents.debugger (CDP) — única forma
//      de inyectar archivos sin el filePicker nativo
//   7. Esperar el "Next" button (que aparece tras procesar la imagen)
//   8. Click Next dos veces (Crop → Edit/Filter → Caption screen)
//   9. Pegar caption en el textarea
//   10. Click "Share"
//   11. Esperar confirmación: "Your post has been shared" / "Tu publicación
//       se compartió" / desaparición del modal
//   12. safeClose la window
//
// Params:
//   {
//     imagePath: string (required, absolute path en el filesystem),
//     caption: string (optional, empty = no caption, max 2200),
//     timeoutMs?: number (default 120000 — IG image processing es lento)
//   }
//
// Result on success:
//   { imagePath, caption, identityId, identityName, durationMs }
//
// Error codes:
//   - 'needs_login' — identity no logueada
//   - 'captcha' — IG challenge
//   - 'not-found' — Create button, file input, Next, o Share no encontrados
//     (selectors obsoletos = lo más probable)
//   - 'image-missing' — el imagePath no existe en el filesystem
//   - 'submit-failed' — flujo completado pero no se observó confirmación
//
// IMPORTANT: IG cambia su DOM mucho. Si en producción falla con 'not-found',
// los SELECTORS abajo necesitan update. Validar manualmente con DevTools.
//
// Doc: docs/modules/bulk-actions-ig-post.md (TBD)

'use strict'

const fs = require('fs')
const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  executeJS,
} = require('./bulk-action-browser-helpers')

const IG_HOME = 'https://www.instagram.com/'

// Selectors with EN/ES fallbacks. IG rotates aria-labels.
const SELECTORS = {
  createButton: [
    'svg[aria-label="New post"]',
    'svg[aria-label="Nueva publicación"]',
    'svg[aria-label="Nuevo"]',
    'a[href="/create/select/"]',
    'a[href*="/create/"]',
  ],
  fileInput: ['input[type="file"][accept*="image"]', 'input[type="file"]'],
  nextButton: [
    // IG uses div role=button most places.
    'div[role="button"]:has-text("Next")',
    'div[role="button"]:has-text("Siguiente")',
    'button:has-text("Next")',
    'button:has-text("Siguiente")',
  ],
  captionTextarea: [
    'textarea[aria-label="Write a caption..."]',
    'textarea[aria-label="Escribe un pie de foto..."]',
    'textarea[aria-label="Escribe un pie de foto…"]',
    'div[contenteditable="true"][aria-label*="caption" i]',
    'div[contenteditable="true"][aria-label*="pie de foto" i]',
    'div[role="dialog"] textarea',
  ],
  shareButton: [
    'div[role="button"]:has-text("Share")',
    'div[role="button"]:has-text("Compartir")',
    'button:has-text("Share")',
    'button:has-text("Compartir")',
  ],
  successIndicator: [
    'img[alt*="shared" i]',
    'h2:has-text("Your post has been shared")',
    'h2:has-text("Tu publicación se compartió")',
    'div:has-text("Your post has been shared")',
    'div:has-text("Tu publicación se compartió")',
  ],
  loginIndicator: ['a[href="/accounts/login/"]', 'a[href*="/accounts/login"]'],
  captchaIndicator: [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]',
  ],
}

function buildIgPostAction({ identityManager, electron }) {
  return {
    id: 'ig_post',
    label: 'Instagram: Post image with caption',
    platform: 'instagram.com',
    description:
      "Post an image (with optional caption) to Instagram using each identity's session. Requires identity is logged in. imagePath must be an absolute path to a local image file (jpg, png, webp). Returns {imagePath, caption, identityName, durationMs} or throws with error.code: needs_login | captcha | not-found | image-missing | submit-failed. IG image processing is slow — default timeout 120s. NOTE: IG DOM changes frequently — selectors may need updates.",
    paramsSchema: {
      type: 'object',
      properties: {
        imagePath: {
          type: 'string',
          minLength: 1,
          description:
            'Absolute path to local image file. e.g. /Users/jose/Pictures/post.jpg',
        },
        caption: {
          type: 'string',
          maxLength: 2200,
          description: 'Caption text (optional, IG limit ~2200 chars)',
        },
        timeoutMs: {
          type: 'number',
          minimum: 10_000,
          maximum: 600_000,
        },
      },
      required: ['imagePath'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const { imagePath, caption = '', timeoutMs = 120_000 } = params || {}
      if (!imagePath) throw new Error('imagePath required')
      if (!fs.existsSync(imagePath)) {
        const err = new Error(`image not found: ${imagePath}`)
        err.code = 'image-missing'
        throw err
      }
      const t0 = Date.now()
      const signal = ctx && ctx.signal
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal,
        electron,
      })
      try {
        // 1. Navigate to IG home.
        await navigate(win, IG_HOME, {
          timeoutMs: Math.min(30_000, timeoutMs),
          signal,
        })

        // 2. Early signals.
        const early = await _checkEarlySignals(win)
        if (early === 'needs_login') {
          const err = new Error('identity not logged in to Instagram')
          err.code = 'needs_login'
          throw err
        }
        if (early === 'captcha') {
          const err = new Error('Instagram showed a captcha')
          err.code = 'captcha'
          throw err
        }

        // 3. Click the Create button.
        const createClicked = await _findAndClickByText(win, [
          'New post',
          'Nueva publicación',
          'Nuevo',
          'Create',
          'Crear',
        ])
        if (!createClicked) {
          const err = new Error('Create button not found — selectors may be outdated')
          err.code = 'not-found'
          throw err
        }

        // 4. Wait for file input (IG injects it after Create click).
        const fileInputSel = await _waitForAnySelector(win, SELECTORS.fileInput, {
          timeoutMs: 10_000,
          signal,
        })
        if (!fileInputSel) {
          const err = new Error('file input not found after Create — selectors outdated')
          err.code = 'not-found'
          throw err
        }

        // 5. Inject the file. The standard way in Electron is via the
        //    DebuggerProtocol's DOM.setFileInputFiles. We attach the
        //    debugger, find the backend node id of the input, and set
        //    files. Detach when done.
        const fileInjected = await _injectFile(win, fileInputSel, imagePath)
        if (!fileInjected) {
          const err = new Error('failed to inject image into IG file input')
          err.code = 'submit-failed'
          throw err
        }

        // 6. Wait for processing — Next button appears once image is ready.
        await _sleep(2000, signal) // give IG a moment to process

        // 7. Click Next twice (Crop screen → Filter/Edit screen → Caption).
        const next1 = await _findAndClickByText(win, ['Next', 'Siguiente'], {
          maxWaitMs: 20_000,
          signal,
        })
        if (!next1) {
          const err = new Error('Next button (after Crop) not found')
          err.code = 'not-found'
          throw err
        }
        await _sleep(1500, signal)

        const next2 = await _findAndClickByText(win, ['Next', 'Siguiente'], {
          maxWaitMs: 15_000,
          signal,
        })
        if (!next2) {
          const err = new Error('Next button (after Filter) not found')
          err.code = 'not-found'
          throw err
        }
        await _sleep(1500, signal)

        // 8. Fill caption if provided.
        if (caption) {
          const captionSel = await _waitForAnySelector(win, SELECTORS.captionTextarea, {
            timeoutMs: 10_000,
            signal,
          })
          if (!captionSel) {
            const err = new Error('caption textarea not found')
            err.code = 'not-found'
            throw err
          }
          const typed = await _typeIntoField(win, captionSel, caption)
          if (!typed) {
            const err = new Error('failed to type caption')
            err.code = 'submit-failed'
            throw err
          }
        }

        // 9. Click Share.
        const shareClicked = await _findAndClickByText(win, ['Share', 'Compartir'], {
          maxWaitMs: 10_000,
          signal,
        })
        if (!shareClicked) {
          const err = new Error('Share button not found')
          err.code = 'not-found'
          throw err
        }

        // 10. Wait for confirmation. IG shows a "Your post has been shared"
        //     screen, or the modal closes. Derive timeout from remaining budget
        //     so tests with short timeoutMs don't hang on the wall clock.
        const confirmRemaining = Math.max(
          2000,
          Math.min(30_000, timeoutMs - (Date.now() - t0)),
        )
        const confirmed = await _waitForConfirmation(win, {
          timeoutMs: confirmRemaining,
          signal,
        })
        if (!confirmed) {
          // Re-check captcha.
          const post = await _checkEarlySignals(win)
          if (post === 'captcha') {
            const err = new Error('Instagram showed captcha after share')
            err.code = 'captcha'
            throw err
          }
          const err = new Error('share clicked but no confirmation observed')
          err.code = 'submit-failed'
          throw err
        }

        return {
          imagePath,
          caption,
          identityId: identity.id,
          identityName: identity.name,
          durationMs: Date.now() - t0,
        }
      } finally {
        await safeClose(win)
      }
    },
  }
}

// ---------- internals --------------------------------------------------------

async function _checkEarlySignals(win) {
  return executeJS(
    win,
    `
      (() => {
        const captcha = ${JSON.stringify(SELECTORS.captchaIndicator)}
        const login = ${JSON.stringify(SELECTORS.loginIndicator)}
        for (const s of captcha) {
          try { if (document.querySelector(s)) return 'captcha' } catch(_e) {}
        }
        for (const s of login) {
          try { if (document.querySelector(s)) return 'needs_login' } catch(_e) {}
        }
        return 'ok'
      })()
    `,
  )
}

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
      // Skip selectors with :has-text (non-standard, handled separately).
      if (sel.includes(':has-text(') || sel.includes(':contains(')) continue
      try {
        const exists = await executeJS(
          win,
          `(()=>!!document.querySelector(${JSON.stringify(sel)}))()`,
        )
        if (exists) return sel
      } catch (_err) {
        // skip bad selector
      }
    }
    await _sleep(pollMs, signal)
  }
  return null
}

/**
 * Find a clickable element by text (case-insensitive, multiple labels),
 * and click it. Polls until found or timeout.
 */
async function _findAndClickByText(win, labels, opts = {}) {
  const maxWaitMs = opts.maxWaitMs || 5000
  const pollMs = opts.pollMs || 300
  const signal = opts.signal
  const labelsJSON = JSON.stringify(labels.map((l) => l.toLowerCase()))
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const result = await executeJS(
      win,
      `
        (() => {
          const labels = ${labelsJSON}
          const candidates = Array.from(
            document.querySelectorAll(
              'button, div[role="button"], a, span[role="button"]',
            ),
          )
          const norm = (s) => (s || '').trim().toLowerCase()
          for (const el of candidates) {
            const t = norm(el.innerText || el.textContent || '')
            if (!t || t.length > 30) continue // ignore long text blocks
            if (
              labels.includes(t) ||
              labels.some((l) => t === l || t.startsWith(l))
            ) {
              if (
                el.getAttribute &&
                el.getAttribute('aria-disabled') === 'true'
              ) continue
              el.click()
              return { ok: true, label: t }
            }
          }
          return { ok: false }
        })()
      `,
    )
    if (result && result.ok) return result
    await _sleep(pollMs, signal)
  }
  return null
}

async function _typeIntoField(win, selector, text) {
  const result = await executeJS(
    win,
    `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { ok: false, reason: 'gone' }
        el.focus()
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')
          if (setter && setter.set) {
            setter.set.call(el, ${JSON.stringify(text)})
          } else {
            el.value = ${JSON.stringify(text)}
          }
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          // contenteditable
          el.textContent = ${JSON.stringify(text)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        return { ok: true }
      })()
    `,
  )
  return result && result.ok
}

/**
 * Inject a file path into an input[type=file] via CDP DOM.setFileInputFiles.
 * This is the only way Electron lets you bypass the native file picker.
 */
async function _injectFile(win, fileInputSelector, filePath) {
  const wc = win.webContents
  if (!wc || typeof wc.debugger !== 'object') return false
  try {
    try {
      wc.debugger.attach('1.3')
    } catch (_e) {
      // already attached, ok
    }
    // Get the backend node id of the input via DOM.querySelector.
    const docResult = await wc.debugger.sendCommand('DOM.getDocument')
    const queryResult = await wc.debugger.sendCommand('DOM.querySelector', {
      nodeId: docResult.root.nodeId,
      selector: fileInputSelector,
    })
    if (!queryResult || !queryResult.nodeId) return false
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId: queryResult.nodeId,
      files: [filePath],
    })
    return true
  } catch (err) {
    return false
  } finally {
    try {
      wc.debugger.detach()
    } catch (_e) {
      // noop
    }
  }
}

async function _waitForConfirmation(win, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30_000
  const pollMs = opts.pollMs || 500
  const signal = opts.signal
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return false
    const found = await executeJS(
      win,
      `
        (() => {
          const norm = (s) => (s || '').trim().toLowerCase()
          // Look for shared confirmation text.
          const all = Array.from(document.querySelectorAll('h1, h2, h3, div, span'))
          for (const el of all) {
            const t = norm(el.innerText || el.textContent || '')
            if (!t || t.length > 80) continue
            if (
              t.includes('post has been shared') ||
              t.includes('publicación se compartió') ||
              t.includes('publicacion se compartio')
            ) {
              return true
            }
          }
          // Heuristic: if the IG create dialog is gone AND we're back at feed.
          const dialog = document.querySelector('div[role="dialog"]')
          const inFeed = !!document.querySelector('main[role="main"]')
          if (!dialog && inFeed) return 'dialog-gone'
          return false
        })()
      `,
    )
    if (found) return true
    await _sleep(pollMs, signal)
  }
  return false
}

function _sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
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

module.exports = { buildIgPostAction }
