// OZ Browser — link-context-menu builder smoke test (F1).
//
// Run: node tests/link-context-menu.smoketest.js

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/link-context-menu.js')]
const { openInIdentityItems } = require(
  path.join('..', 'browser', 'link-context-menu.js'),
)

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('link-context-menu smoke test')

const ids = [
  { id: 'a', name: 'Pedro' },
  { id: 'b', name: 'Contexto IG', isDefault: true },
  { id: 'c', name: 'El Informe' },
]

ok('lists every identity then temp + new', () => {
  const items = openInIdentityItems({ identities: ids, activeIdentityId: 'a' })
  // 3 identities + temp + new
  assert.strictEqual(items.length, 5)
  assert.strictEqual(items[0].action, 'open')
  assert.strictEqual(items[0].identityId, 'a')
  assert.strictEqual(items[3].action, 'open-temp')
  assert.strictEqual(items[4].action, 'open-new')
})

ok('marks active and default identities', () => {
  const items = openInIdentityItems({ identities: ids, activeIdentityId: 'a' })
  assert.ok(items[0].label.includes('(actual)'), 'active marked')
  assert.ok(items[1].label.includes('(default)'), 'default marked')
  assert.ok(!items[2].label.includes('('), 'plain identity unmarked')
})

ok('tolerates empty / junk identities', () => {
  const items = openInIdentityItems({ identities: null })
  assert.strictEqual(items.length, 2) // just temp + new
  const items2 = openInIdentityItems({
    identities: [{ name: 'no id' }, { id: 'x', name: '' }],
  })
  // first has no id → skipped; second kept with fallback label
  assert.strictEqual(items2.filter((i) => i.action === 'open').length, 1)
})

console.log(`\n✓ link-context-menu: ${passed} checks passed`)
