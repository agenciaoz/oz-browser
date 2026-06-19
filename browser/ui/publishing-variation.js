// OZ Browser — Publishing Studio content variation engine (v2 Etapa 4-A).
//
// Pure, DOM-free anti-footprint helpers: each identity gets a DIFFERENT
// caption / hashtag subset / media item so posting the "same" content across
// many accounts doesn't leave an identical fingerprint. Deterministic per
// identity (seeded RNG from identityId) so previews match what would post.
//
// Per-identity EXECUTION (feeding these resolved params to the runner) needs
// engine support for per-identity params — tracked as Etapa 4-B. This module
// powers the preview today and the execution later, unchanged.
//
// Exposes window.OZ.publishingVariation. In Node it is `require()`d.
// Tests: tests/publishing-variation.smoketest.js

;(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    const v = factory()
    const root = typeof window !== 'undefined' ? window : globalThis
    root.OZ = root.OZ || {}
    root.OZ.publishingVariation = v
  }
})(function () {
  'use strict'

  // ── Seeded RNG (mulberry32) — deterministic, dependency-free ──────────
  function makeRng(seed) {
    let a = seed >>> 0
    return function rng() {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let tt = Math.imul(a ^ (a >>> 15), 1 | a)
      tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt
      return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296
    }
  }

  // Stable 32-bit string hash (FNV-1a) → seed an RNG from an identityId.
  function hashSeed(str) {
    let h = 0x811c9dc5
    const s = String(str || '')
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }

  // ── Spintax: {a|b|{c|d}} → one resolved string ────────────────────────
  // Expands innermost groups repeatedly so nesting works. Literal-safe: a
  // string with no braces returns unchanged.
  function expandSpintax(text, rng) {
    const r = typeof rng === 'function' ? rng : Math.random
    let out = String(text == null ? '' : text)
    let guard = 0
    const group = /\{([^{}]*)\}/
    while (group.test(out) && guard < 1000) {
      out = out.replace(group, (_m, inner) => {
        const opts = inner.split('|')
        return opts[Math.floor(r() * opts.length)]
      })
      guard++
    }
    return out
  }

  // Replace {{key}} with vars[key] (missing → empty string).
  function interpolate(text, vars) {
    const v = vars || {}
    return String(text == null ? '' : text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) =>
      v[k] != null ? String(v[k]) : '',
    )
  }

  // Pick n distinct items from arr (Fisher–Yates partial shuffle). n>=len
  // returns a shuffled copy of all. Order is randomized.
  function pickN(arr, n, rng) {
    const r = typeof rng === 'function' ? rng : Math.random
    const a = Array.isArray(arr) ? arr.slice() : []
    const count = Math.max(0, Math.min(n == null ? a.length : n, a.length))
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(r() * (a.length - i))
      const tmp = a[i]
      a[i] = a[j]
      a[j] = tmp
    }
    return a.slice(0, count)
  }

  // Deterministic rotation index into a list.
  function rotate(arr, index) {
    const a = Array.isArray(arr) ? arr : []
    if (!a.length) return null
    const i = ((Math.floor(index) % a.length) + a.length) % a.length
    return a[i]
  }

  // Normalize a hashtag token to "#tag" (strips spaces, leading #).
  function normalizeTag(tag) {
    const s = String(tag || '')
      .trim()
      .replace(/^#+/, '')
    return s ? '#' + s.replace(/\s+/g, '') : ''
  }

  function formatHashtags(tags) {
    return (tags || []).map(normalizeTag).filter(Boolean).join(' ')
  }

  // Resolve the varied content for ONE identity. Deterministic: same identity
  // + same spec → same output. Returns { caption, mediaPath, hashtags }.
  //
  // spec: {
  //   caption: string (spintax allowed),
  //   hashtags: string[] (pool), hashtagCount: number (K of N),
  //   firstCommentHashtags: boolean (if true, tags returned separately not
  //     appended to caption — for IG first-comment best practice),
  //   mediaList: string[] (absolute paths to rotate),
  //   vars: object (global vars merged with per-identity vars)
  // }
  function resolveForIdentity(spec, { index = 0, identity = {}, vars } = {}) {
    const s = spec || {}
    const seed = hashSeed(identity.id || identity.identityId || String(index))
    const rng = makeRng(seed)

    const mergedVars = Object.assign(
      { identity: identity.name || identity.id || '', date: '' },
      s.vars || {},
      vars || {},
    )

    // Interpolate {{vars}} FIRST so spintax doesn't consume the mustache
    // braces (the spintax group regex would otherwise eat `{identity}`).
    let caption = expandSpintax(interpolate(s.caption || '', mergedVars), rng)

    const k = s.hashtagCount == null ? (s.hashtags || []).length : s.hashtagCount
    const chosen = pickN(s.hashtags || [], k, rng)
    const tagStr = formatHashtags(chosen)
    if (tagStr && !s.firstCommentHashtags) {
      caption = caption.trim() + (caption.trim() ? '\n\n' : '') + tagStr
    }

    const mediaPath =
      Array.isArray(s.mediaList) && s.mediaList.length
        ? rotate(s.mediaList, index)
        : s.mediaPath || null

    return {
      caption: caption.trim(),
      hashtags: chosen,
      hashtagsText: tagStr,
      mediaPath,
      firstComment: s.firstCommentHashtags ? tagStr : '',
    }
  }

  // Build a preview row per identity (for the UI). identities: [{id,name}].
  function previewVariations(spec, identities) {
    return (identities || []).map((identity, index) => {
      const resolved = resolveForIdentity(spec, { index, identity })
      return {
        identityId: identity.id || identity.identityId || '',
        name: identity.name || identity.id || '',
        caption: resolved.caption,
        mediaPath: resolved.mediaPath,
        firstComment: resolved.firstComment,
      }
    })
  }

  // Count how many distinct caption variants a spintax string can yield (rough
  // upper bound — product of group sizes). Useful to warn "low variety".
  function spintaxVariety(text) {
    let total = 1
    const re = /\{([^{}]*)\}/g
    let m
    const s = String(text || '')
    while ((m = re.exec(s)) !== null) {
      const opts = m[1].split('|').length
      total *= opts
    }
    return total
  }

  return {
    makeRng,
    hashSeed,
    expandSpintax,
    interpolate,
    pickN,
    rotate,
    normalizeTag,
    formatHashtags,
    resolveForIdentity,
    previewVariations,
    spintaxVariety,
  }
})
