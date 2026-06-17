// OZ Browser — network-utils helpers smoke test (v3-A).
//
// Run:
//   cd oz-browser
//   node tests/network-utils.smoketest.js
//
// Covers the pure URL pattern matching (no Electron):
//   - globToRegExp, matchesPattern (glob vs substring), matchesAnyPattern
//   - sanitizePatterns

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/network-utils.js')]
const NU = require(path.join('..', 'browser', 'network-utils.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('network-utils smoke test')

ok('globToRegExp anchors + wildcards, escapes regex chars', () => {
  assert.ok(NU.globToRegExp('*.ads.com/*').test('https://x.ads.com/banner'))
  assert.ok(!NU.globToRegExp('*.ads.com/*').test('https://ads.com'))
  // dots are literal, not any-char
  assert.ok(NU.globToRegExp('a.com').test('a.com'))
  assert.ok(!NU.globToRegExp('a.com').test('axcom'))
})

ok('matchesPattern: glob when * present, else substring (case-insensitive)', () => {
  assert.strictEqual(
    NU.matchesPattern('https://A.DoubleClick.net/x', 'doubleclick'),
    true,
  )
  assert.strictEqual(NU.matchesPattern('https://site.com/ads/1', '*/ads/*'), true)
  assert.strictEqual(NU.matchesPattern('https://site.com/news', '*/ads/*'), false)
  assert.strictEqual(NU.matchesPattern('https://site.com', ''), false)
})

ok('matchesAnyPattern over a list', () => {
  const pats = ['analytics', '*.doubleclick.net/*']
  assert.strictEqual(NU.matchesAnyPattern('https://x.doubleclick.net/a', pats), true)
  assert.strictEqual(NU.matchesAnyPattern('https://api.analytics.io/e', pats), true)
  assert.strictEqual(NU.matchesAnyPattern('https://example.com', pats), false)
  assert.strictEqual(NU.matchesAnyPattern('https://example.com', []), false)
})

ok('sanitizePatterns trims, drops empties, non-array → []', () => {
  assert.deepStrictEqual(NU.sanitizePatterns(['  a ', '', 'b', '   ']), ['a', 'b'])
  assert.deepStrictEqual(NU.sanitizePatterns('nope'), [])
  assert.deepStrictEqual(NU.sanitizePatterns(undefined), [])
})

console.log(`\nnetwork-utils: ${passed} checks passed ✓`)
