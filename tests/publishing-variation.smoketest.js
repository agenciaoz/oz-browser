// OZ Browser — Publishing Studio variation engine smoke test (v2 Etapa 4-A).
//
// Runs under `node tests/publishing-variation.smoketest.js` (no framework).

'use strict'

const assert = require('node:assert')
const V = require('../browser/ui/publishing-variation')

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err.message}`)
  }
}
function section(title) {
  console.log(`\n# ${title}`)
}

section('rng + hashSeed')
ok('makeRng is deterministic for a given seed', () => {
  const a = V.makeRng(42)
  const b = V.makeRng(42)
  assert.strictEqual(a(), b())
  assert.strictEqual(a(), b())
})
ok('hashSeed is stable + differs by string', () => {
  assert.strictEqual(V.hashSeed('abc'), V.hashSeed('abc'))
  assert.notStrictEqual(V.hashSeed('abc'), V.hashSeed('abd'))
})

section('spintax')
ok('expands a flat group', () => {
  const rng = V.makeRng(1)
  const out = V.expandSpintax('{hola|hey|qué tal}', rng)
  assert.ok(['hola', 'hey', 'qué tal'].includes(out))
})
ok('expands nested groups', () => {
  const rng = V.makeRng(7)
  const out = V.expandSpintax('a {b|{c|d}} e', rng)
  assert.ok(/^a (b|c|d) e$/.test(out), out)
})
ok('no braces -> unchanged', () => {
  assert.strictEqual(V.expandSpintax('plain text', V.makeRng(1)), 'plain text')
})
ok('spintaxVariety multiplies group sizes', () => {
  assert.strictEqual(V.spintaxVariety('{a|b} x {c|d|e}'), 6)
  assert.strictEqual(V.spintaxVariety('none'), 1)
})

section('interpolate')
ok('replaces {{vars}} and blanks missing', () => {
  assert.strictEqual(V.interpolate('hi {{name}}!', { name: 'Pedro' }), 'hi Pedro!')
  assert.strictEqual(V.interpolate('hi {{name}}!', {}), 'hi !')
})

section('pickN + rotate + tags')
ok('pickN returns n distinct items', () => {
  const got = V.pickN(['a', 'b', 'c', 'd'], 2, V.makeRng(3))
  assert.strictEqual(got.length, 2)
  assert.strictEqual(new Set(got).size, 2)
})
ok('pickN caps at array length', () => {
  assert.strictEqual(V.pickN(['a', 'b'], 5, V.makeRng(1)).length, 2)
})
ok('rotate wraps by index', () => {
  assert.strictEqual(V.rotate(['x', 'y', 'z'], 0), 'x')
  assert.strictEqual(V.rotate(['x', 'y', 'z'], 4), 'y')
  assert.strictEqual(V.rotate([], 1), null)
})
ok('normalizeTag + formatHashtags', () => {
  assert.strictEqual(V.normalizeTag('  travel '), '#travel')
  assert.strictEqual(V.normalizeTag('##miami beach'), '#miamibeach')
  assert.strictEqual(V.formatHashtags(['a', '#b', ' c ']), '#a #b #c')
})

section('resolveForIdentity + preview')
ok('is deterministic per identity', () => {
  const spec = {
    caption: '{hola|hey} {{identity}}',
    hashtags: ['a', 'b', 'c'],
    hashtagCount: 2,
  }
  const id = { id: 'pedro', name: 'Pedro' }
  const r1 = V.resolveForIdentity(spec, { index: 0, identity: id })
  const r2 = V.resolveForIdentity(spec, { index: 0, identity: id })
  assert.deepStrictEqual(r1, r2)
  assert.ok(r1.caption.includes('Pedro'))
})
ok('different identities can get different captions', () => {
  const spec = {
    caption: '{a|b|c|d|e|f|g|h}',
    hashtags: ['x', 'y', 'z', 'w'],
    hashtagCount: 2,
  }
  const ids = Array.from({ length: 8 }, (_, i) => ({ id: 'id' + i, name: 'N' + i }))
  const captions = ids.map(
    (id, i) => V.resolveForIdentity(spec, { index: i, identity: id }).caption,
  )
  // At least 2 distinct outcomes across 8 identities (anti-footprint).
  assert.ok(new Set(captions).size >= 2)
})
ok('rotates media across identities', () => {
  const spec = { caption: 'x', mediaList: ['/a.jpg', '/b.jpg', '/c.jpg'] }
  const paths = [0, 1, 2, 3].map(
    (i) => V.resolveForIdentity(spec, { index: i, identity: { id: 'i' + i } }).mediaPath,
  )
  assert.deepStrictEqual(paths, ['/a.jpg', '/b.jpg', '/c.jpg', '/a.jpg'])
})
ok('firstCommentHashtags keeps tags out of caption', () => {
  const spec = {
    caption: 'hello',
    hashtags: ['a', 'b'],
    hashtagCount: 2,
    firstCommentHashtags: true,
  }
  const r = V.resolveForIdentity(spec, { index: 0, identity: { id: 'x' } })
  assert.strictEqual(r.caption, 'hello')
  assert.ok(r.firstComment.includes('#'))
})
ok('previewVariations returns a row per identity', () => {
  const spec = { caption: 'hi {{identity}}', hashtags: [], hashtagCount: 0 }
  const rows = V.previewVariations(spec, [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ])
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].name, 'A')
  assert.ok(rows[0].caption.includes('A'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
