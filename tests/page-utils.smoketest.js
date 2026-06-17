// OZ Browser — page-utils helpers smoke test (v3-A).
//
// Run:
//   cd oz-browser
//   node tests/page-utils.smoketest.js
//
// Covers the pure snippet builders + validators (no DOM / Electron):
//   - clampLimit, isValidSelector
//   - getTextScript / getAttrScript / queryAllScript (injection-safe via JSON)

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/page-utils.js')]
const PU = require(path.join('..', 'browser', 'page-utils.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('page-utils smoke test')

ok('clampLimit bounds + defaults', () => {
  assert.strictEqual(PU.clampLimit(undefined, 50, 500), 50)
  assert.strictEqual(PU.clampLimit(0, 50, 500), 50)
  assert.strictEqual(PU.clampLimit(-3, 50, 500), 50)
  assert.strictEqual(PU.clampLimit(10, 50, 500), 10)
  assert.strictEqual(PU.clampLimit(9999, 50, 500), 500)
  assert.strictEqual(PU.clampLimit('7', 50, 500), 7)
})

ok('isValidSelector', () => {
  assert.strictEqual(PU.isValidSelector('a.link'), true)
  assert.strictEqual(PU.isValidSelector('   '), false)
  assert.strictEqual(PU.isValidSelector(''), false)
  assert.strictEqual(PU.isValidSelector(null), false)
  assert.strictEqual(PU.isValidSelector(42), false)
})

ok('getTextScript embeds selector safely (JSON-encoded)', () => {
  const s = PU.getTextScript('h1.title')
  assert.ok(s.includes('document.querySelector("h1.title")'))
  // a hostile selector is embedded as a JSON string literal, never as code:
  // the encoded form escapes the closing quote so it cannot break out.
  const evil = PU.getTextScript('a"]);doEvil();//')
  assert.ok(evil.includes(JSON.stringify('a"]);doEvil();//')))
  // the raw (unescaped) breakout sequence must NOT appear verbatim
  assert.ok(!evil.includes('a"]);doEvil'))
})

ok('getAttrScript embeds selector + attr', () => {
  const s = PU.getAttrScript('a.btn', 'href')
  assert.ok(s.includes('document.querySelector("a.btn")'))
  assert.ok(s.includes('getAttribute("href")'))
})

ok('queryAllScript caps to limit + returns count/items shape', () => {
  const s = PU.queryAllScript('li', 3)
  assert.ok(s.includes('document.querySelectorAll("li")'))
  assert.ok(s.includes('i<3'))
  assert.ok(s.includes('count:els.length'))
  // default cap when no limit
  assert.ok(PU.queryAllScript('li').includes('i<50'))
  // hostile selector stays a literal
  assert.ok(PU.queryAllScript('x");evil(("').includes(JSON.stringify('x");evil(("')))
})

console.log(`\npage-utils: ${passed} checks passed ✓`)
