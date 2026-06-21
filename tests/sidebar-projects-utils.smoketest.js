// OZ Browser — sidebar-projects-utils smoke test (F2 UI helpers).
//
// Run: node tests/sidebar-projects-utils.smoketest.js

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/ui/sidebar-projects-utils.js')]
const U = require(path.join('..', 'browser', 'ui', 'sidebar-projects-utils.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('sidebar-projects-utils smoke test')

ok('typeLabel maps workspace/session', () => {
  assert.strictEqual(U.typeLabel('workspace'), 'Workspace')
  assert.strictEqual(U.typeLabel('session'), 'Todo')
  assert.strictEqual(U.typeLabel('weird'), 'Workspace') // default
})

ok('projectSummary: pluralizes + appends type', () => {
  assert.strictEqual(
    U.projectSummary({ tabCount: 1, type: 'workspace' }),
    '1 tab · Workspace',
  )
  assert.strictEqual(U.projectSummary({ tabCount: 5, type: 'session' }), '5 tabs · Todo')
  assert.strictEqual(U.projectSummary({}), '0 tabs · Workspace')
  assert.strictEqual(U.projectSummary(null), '0 tabs · Workspace')
})

ok('sortProjects: most recent first, non-mutating', () => {
  const list = [
    { id: 'a', createdAt: 100 },
    { id: 'b', createdAt: 300 },
    { id: 'c', createdAt: 200 },
  ]
  const out = U.sortProjects(list)
  assert.deepStrictEqual(
    out.map((p) => p.id),
    ['b', 'c', 'a'],
  )
  assert.strictEqual(list[0].id, 'a', 'original not mutated')
  assert.deepStrictEqual(U.sortProjects(null), [])
})

ok('cleanName trims; empty on junk', () => {
  assert.strictEqual(U.cleanName('  Lanzamiento  '), 'Lanzamiento')
  assert.strictEqual(U.cleanName('   '), '')
  assert.strictEqual(U.cleanName(null), '')
  assert.strictEqual(U.cleanName(42), '')
})

console.log(`\n✓ sidebar-projects-utils: ${passed} checks passed`)
