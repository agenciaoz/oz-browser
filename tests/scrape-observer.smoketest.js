// OZ Browser — scrape-observer smoke test (V3-E, alpha.111).
//
//   node tests/scrape-observer.smoketest.js
//
// Cubre ScrapeObserver aislado + integración con runScrapeJob (onProgress).

'use strict'

const assert = require('assert')
const path = require('path')

for (const m of ['scrape-observer', 'scrape-orchestrator', 'scrape-frontier']) {
  delete require.cache[require.resolve(`../browser/${m}.js`)]
}
const { ScrapeObserver, domainOf } = require('../browser/scrape-observer.js')
const { runScrapeJob } = require('../browser/scrape-orchestrator.js')
const { CrawlFrontier } = require('../browser/scrape-frontier.js')

let passed = 0
function ok(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' :: ' + detail : ''}`)
  passed++
  console.log('  ✓ ' + name)
}
async function okAsync(name, fn) {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('scrape-observer smoke test')

// ---- domainOf ----
ok('domainOf extrae host', domainOf('https://x.com/a?b=1') === 'x.com')
ok('domainOf basura → (unknown)', domainOf('not a url') === '(unknown)')

// ---- observer aislado con reloj inyectado ----
{
  let t = 1000
  const obs = new ScrapeObserver({ jobId: 'job1', identityId: 'id-1', now: () => t })
  obs.start()
  t = 1100
  obs.record({
    url: 'https://a.com/1',
    ok: true,
    workerId: 0,
    durationMs: 100,
    bytes: 500,
  })
  t = 1250
  obs.record({
    url: 'https://a.com/2',
    ok: false,
    workerId: 1,
    durationMs: 50,
    bytes: 0,
    error: 'timeout',
  })
  t = 1400
  obs.record({
    url: 'https://b.com/1',
    ok: true,
    workerId: 0,
    durationMs: 200,
    bytes: 1500,
    screenshot: '/tmp/shot-1.png',
  })
  t = 2000
  obs.finish({ processed: 3, ok: 2, failed: 1 })
  const r = obs.report()

  ok('jobId propagado', r.jobId === 'job1')
  ok('identityId propagado', r.identityId === 'id-1')
  ok('wallMs = end - start', r.wallMs === 1000) // 2000 - 1000
  ok('cost.pages = 3', r.cost.pages === 3)
  ok('cost.ok = 2', r.cost.ok === 2)
  ok('cost.failed = 1', r.cost.failed === 1)
  ok('cost.bytes suma', r.cost.bytes === 2000)
  ok('cost.successRate', r.cost.successRate === Number((2 / 3).toFixed(3)))
  ok('cost.avgPageMs = (100+50+200)/3 redondeado', r.cost.avgPageMs === 117)
  ok('timeline solo con screenshot (1)', r.timeline.length === 1)
  ok('timeline apunta al shot', r.timeline[0].screenshot === '/tmp/shot-1.png')
  ok(
    'errors capturó el timeout',
    r.errors.length === 1 && r.errors[0].error === 'timeout',
  )
  ok('actionLog tiene las 3 acciones', r.actionLog.length === 3)

  const w0 = r.byWorker.find((w) => w.key === '0')
  ok('byWorker[0] hizo 2 páginas', w0 && w0.pages === 2)
  ok('byWorker[0] ambas ok', w0 && w0.ok === 2 && w0.failed === 0)
  const da = r.byDomain.find((d) => d.key === 'a.com')
  ok('byDomain a.com = 2 páginas, 1 fail', da && da.pages === 2 && da.failed === 1)
  ok('byDomain ordenado por pages desc', r.byDomain[0].pages >= r.byDomain[1].pages)
  ok('summary guardado', r.summary && r.summary.processed === 3)
}

// ---- defensivo: eventos inválidos se ignoran ----
{
  const obs = new ScrapeObserver({ now: () => 5 })
  obs.record(null)
  obs.record({})
  obs.record({ url: 42 })
  const r = obs.report()
  ok('eventos inválidos ignorados', r.cost.pages === 0)
  ok('jobId autogenerado', typeof r.jobId === 'string' && r.jobId.startsWith('scrape-'))
}

// ---- integración con runScrapeJob ----
;(async () => {
  await okAsync('integración: onProgress alimenta el observer', async () => {
    const f = new CrawlFrontier()
    f.enqueueMany(['https://a.com/1', 'https://a.com/2'])
    const obs = new ScrapeObserver({ jobId: 'int', now: () => Date.now() }).start()
    const summary = await runScrapeJob({
      frontier: f,
      concurrency: 1,
      followLinks: false,
      worker: async (task) => {
        if (task.url.endsWith('/2')) return { ok: false, error: 'boom', retryable: false }
        return { ok: true, data: 'hello world', screenshot: '/tmp/s.png' }
      },
      onProgress: (evt) => obs.record(evt),
    })
    obs.finish(summary)
    const r = obs.report()
    assert.strictEqual(r.cost.pages, 2)
    assert.strictEqual(r.cost.ok, 1)
    assert.strictEqual(r.cost.failed, 1)
    assert.ok(r.cost.bytes >= 'hello world'.length, 'bytes desde data string')
    assert.strictEqual(r.timeline.length, 1)
    assert.strictEqual(r.errors.length, 1)
    assert.strictEqual(r.errors[0].error, 'boom')
  })

  console.log(`\n=== ${passed} passed · 0 failed ===`)
  process.exit(0)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
