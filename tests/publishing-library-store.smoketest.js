// OZ Browser — Publishing library store smoke test (E1-E4 → MCP migration).
//
// Run: node tests/publishing-library-store.smoketest.js

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

delete require.cache[require.resolve('../browser/publishing-library-store.js')]
const { PublishingLibraryStore, KINDS } = require(
  path.join('..', 'browser', 'publishing-library-store.js'),
)

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-publib-'))
}

console.log('publishing-library-store smoke test')

ok('requires userDataDir + exposes 3 kinds', () => {
  assert.throws(() => new PublishingLibraryStore({}))
  assert.deepStrictEqual(KINDS, ['templates', 'hashtags', 'media'])
})

ok('templates: save normalizes + list + remove', () => {
  const dir = tmpDir()
  const s = new PublishingLibraryStore({ userDataDir: dir })
  const t = s.save('templates', { name: 'Promo', caption: 'Hi', hashtags: ['a'] })
  assert.strictEqual(t.name, 'Promo')
  assert.strictEqual(s.list('templates').length, 1)
  assert.strictEqual(s.remove('templates', t.id), true)
  assert.strictEqual(s.list('templates').length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('hashtags: strips leading # and blanks', () => {
  const dir = tmpDir()
  const s = new PublishingLibraryStore({ userDataDir: dir })
  const g = s.save('hashtags', { name: 'set', tags: ['#foo', ' bar ', ''] })
  assert.deepStrictEqual(g.tags, ['foo', 'bar'])
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('media: dedupes by path; rejects empty', () => {
  const dir = tmpDir()
  const s = new PublishingLibraryStore({ userDataDir: dir })
  s.save('media', { path: '/a.jpg' })
  s.save('media', { path: '/a.jpg' }) // dup
  s.save('media', { path: '/b.jpg' })
  assert.strictEqual(s.list('media').length, 2)
  assert.strictEqual(s.save('media', { path: '' }), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('bad kind → null/[]/false; persists across instances', () => {
  const dir = tmpDir()
  const s = new PublishingLibraryStore({ userDataDir: dir })
  assert.strictEqual(s.save('bogus', {}), null)
  assert.deepStrictEqual(s.list('bogus'), [])
  assert.strictEqual(s.remove('bogus', 'x'), false)
  s.save('templates', { name: 'keep' })
  const s2 = new PublishingLibraryStore({ userDataDir: dir })
  assert.strictEqual(s2.list('templates').length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n✓ publishing-library-store: ${passed} checks passed`)
