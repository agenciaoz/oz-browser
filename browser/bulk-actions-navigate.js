// OZ Browser — Bulk Action: navigate (v2 sub-bloque 3a).
//
// Action concreta que valida la infra de browser automation sin necesidad
// de selectors específicos de una plataforma. Casos de uso:
//   - "Abrí esta URL en cada una de mis identities y dame el title + URL
//     final" — útil para A/B testing geo, validación de redirects, etc.
//   - "Tomá screenshot de esta página vista por cada identity" — útil para
//     verificar que un proxy/fingerprint produce la geo correcta.
//
// NO hace clicks ni type. Solo navigate + opcional waitForSelector + opcional
// screenshot. Es el building block para las actions reales (IG, X, etc).
//
// Params schema:
//   {
//     url: string (required) — URL a navegar
//     waitForSelector: string (optional) — CSS selector a esperar post-load
//     timeoutMs: number (optional, default 30000) — total timeout (load + selector)
//     screenshot: boolean (optional, default false) — capturar PNG en result
//   }

'use strict'

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  waitForSelector,
  screenshot,
} = require('./bulk-action-browser-helpers')

function buildNavigateAction({ identityManager, electron }) {
  return {
    id: 'navigate',
    label: 'Navigate (open URL per identity)',
    description:
      'Opens a URL in a hidden browser window for each identity (its own session, proxy, fingerprint). Optionally waits for a CSS selector and/or captures a PNG screenshot. Returns {finalUrl, title, durationMs, screenshot?:base64}. Use this to validate proxy geo, A/B redirects, or do per-identity content scraping previews.',
    paramsSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1 },
        waitForSelector: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1000, maximum: 300_000 },
        screenshot: { type: 'boolean' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(identity, params, ctx) {
      const {
        url,
        waitForSelector: sel,
        timeoutMs = 30_000,
        screenshot: shot,
      } = params || {}
      if (!url) throw new Error('url required')
      const t0 = Date.now()
      const win = await spawnIdentityWindow({
        identityManager,
        identityId: identity.id,
        signal: ctx && ctx.signal,
        electron,
      })
      try {
        const nav = await navigate(win, url, {
          timeoutMs,
          signal: ctx && ctx.signal,
        })
        if (sel) {
          await waitForSelector(win, sel, {
            timeoutMs: Math.max(1000, timeoutMs - (Date.now() - t0)),
            signal: ctx && ctx.signal,
          })
        }
        const out = {
          finalUrl: nav.url,
          title: nav.title,
          durationMs: Date.now() - t0,
        }
        if (shot) {
          out.screenshot = await screenshot(win)
        }
        return out
      } finally {
        await safeClose(win)
      }
    },
  }
}

module.exports = { buildNavigateAction }
