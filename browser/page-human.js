// OZ Browser — Humanization helpers (v3-B, scraping/agent-control).
//
// Pure math for human-like input: cubic Bézier mouse paths + gaussian delays.
// No DOM/Electron so it unit-tests deterministically (ADR 0005). Wired behind a
// `human: true` flag in page-handlers click/type (default off → no behaviour
// change). All randomness goes through an injectable `rng` (defaults to
// Math.random) so tests can pass a fixed sequence.
//
// Why this matters: synthetic teleport-clicks and constant keystroke timing are
// exactly what behavioural anti-bots flag. Bézier curves + gaussian cadence
// look like a hand.

'use strict'

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/** Cubic Bézier point at t∈[0,1] for scalar coords. */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/**
 * Build a human-ish mouse path from `start` to `end` as an array of {x,y}.
 * Control points are offset perpendicular to the line by a jittered amount so
 * the path bows naturally. `steps` points returned (last == end).
 */
function bezierPath(start, end, opts, rng) {
  const r = rng || Math.random
  const o = opts || {}
  const steps = Math.max(2, Math.floor(o.steps || 18))
  const dx = end.x - start.x
  const dy = end.y - start.y
  const dist = Math.hypot(dx, dy) || 1
  // perpendicular unit vector
  const px = -dy / dist
  const py = dx / dist
  const bow = (o.jitter == null ? 0.25 : o.jitter) * dist
  const off1 = (r() - 0.5) * 2 * bow
  const off2 = (r() - 0.5) * 2 * bow
  const c1 = { x: start.x + dx * 0.3 + px * off1, y: start.y + dy * 0.3 + py * off1 }
  const c2 = { x: start.x + dx * 0.7 + px * off2, y: start.y + dy * 0.7 + py * off2 }
  const out = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    out.push({
      x: Math.round(bezier(start.x, c1.x, c2.x, end.x, t)),
      y: Math.round(bezier(start.y, c1.y, c2.y, end.y, t)),
    })
  }
  return out
}

/** Gaussian sample (Box–Muller), clamped to [min, max]. */
function gaussian(mean, std, rng, min, max) {
  const r = rng || Math.random
  let u = 0
  let v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  const val = mean + z * std
  const lo = min == null ? 0 : min
  const hi = max == null ? Number.MAX_SAFE_INTEGER : max
  return clamp(Math.round(val), lo, hi)
}

/** Per-character keystroke delays (ms): gaussian around `mean` ± `std`. */
function keystrokeDelays(text, opts, rng) {
  const o = opts || {}
  const mean = o.mean == null ? 110 : o.mean
  const std = o.std == null ? 30 : o.std
  const len = typeof text === 'string' ? text.length : Number(text) || 0
  const out = []
  for (let i = 0; i < len; i++) out.push(gaussian(mean, std, rng, 20, 400))
  return out
}

/** Lognormal sample (heavy right tail — realistic idle gaps), clamped. */
function lognormal(mu, sigma, rng, min, max) {
  const r = rng || Math.random
  let u = 0
  let v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  const val = Math.exp(mu + sigma * z)
  const lo = min == null ? 0 : min
  const hi = max == null ? Number.MAX_SAFE_INTEGER : max
  return clamp(Math.round(val), lo, hi)
}

/**
 * Momentum scroll: split a total pixel distance into decreasing wheel deltas
 * (ease-out, like a flick). Preserves sign; sums ~= totalPx. Returns int deltas.
 */
function momentumSteps(totalPx, opts, rng) {
  const o = opts || {}
  const steps = Math.max(3, Math.floor(o.steps || 8))
  void rng
  const dir = totalPx < 0 ? -1 : 1
  const abs = Math.abs(totalPx) || 0
  let sum = 0
  const weights = []
  for (let i = 0; i < steps; i++) {
    const w = steps - i
    weights.push(w)
    sum += w
  }
  return weights.map((w) => dir * Math.max(1, Math.round((abs * w) / sum)))
}

/**
 * Build a keystroke plan with occasional typos+correction. Each entry is
 * { key } (type a char) or { back: true } (Backspace). A typo inserts a wrong
 * char then a backspace before the right char. Pure via injectable rng.
 */
function typoPlan(text, opts, rng) {
  const r = rng || Math.random
  const o = opts || {}
  const rate = o.rate == null ? 0.06 : o.rate
  const al = 'abcdefghijklmnopqrstuvwxyz'
  const out = []
  for (const ch of String(text || '')) {
    if (/[a-z]/i.test(ch) && r() < rate) {
      out.push({ key: al[Math.floor(r() * al.length)] })
      out.push({ back: true })
    }
    out.push({ key: ch })
  }
  return out
}

module.exports = {
  clamp,
  bezier,
  bezierPath,
  gaussian,
  keystrokeDelays,
  lognormal,
  momentumSteps,
  typoPlan,
}
