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

// --- slice 2: input-events / waitFor / extract builders ---------------------

ok('clickCoordsScript scrolls into view + returns center coords', () => {
  const s = PU.clickCoordsScript('button.go')
  assert.ok(s.includes('document.querySelector("button.go")'))
  assert.ok(s.includes('scrollIntoView'))
  assert.ok(s.includes('getBoundingClientRect'))
  // hostile selector stays a literal
  assert.ok(PU.clickCoordsScript('x");evil((').includes(JSON.stringify('x");evil((')))
})

ok('focusScript + existsScript embed selector', () => {
  assert.ok(PU.focusScript('#in').includes('document.querySelector("#in")'))
  assert.ok(PU.focusScript('#in').includes('.focus()'))
  assert.ok(PU.existsScript('.x').includes('!!document.querySelector(".x")'))
})

ok('scrollScript handles top / bottom / px', () => {
  assert.ok(PU.scrollScript('top').includes('scrollTo(0,0)'))
  assert.ok(PU.scrollScript('bottom').includes('document.body.scrollHeight'))
  assert.ok(PU.scrollScript(400).includes('scrollBy(0,400)'))
  // non-numeric px → 0 (safe)
  assert.ok(PU.scrollScript('nope').includes('scrollBy(0,0)'))
})

ok('extractScript embeds schema JSON-encoded + maps fields', () => {
  const schema = { title: 'h1', link: { selector: 'a', attr: 'href' } }
  const s = PU.extractScript(schema)
  assert.ok(s.includes(JSON.stringify(schema)))
  assert.ok(s.includes('getAttribute'))
  assert.ok(s.includes('textContent'))
  // empty/undefined schema → safe empty object
  assert.ok(PU.extractScript().includes('var s={}'))
})

console.log(`\npage-utils: ${passed} checks passed ✓`)
