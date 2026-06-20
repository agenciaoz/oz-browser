// OZ Browser — scrape-ratelimit-domain smoke test (V3-D).
//
// Run:
//   cd oz-browser
//   node tests/scrape-ratelimit-domain.smoketest.js
//
// Covers the pure domain parser + the per-domain next-available limiter using
// a fake clock (no real time passes).

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/scrape-ratelimit-domain.js')]
const M = require(path.join('..', 'browser', 'scrape-ratelimit-domain.js'))
const { DomainRateLimiter, domainOf } = M

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// Mutable fake clock.
function fakeClock(startMs) {
  let t = startMs || 0
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    set: (ms) => {
      t = ms
    },
  }
}

console.log('scrape-ratelimit-domain smoke test')

// ---- domainOf ---------------------------------------------------------------

ok('domainOf: normalizes host, strips www, lowercases', () => {
  assert.strictEqual(domainOf('https://www.Instagram.com/p/abc'), 'instagram.com')
  assert.strictEqual(domainOf('http://EXAMPLE.org:8080/x?y=1'), 'example.org')
  assert.strictEqual(domainOf('https://sub.example.com/'), 'sub.example.com')
})

ok('domainOf: junk / no-host → null', () => {
  for (const bad of ['', '   ', 'not a url', 'about:blank', null, undefined, 42]) {
    assert.strictEqual(domainOf(bad), null, 'null for ' + String(bad))
  }
})

// ---- DomainRateLimiter: spacing --------------------------------------------

ok('reserve: first call waits 0, subsequent calls space by interval', () => {
  const clock = fakeClock(1000)
  const rl = new DomainRateLimiter({ minIntervalMs: 500, clock })
  const a = rl.reserve('https://x.com/a')
  const b = rl.reserve('https://x.com/b')
  const c = rl.reserve('https://www.x.com/c')
  assert.strictEqual(a.waitMs, 0)
  assert.strictEqual(b.waitMs, 500)
  assert.strictEqual(c.waitMs, 1000) // same domain (www stripped) → keeps stacking
  assert.strictEqual(a.domain, 'x.com')
})

ok('reserve: different domains do not block each other', () => {
  const clock = fakeClock(0)
  const rl = new DomainRateLimiter({ minIntervalMs: 1000, clock })
  const a = rl.reserve('https://a.com/')
  const b = rl.reserve('https://b.com/')
  assert.strictEqual(a.waitMs, 0)
  assert.strictEqual(b.waitMs, 0)
})

ok('reserve: time passing frees the slot', () => {
  const clock = fakeClock(0)
  const rl = new DomainRateLimiter({ minIntervalMs: 1000, clock })
  assert.strictEqual(rl.reserve('https://a.com/1').waitMs, 0) // next avail = 1000
  clock.advance(1500) // now 1500 > 1000 → slot is free
  assert.strictEqual(rl.reserve('https://a.com/2').waitMs, 0)
})

ok('reserve: partial wait when slot is in the near future', () => {
  const clock = fakeClock(0)
  const rl = new DomainRateLimiter({ minIntervalMs: 1000, clock })
  rl.reserve('https://a.com/1') // next avail = 1000
  clock.advance(300) // now 300
  const r = rl.reserve('https://a.com/2') // start=1000 → wait 700
  assert.strictEqual(r.waitMs, 700)
})

ok('reserve: no-domain url → wait 0 and untracked', () => {
  const clock = fakeClock(0)
  const rl = new DomainRateLimiter({ minIntervalMs: 1000, clock })
  const r = rl.reserve('about:blank')
  assert.strictEqual(r.domain, null)
  assert.strictEqual(r.waitMs, 0)
  assert.deepStrictEqual(rl.stats(), {})
})

// ---- per-domain overrides ---------------------------------------------------

ok('perDomain override beats the global interval', () => {
  const clock = fakeClock(0)
  const rl = new DomainRateLimiter({
    minIntervalMs: 100,
    perDomain: { 'instagram.com': 5000, 'www.x.com': 2000 },
    clock,
  })
  assert.strictEqual(rl.intervalFor('instagram.com'), 5000)
  assert.strictEqual(rl.intervalFor('x.com'), 2000) // key normalized on construct
  assert.strictEqual(rl.intervalFor('other.com'), 100)
  rl.reserve('https://instagram.com/1')
  assert.strictEqual(rl.reserve('https://instagram.com/2').waitMs, 5000)
})

// ---- peek / reset -----------------------------------------------------------

ok('peek does not mutate; reset clears', () => {
  const clock = fakeClock(0)
  const rl = new DomainRateLimiter({ minIntervalMs: 1000, clock })
  rl.reserve('https://a.com/1') // next avail = 1000
  assert.strictEqual(rl.peek('https://a.com/x'), 1000)
  assert.strictEqual(rl.peek('https://a.com/x'), 1000) // unchanged
  rl.reset('a.com')
  assert.strictEqual(rl.peek('https://a.com/x'), 0)
  rl.reserve('https://b.com/1')
  rl.reset()
  assert.deepStrictEqual(rl.stats(), {})
})

ok('constructor tolerates junk opts', () => {
  const rl = new DomainRateLimiter({ minIntervalMs: 'x', perDomain: { '': 5, ok: -3 } })
  assert.strictEqual(rl.intervalFor('anything'), M.DEFAULT_MIN_INTERVAL_MS)
})

console.log(`\n✓ scrape-ratelimit-domain: ${passed} checks passed`)
