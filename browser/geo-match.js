// OZ Browser — Geo auto-match helpers (V3-C closure).
//
// Qué hace: matemática/lógica PURA (sin Electron/DOM) para que el timezone +
// Accept-Language de una identity coincidan con la geo de su proxy. Dos piezas:
//
//   (1) formatAcceptLanguage(languages) — construye el header Accept-Language
//       estilo Chrome real, con q-weighting decreciente, a partir del array
//       `languages` del fingerprint. Real Chrome NUNCA manda un solo idioma:
//       para navigator.languages = ['es-AR','es','en'] manda
//       `Accept-Language: es-AR,es;q=0.9,en;q=0.8`. Mandar solo 'es-AR' (lo que
//       hacíamos) es un mismatch clásico que los anti-bot detectan (el header
//       HTTP no coincide con navigator.languages del JS).
//
//   (2) shouldAutoApplyGeo(profile, opts) — decide si el auto-match dispara al
//       asignar un proxy. Respeta un override MANUAL del usuario (geoSource
//       'manual' nunca se pisa); un geo aplicado por auto-match anterior sí se
//       refresca al reasignar a otra geo.
//
// Por qué módulo aparte: 100% testeable sin Electron, reusable desde el hook de
// fingerprint (network layer) y desde proxy-handlers (al asignar).
//
// Doc/ADR: extiende docs/architecture/0018-fingerprint-engine.md (geo coherence).

'use strict'

/**
 * Build a Chrome-realistic Accept-Language header from a languages array.
 *
 * Chrome behavior: the first language carries implicit q=1.0 (no qualifier),
 * each subsequent language gets q decremented by 0.1 (0.9, 0.8, ...), clamped
 * to a 0.1 floor so a long list never reaches q=0.
 *
 *   ['en-US','en']            -> 'en-US,en;q=0.9'
 *   ['es-AR','es','en']       -> 'es-AR,es;q=0.9,en;q=0.8'
 *   ['pt-BR','pt','en']       -> 'pt-BR,pt;q=0.9,en;q=0.8'
 *
 * Returns '' for empty/invalid input so the caller can fall back to a default.
 *
 * @param {string[]} languages
 * @returns {string}
 */
function formatAcceptLanguage(languages) {
  if (!Array.isArray(languages)) return ''
  // Normalize: trim, drop falsy/non-string, dedupe preserving order.
  const seen = new Set()
  const langs = []
  for (const raw of languages) {
    if (typeof raw !== 'string') continue
    const l = raw.trim()
    if (!l || seen.has(l)) continue
    seen.add(l)
    langs.push(l)
  }
  if (langs.length === 0) return ''

  const parts = [langs[0]]
  for (let i = 1; i < langs.length; i++) {
    let q = 1 - i * 0.1
    if (q < 0.1) q = 0.1
    // One-decimal, no trailing zeros beyond that ('0.9', not '0.90').
    const qStr = q.toFixed(1)
    parts.push(`${langs[i]};q=${qStr}`)
  }
  return parts.join(',')
}

/**
 * Should an auto (proxy-driven) geo match be applied to this fingerprint
 * profile? A MANUAL user override always wins and is never clobbered; an
 * auto-applied geo (or no geo yet) is refreshable.
 *
 * @param {object|null} profile fingerprint profile (may have geoSource)
 * @param {{force?: boolean}} [opts] force=true bypasses the manual guard
 * @returns {boolean}
 */
function shouldAutoApplyGeo(profile, opts = {}) {
  if (opts && opts.force) return true
  if (!profile) return true
  if (profile.geoSource === 'manual') return false
  return true
}

module.exports = { formatAcceptLanguage, shouldAutoApplyGeo }
