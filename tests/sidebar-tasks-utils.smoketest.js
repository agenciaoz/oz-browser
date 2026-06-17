// OZ Browser — sidebar-tasks-utils smoke test (alpha.45).
//
// Run:
//   cd oz-browser
//   node tests/sidebar-tasks-utils.smoketest.js
//
// Covers the pure Tasks helpers (no DOM / Electron):
//   - addTask / toggleTask / removeTask / clearCompleted
//   - progress math
//   - sanitize (defensive load)

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/ui/sidebar-tasks-utils.js')]
const U = require(path.join('..', 'browser', 'ui', 'sidebar-tasks-utils.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('sidebar-tasks-utils smoke test')

ok('addTask appends, ignores empty, does not mutate', () => {
  const a = U.addTask([], 'Buy milk')
  assert.strictEqual(a.length, 1)
  assert.strictEqual(a[0].text, 'Buy milk')
  assert.strictEqual(a[0].done, false)
  assert.ok(a[0].id.startsWith('task-'))
  assert.strictEqual(U.addTask(a, '   ').length, 1) // whitespace ignored
  assert.strictEqual(a.length, 1) // original unchanged
})

ok('toggleTask flips one task by id', () => {
  const a = U.addTask([], 'x')
  const id = a[0].id
  const b = U.toggleTask(a, id)
  assert.strictEqual(b[0].done, true)
  assert.strictEqual(a[0].done, false) // not mutated
  assert.strictEqual(U.toggleTask(b, id)[0].done, false)
})

ok('removeTask + clearCompleted', () => {
  let a = U.addTask([], 'a')
  a = U.addTask(a, 'b')
  const idA = a[0].id
  assert.deepStrictEqual(
    U.removeTask(a, idA).map((t) => t.text),
    ['b'],
  )
  const toggled = U.toggleTask(a, idA)
  assert.deepStrictEqual(
    U.clearCompleted(toggled).map((t) => t.text),
    ['b'],
  )
})

ok('progress computes done/total/pct', () => {
  assert.deepStrictEqual(U.progress([]), { done: 0, total: 0, pct: 0 })
  let a = U.addTask([], 'a')
  a = U.addTask(a, 'b')
  a = U.toggleTask(a, a[0].id)
  assert.deepStrictEqual(U.progress(a), { done: 1, total: 2, pct: 50 })
})

ok('sanitize coerces arbitrary JSON to valid tasks', () => {
  assert.deepStrictEqual(U.sanitize(null), [])
  assert.deepStrictEqual(U.sanitize('nope'), [])
  const dirty = [
    { id: 'a', text: 'ok', done: 1 },
    { id: 'b' }, // missing text → dropped
    { text: 'no id' }, // missing id → dropped
    { id: 'c', text: 'fine', done: false },
  ]
  assert.deepStrictEqual(U.sanitize(dirty), [
    { id: 'a', text: 'ok', done: true },
    { id: 'c', text: 'fine', done: false },
  ])
})

console.log(`\nsidebar-tasks-utils: ${passed} checks passed ✓`)
