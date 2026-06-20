// OZ Browser — identity-ephemeral cleanup decision smoke test (F3).
//
// Run: node tests/identity-ephemeral.smoketest.js

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/identity-ephemeral.js')]
const { shouldCleanupEphemeral } = require(
  path.join('..', 'browser', 'identity-ephemeral.js'),
)

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('identity-ephemeral smoke test')

ok('ephemeral + no remaining tabs → cleanup', () => {
  const id = { id: 'e1', ephemeral: true }
  assert.strictEqual(shouldCleanupEphemeral(id, []), true)
  assert.strictEqual(shouldCleanupEphemeral(id, [{ identityId: 'other' }]), true)
})

ok('ephemeral but a tab still uses it → no cleanup', () => {
  const id = { id: 'e1', ephemeral: true }
  assert.strictEqual(shouldCleanupEphemeral(id, [{ identityId: 'e1' }]), false)
  assert.strictEqual(
    shouldCleanupEphemeral(id, [{ identityId: 'x' }, { identityId: 'e1' }]),
    false,
  )
})

ok('non-ephemeral identity → never cleanup', () => {
  assert.strictEqual(shouldCleanupEphemeral({ id: 'p1', ephemeral: false }, []), false)
  assert.strictEqual(shouldCleanupEphemeral({ id: 'p1' }, []), false)
})

ok('junk input is safe', () => {
  assert.strictEqual(shouldCleanupEphemeral(null, []), false)
  assert.strictEqual(shouldCleanupEphemeral({ ephemeral: true }, []), false) // no id
  assert.strictEqual(shouldCleanupEphemeral({ id: 'e', ephemeral: true }, null), true)
})

console.log(`\n✓ identity-ephemeral: ${passed} checks passed`)
