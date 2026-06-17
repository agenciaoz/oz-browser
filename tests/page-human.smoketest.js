// OZ Browser — page-human helpers smoke test (v3-B).
//
// Run:
//   cd oz-browser
//   node tests/page-human.smoketest.js
//
// Covers the pure humanization math (no DOM/Electron), using a fixed rng so
// results are deterministic.

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/page-human.js')]
const HM = require(path.join('..', 'browser', 'page-human.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// Deterministic rng: cycles through a fixed sequence.
function seqRng(values) {
  let i = 0
  return () => values[i++ % values.length]
}

console.log('page-human smoke test')

ok('bezier endpoints: t=0 → p0, t=1 → p3', () => {
  assert.strictEqual(HM.bezier(0, 10, 20, 30, 0), 0)
  assert.strictEqual(HM.bezier(0, 10, 20, 30, 1), 30)
})

ok('bezierPath returns `steps` points ending exactly at end', () => {
  const rng = seqRng([0.5, 0.5])
  const p = HM.bezierPath({ x: 0, y: 0 }, { x: 100, y: 50 }, { steps: 18 }, rng)
  assert.strictEqual(p.length, 18)
  assert.deepStrictEqual(p[p.length - 1], { x: 100, y: 50 })
  // all points are integers
  assert.ok(p.every((q) => Number.isInteger(q.x) && Number.isInteger(q.y)))
})

ok('bezierPath bows off the straight line (control jitter applied)', () => {
  // rng=0 and 1 give max opposite offsets → a midpoint off the y=x/2 line.
  const p = HM.bezierPath(
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { steps: 10, jitter: 0.5 },
    seqRng([0, 1]),
  )
  // a straight horizontal move would keep y=0 everywhere; the bow deviates some.
  assert.ok(
    p.some((q) => q.y !== 0),
    'path should deviate vertically',
  )
})

ok('gaussian clamps to [min,max] and rounds', () => {
  // extreme rng pushes value out of range → clamped
  const lo = HM.gaussian(100, 50, seqRng([0.999999, 0.999999]), 20, 400)
  assert.ok(lo >= 20 && lo <= 400)
  assert.ok(Number.isInteger(lo))
})

ok('keystrokeDelays: one per char, each within bounds', () => {
  const d = HM.keystrokeDelays('hello', { mean: 110, std: 30 }, seqRng([0.4, 0.6]))
  assert.strictEqual(d.length, 5)
  assert.ok(d.every((x) => x >= 20 && x <= 400))
  assert.strictEqual(HM.keystrokeDelays('', {}, seqRng([0.5, 0.5])).length, 0)
})

console.log(`\npage-human: ${passed} checks passed ✓`)
