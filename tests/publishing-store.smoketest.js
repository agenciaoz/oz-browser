// OZ Browser — Publishing Studio local store smoke test (v2 Etapa 4-A).
//
// Runs under `node tests/publishing-store.smoketest.js` (no framework).

'use strict'

const assert = require('node:assert')
const { createStore } = require('../browser/ui/publishing-store')

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

function fakeStorage() {
  const mem = {}
  return {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => {
      mem[k] = String(v)
    },
    _mem: mem,
  }
}

ok('templates: save / list / remove round-trip + persistence', () => {
  const s = fakeStorage()
  const store = createStore(s)
  assert.deepStrictEqual(store.listTemplates(), [])
  const tpl = store.saveTemplate({
    name: 'Promo',
    caption: 'hi {{identity}}',
    hashtags: ['a'],
  })
  assert.ok(tpl.id)
  // New instance over the same storage sees it (persisted as JSON).
  const store2 = createStore(s)
  const list = store2.listTemplates()
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].name, 'Promo')
  store2.removeTemplate(tpl.id)
  assert.deepStrictEqual(createStore(s).listTemplates(), [])
})

ok('hashtag groups: normalizes tags (strips #) + save/remove', () => {
  const store = createStore(fakeStorage())
  const g = store.saveHashtagGroup({
    name: 'Travel',
    tags: ['#miami', 'beach', ' #sun '],
  })
  assert.deepStrictEqual(g.tags, ['miami', 'beach', 'sun'])
  assert.strictEqual(store.listHashtagGroups().length, 1)
  store.removeHashtagGroup(g.id)
  assert.strictEqual(store.listHashtagGroups().length, 0)
})

ok('media library: dedupes, newest-first, remove', () => {
  const store = createStore(fakeStorage())
  store.addMedia('/a.jpg')
  store.addMedia('/b.jpg')
  store.addMedia('/a.jpg') // dup -> moves to front, no duplicate
  assert.deepStrictEqual(store.listMedia(), ['/a.jpg', '/b.jpg'])
  store.removeMedia('/a.jpg')
  assert.deepStrictEqual(store.listMedia(), ['/b.jpg'])
})

ok('survives missing storage (in-memory fallback, no throw)', () => {
  const store = createStore(null)
  store.saveTemplate({ name: 'x', caption: 'y' })
  assert.strictEqual(store.listTemplates().length, 1)
})

ok('tolerates corrupt JSON in storage', () => {
  const s = fakeStorage()
  s.setItem('oz-pub-templates', '{not json')
  const store = createStore(s)
  assert.deepStrictEqual(store.listTemplates(), [])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
