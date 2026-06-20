// OZ Browser — geo-match helpers smoke test (V3-C).
//
// Run:
//   cd oz-browser
//   node tests/geo-match.smoketest.js
//
// Covers the pure Accept-Language formatting + auto-apply guard (no Electron).

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/geo-match.js')]
const GM = require(path.join('..', 'browser', 'geo-match.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('geo-match smoke test')

ok('formatAcceptLanguage: two langs → single q=0.9', () => {
  assert.strictEqual(GM.formatAcceptLanguage(['en-US', 'en']), 'en-US,en;q=0.9')
})

ok('formatAcceptLanguage: three langs → decreasing q', () => {
  assert.strictEqual(
    GM.formatAcceptLanguage(['es-AR', 'es', 'en']),
    'es-AR,es;q=0.9,en;q=0.8',
  )
})

ok('formatAcceptLanguage: pt-BR profile', () => {
  assert.strictEqual(
    GM.formatAcceptLanguage(['pt-BR', 'pt', 'en']),
    'pt-BR,pt;q=0.9,en;q=0.8',
  )
})

ok('formatAcceptLanguage: single lang → no qualifier', () => {
  assert.strictEqual(GM.formatAcceptLanguage(['ja-JP']), 'ja-JP')
})

ok('formatAcceptLanguage: q floors at 0.1 for long lists', () => {
  // 12 languages: indices 1..11 give q 0.9..-0.1 → clamp at 0.1 for the tail.
  const langs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
  const out = GM.formatAcceptLanguage(langs)
  assert.ok(!/q=0\.0/.test(out), 'no q=0.0')
  assert.ok(!/q=-/.test(out), 'no negative q')
  assert.ok(/l;q=0\.1$/.test(out), 'tail clamps at 0.1: ' + out)
})

ok('formatAcceptLanguage: dedupes + trims + drops junk', () => {
  assert.strictEqual(
    GM.formatAcceptLanguage([' en-US ', 'en-US', 'en', null, 5, '']),
    'en-US,en;q=0.9',
  )
})

ok('formatAcceptLanguage: empty/invalid → empty string', () => {
  assert.strictEqual(GM.formatAcceptLanguage([]), '')
  assert.strictEqual(GM.formatAcceptLanguage(null), '')
  assert.strictEqual(GM.formatAcceptLanguage('en-US'), '')
})

ok('shouldAutoApplyGeo: no profile → true', () => {
  assert.strictEqual(GM.shouldAutoApplyGeo(null), true)
})

ok('shouldAutoApplyGeo: fresh/auto profile → true', () => {
  assert.strictEqual(GM.shouldAutoApplyGeo({}), true)
  assert.strictEqual(GM.shouldAutoApplyGeo({ geoSource: 'auto' }), true)
})

ok('shouldAutoApplyGeo: manual override → false', () => {
  assert.strictEqual(GM.shouldAutoApplyGeo({ geoSource: 'manual' }), false)
})

ok('shouldAutoApplyGeo: force bypasses manual guard', () => {
  assert.strictEqual(
    GM.shouldAutoApplyGeo({ geoSource: 'manual' }, { force: true }),
    true,
  )
})

console.log(`\n✓ geo-match: ${passed} checks passed`)
