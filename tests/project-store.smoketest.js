// OZ Browser — project-store smoke test (F2).
//
// Run: node tests/project-store.smoketest.js

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

delete require.cache[require.resolve('../browser/project-store.js')]
const { ProjectStore } = require(path.join('..', 'browser', 'project-store.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('project-store smoke test')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-projects-'))
}

ok('requires userDataDir', () => {
  assert.throws(() => new ProjectStore({}))
})

ok('save + list + get round-trip', () => {
  const dir = tmpDir()
  const s = new ProjectStore({ userDataDir: dir })
  const meta = s.save({
    name: 'Lanzamiento',
    type: 'workspace',
    tabs: [
      { identityId: 'a', url: 'https://instagram.com', title: 'IG' },
      { identityId: 'b', url: 'https://x.com', title: 'X' },
    ],
  })
  assert.strictEqual(meta.tabCount, 2)
  assert.strictEqual(meta.type, 'workspace')
  const list = s.list()
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].name, 'Lanzamiento')
  const full = s.get(meta.id)
  assert.strictEqual(full.tabs.length, 2)
  assert.strictEqual(full.tabs[0].url, 'https://instagram.com')
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('save sanitizes: drops urlless tabs, defaults type/name', () => {
  const dir = tmpDir()
  const s = new ProjectStore({ userDataDir: dir })
  const meta = s.save({
    name: '   ',
    type: 'bogus',
    tabs: [{ url: 'https://a.com' }, { title: 'no url' }, null],
  })
  assert.strictEqual(meta.name, 'Untitled')
  assert.strictEqual(meta.type, 'workspace') // bogus → default
  assert.strictEqual(meta.tabCount, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('session type preserved', () => {
  const dir = tmpDir()
  const s = new ProjectStore({ userDataDir: dir })
  const meta = s.save({ name: 'Todo', type: 'session', tabs: [{ url: 'https://a.com' }] })
  assert.strictEqual(meta.type, 'session')
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('rename + remove', () => {
  const dir = tmpDir()
  const s = new ProjectStore({ userDataDir: dir })
  const meta = s.save({
    name: 'Old',
    type: 'workspace',
    tabs: [{ url: 'https://a.com' }],
  })
  assert.strictEqual(s.rename(meta.id, 'New'), true)
  assert.strictEqual(s.get(meta.id).name, 'New')
  assert.strictEqual(s.rename('nope', 'X'), false)
  assert.strictEqual(s.remove(meta.id), true)
  assert.strictEqual(s.get(meta.id), null)
  assert.strictEqual(s.remove(meta.id), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('persists across instances; tolerates corrupt file', () => {
  const dir = tmpDir()
  const fp = path.join(dir, 'projects.json')
  const s1 = new ProjectStore({ userDataDir: dir })
  s1.save({ name: 'P1', type: 'workspace', tabs: [{ url: 'https://a.com' }] })
  const s2 = new ProjectStore({ userDataDir: dir })
  assert.strictEqual(s2.list().length, 1)
  // corrupt → fresh
  fs.writeFileSync(fp, '{bad json', 'utf8')
  const s3 = new ProjectStore({ userDataDir: dir })
  assert.strictEqual(s3.list().length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('list sorted by most recent', () => {
  const dir = tmpDir()
  let t = 1000
  const s = new ProjectStore({ userDataDir: dir, clock: { now: () => (t += 1000) } })
  s.save({ name: 'first', type: 'workspace', tabs: [{ url: 'https://a.com' }] })
  s.save({ name: 'second', type: 'workspace', tabs: [{ url: 'https://b.com' }] })
  const list = s.list()
  assert.strictEqual(list[0].name, 'second')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n✓ project-store: ${passed} checks passed`)
