// OZ Browser — tab-label smoke test (v2.0.0-alpha.38).
//
// Run: cd oz-browser && node tests/tab-label.smoketest.js

'use strict'
const assert = require('assert')
const path = require('path')
delete require.cache[require.resolve('../browser/ui/tab-label.js')]
const T = require(path.join('..', 'browser', 'ui', 'tab-label.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('tab-label smoke test')

ok('networkAbbrev maps known socials (host-anchored)', () => {
  assert.strictEqual(T.networkAbbrev('https://www.instagram.com/feed'), 'IG')
  assert.strictEqual(T.networkAbbrev('https://x.com/home'), 'X')
  assert.strictEqual(T.networkAbbrev('https://twitter.com/x'), 'X')
  assert.strictEqual(T.networkAbbrev('https://facebook.com'), 'FB')
  assert.strictEqual(T.networkAbbrev('https://www.tiktok.com/@a'), 'TT')
  assert.strictEqual(T.networkAbbrev('https://youtu.be/abc'), 'YT')
  assert.strictEqual(T.networkAbbrev('https://www.linkedin.com/in/x'), 'IN')
  assert.strictEqual(T.networkAbbrev('https://mail.google.com/mail'), 'GM')
})

ok('networkAbbrev does NOT false-match lookalike domains', () => {
  assert.strictEqual(T.networkAbbrev('https://notx.com'), '')
  assert.strictEqual(T.networkAbbrev('https://instagram.com.evil.io'), '')
  assert.strictEqual(T.networkAbbrev('about:blank'), '')
  assert.strictEqual(T.networkAbbrev(''), '')
})

ok('hostLabel returns registrable word, empty for no host', () => {
  assert.strictEqual(T.hostLabel('https://mail.google.com'), 'google')
  assert.strictEqual(T.hostLabel('https://notion.so/page'), 'notion')
  assert.strictEqual(T.hostLabel('https://x.com'), 'x')
  assert.strictEqual(T.hostLabel('about:blank'), '')
})

ok('tabDisplayLabel = "Identity · RED" for socials', () => {
  assert.strictEqual(
    T.tabDisplayLabel('Contexto', 'https://www.instagram.com/'),
    'Contexto · IG',
  )
  assert.strictEqual(T.tabDisplayLabel('Pedro', 'https://x.com/home'), 'Pedro · X')
})

ok('tabDisplayLabel falls back to host word, then identity, then New Tab', () => {
  assert.strictEqual(
    T.tabDisplayLabel('Contexto', 'https://notion.so/x'),
    'Contexto · notion',
  )
  assert.strictEqual(T.tabDisplayLabel('Contexto', 'about:blank'), 'Contexto')
  assert.strictEqual(T.tabDisplayLabel('', 'https://notion.so'), 'notion')
  assert.strictEqual(T.tabDisplayLabel('', 'about:blank'), 'New Tab')
})

console.log(`\ntab-label: ${passed} checks passed ✓`)
