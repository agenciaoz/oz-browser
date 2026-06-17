// OZ Browser — app-dock-utils helpers smoke test (alpha.44).
//
// Run:
//   cd oz-browser
//   node tests/app-dock-utils.smoketest.js
//
// Covers the pure App Dock helpers (no DOM / Electron):
//   - normalizeUrl / abbrevFromLabel / buildCustomLink
//   - mergeDock (defaults + custom, order, hidden, stable)
//   - reorderDock (before/after, self/unknown)

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/ui/app-dock-utils.js')]
const U = require(path.join('..', 'browser', 'ui', 'app-dock-utils.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('app-dock-utils smoke test')

ok('normalizeUrl adds https:// when scheme missing', () => {
  assert.strictEqual(U.normalizeUrl('gmail.com'), 'https://gmail.com')
  assert.strictEqual(U.normalizeUrl('http://x.com'), 'http://x.com')
  assert.strictEqual(U.normalizeUrl('  https://a.b '), 'https://a.b')
  assert.strictEqual(U.normalizeUrl(''), '')
})

ok('abbrevFromLabel derives 1-2 chars', () => {
  assert.strictEqual(U.abbrevFromLabel('Gmail'), 'GM')
  assert.strictEqual(U.abbrevFromLabel('Google Drive'), 'GD')
  assert.strictEqual(U.abbrevFromLabel(''), '•')
})

ok('buildCustomLink builds entry or null on bad url', () => {
  const l = U.buildCustomLink('Gmail', 'gmail.com')
  assert.strictEqual(l.url, 'https://gmail.com')
  assert.strictEqual(l.label, 'Gmail')
  assert.strictEqual(l.abbrev, 'GM')
  assert.strictEqual(l.custom, true)
  assert.ok(l.key && l.key.startsWith('dock-'))
  assert.strictEqual(U.buildCustomLink('x', ''), null)
})

ok('mergeDock combines defaults + custom, hides, orders', () => {
  const defaults = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  const custom = [{ key: 'z', custom: true }]
  // no order, no hidden → defaults then custom, stable
  assert.deepStrictEqual(
    U.mergeDock(defaults, custom, [], []).map((e) => e.key),
    ['a', 'b', 'c', 'z'],
  )
  // hidden removes b
  assert.deepStrictEqual(
    U.mergeDock(defaults, custom, [], ['b']).map((e) => e.key),
    ['a', 'c', 'z'],
  )
  // order wins; unknown-to-order keys appended stably
  assert.deepStrictEqual(
    U.mergeDock(defaults, custom, ['z', 'c'], []).map((e) => e.key),
    ['z', 'c', 'a', 'b'],
  )
})

ok('reorderDock moves before/after, no-ops on self', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepStrictEqual(U.reorderDock(order, 'd', 'b', false), ['a', 'd', 'b', 'c'])
  assert.deepStrictEqual(U.reorderDock(order, 'a', 'c', true), ['b', 'c', 'a', 'd'])
  assert.deepStrictEqual(U.reorderDock(order, 'b', 'b', false), order)
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd']) // not mutated
})

console.log(`\napp-dock-utils: ${passed} checks passed ✓`)
