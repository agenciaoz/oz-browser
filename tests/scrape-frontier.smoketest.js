// OZ Browser — scrape-frontier smoke test (V3-D).
//
// Run:
//   cd oz-browser
//   node tests/scrape-frontier.smoketest.js
//
// Covers normalizeUrl + the in-memory queue semantics + dedupe + retry +
// persistence round-trip (to a temp file).

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

delete require.cache[require.resolve('../browser/scrape-frontier.js')]
const M = require(path.join('..', 'browser', 'scrape-frontier.js'))
const { CrawlFrontier, normalizeUrl } = M

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('scrape-frontier smoke test')

// ---- normalizeUrl -----------------------------------------------------------

ok('normalizeUrl: drops fragment, keeps the rest', () => {
  assert.strictEqual(normalizeUrl('https://a.com/x?q=1#frag'), 'https://a.com/x?q=1')
  assert.strictEqual(normalizeUrl('https://A.com/Path'), 'https://a.com/Path') // host lc, path kept
})

ok('normalizeUrl: rejects junk + non-http(s)', () => {
  for (const bad of ['', 'not a url', 'ftp://a.com/x', 'about:blank', null]) {
    assert.strictEqual(normalizeUrl(bad), null, 'null for ' + String(bad))
  }
})

// ---- enqueue / dedupe / next ------------------------------------------------

ok('enqueue + next is FIFO; dedupe by normalized URL', () => {
  const f = new CrawlFrontier()
  assert.strictEqual(f.enqueue('https://a.com/1'), true)
  assert.strictEqual(f.enqueue('https://a.com/2'), true)
  // duplicate (only fragment differs) → rejected
  assert.strictEqual(f.enqueue('https://a.com/1#section'), false)
  assert.strictEqual(f.pending(), 2)
  assert.strictEqual(f.next().url, 'https://a.com/1')
  assert.strictEqual(f.next().url, 'https://a.com/2')
  assert.strictEqual(f.next(), null)
})

ok('enqueue: invalid url rejected', () => {
  const f = new CrawlFrontier()
  assert.strictEqual(f.enqueue('garbage'), false)
  assert.strictEqual(f.pending(), 0)
})

ok('maxDepth caps enqueue', () => {
  const f = new CrawlFrontier({ maxDepth: 1 })
  assert.strictEqual(f.enqueue('https://a.com/0', { depth: 0 }), true)
  assert.strictEqual(f.enqueue('https://a.com/1', { depth: 1 }), true)
  assert.strictEqual(f.enqueue('https://a.com/2', { depth: 2 }), false)
})

ok('enqueueMany returns count added (dedupes within batch)', () => {
  const f = new CrawlFrontier()
  const n = f.enqueueMany([
    'https://a.com/1',
    'https://a.com/1', // dup
    'https://a.com/2',
    'bad',
  ])
  assert.strictEqual(n, 2)
  assert.strictEqual(f.pending(), 2)
})

// ---- done / failed / retry --------------------------------------------------

ok('markDone records visited; has() reflects seen', () => {
  const f = new CrawlFrontier()
  f.enqueue('https://a.com/1')
  const it = f.next()
  f.markDone(it.url)
  assert.strictEqual(f.stats().done, 1)
  assert.strictEqual(f.has('https://a.com/1'), true)
  // already seen → not re-enqueued
  assert.strictEqual(f.enqueue('https://a.com/1'), false)
})

ok('markFailed retryable re-enqueues until maxAttempts', () => {
  const f = new CrawlFrontier({ maxAttempts: 3 })
  f.enqueue('https://a.com/1')
  let it = f.next() // attempts 0
  let r = f.markFailed(it.url, { retryable: true, attempts: it.attempts + 1 }) // attempt 1
  assert.strictEqual(r.requeued, true)
  it = f.next()
  assert.strictEqual(it.attempts, 1)
  r = f.markFailed(it.url, { retryable: true, attempts: it.attempts + 1 }) // attempt 2
  assert.strictEqual(r.requeued, true)
  it = f.next()
  r = f.markFailed(it.url, { retryable: true, attempts: it.attempts + 1 }) // attempt 3 == max
  assert.strictEqual(r.requeued, false)
  assert.strictEqual(f.stats().failed, 1)
  assert.strictEqual(f.pending(), 0)
})

ok('markFailed non-retryable goes straight to failed', () => {
  const f = new CrawlFrontier()
  f.enqueue('https://a.com/1')
  const it = f.next()
  const r = f.markFailed(it.url, { retryable: false, error: 'boom' })
  assert.strictEqual(r.requeued, false)
  assert.strictEqual(f.stats().failed, 1)
})

// ---- persistence round-trip -------------------------------------------------

ok('persists to disk and reloads state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-frontier-'))
  const fp = path.join(dir, 'frontier.json')
  const f1 = new CrawlFrontier({ filePath: fp })
  f1.enqueue('https://a.com/1')
  f1.enqueue('https://a.com/2')
  const done = f1.next()
  f1.markDone(done.url)
  assert.ok(fs.existsSync(fp), 'file written')

  // New instance from the same file restores queue + done + seen.
  const f2 = new CrawlFrontier({ filePath: fp })
  assert.strictEqual(f2.pending(), 1)
  assert.strictEqual(f2.next().url, 'https://a.com/2')
  assert.strictEqual(f2.has('https://a.com/1'), true)
  assert.strictEqual(f2.stats().done, 1)

  fs.rmSync(dir, { recursive: true, force: true })
})

ok('corrupt persistence file → starts fresh, no throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-frontier-'))
  const fp = path.join(dir, 'frontier.json')
  fs.writeFileSync(fp, '{ not valid json', 'utf8')
  const f = new CrawlFrontier({ filePath: fp })
  assert.strictEqual(f.pending(), 0)
  assert.strictEqual(f.enqueue('https://a.com/1'), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n✓ scrape-frontier: ${passed} checks passed`)
