// OZ Browser — scrape-orchestrator smoke test (V3-D).
//
// Run:
//   cd oz-browser
//   node tests/scrape-orchestrator.smoketest.js
//
// Drives runScrapeJob with the REAL CrawlFrontier + DomainRateLimiter (both
// pure) plus fake workers and a fake clock — no Electron.

'use strict'

const assert = require('assert')
const path = require('path')

for (const m of ['scrape-orchestrator', 'scrape-frontier', 'scrape-ratelimit-domain']) {
  delete require.cache[require.resolve(`../browser/${m}.js`)]
}
const { runScrapeJob } = require(path.join('..', 'browser', 'scrape-orchestrator.js'))
const { CrawlFrontier } = require(path.join('..', 'browser', 'scrape-frontier.js'))
const { DomainRateLimiter } = require(
  path.join('..', 'browser', 'scrape-ratelimit-domain.js'),
)

let passed = 0
async function okAsync(name, fn) {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

function fakeClock() {
  const sleeps = []
  return { sleeps, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) }
}
const tick = () => new Promise((r) => setImmediate(r))

;(async () => {
  console.log('scrape-orchestrator smoke test')

  await okAsync('processes every queued URL once; all ok', async () => {
    const f = new CrawlFrontier()
    f.enqueueMany(['https://a.com/1', 'https://a.com/2', 'https://b.com/1'])
    const seen = []
    const res = await runScrapeJob({
      frontier: f,
      concurrency: 2,
      followLinks: false,
      worker: async (task) => {
        seen.push(task.url)
        return { ok: true }
      },
    })
    assert.strictEqual(res.processed, 3)
    assert.strictEqual(res.ok, 3)
    assert.strictEqual(res.failed, 0)
    assert.strictEqual(seen.length, 3)
    assert.strictEqual(f.stats().done, 3)
    assert.strictEqual(f.pending(), 0)
  })

  await okAsync('follows discovered links (BFS) with dedupe; no loops', async () => {
    const f = new CrawlFrontier()
    f.enqueue('https://a.com/')
    const visited = []
    const res = await runScrapeJob({
      frontier: f,
      concurrency: 3,
      worker: async (task) => {
        visited.push(task.url)
        if (task.url === 'https://a.com/') {
          // link back to self (dedup) + two children
          return {
            ok: true,
            links: ['https://a.com/', 'https://a.com/x', 'https://a.com/y'],
          }
        }
        return { ok: true, links: ['https://a.com/'] } // back-edge → deduped
      },
    })
    assert.strictEqual(res.ok, 3) // root + x + y, each once
    assert.deepStrictEqual(visited.sort(), [
      'https://a.com/',
      'https://a.com/x',
      'https://a.com/y',
    ])
  })

  await okAsync(
    'retryable failure is requeued until maxAttempts then failed',
    async () => {
      const f = new CrawlFrontier({ maxAttempts: 3 })
      f.enqueue('https://a.com/flaky')
      let calls = 0
      const res = await runScrapeJob({
        frontier: f,
        concurrency: 1,
        worker: async () => {
          calls++
          return { ok: false, retryable: true, error: 'net::ERR_X' }
        },
      })
      // attempt 1 (taken, attempts→1, requeued), attempt 2 (→2, requeued),
      // attempt 3 (→3 == max, NOT requeued).
      assert.strictEqual(calls, 3)
      assert.strictEqual(f.stats().failed, 1)
      assert.strictEqual(res.ok, 0)
      assert.strictEqual(f.pending(), 0)
    },
  )

  await okAsync('non-retryable failure goes straight to failed', async () => {
    const f = new CrawlFrontier()
    f.enqueue('https://a.com/bad')
    let calls = 0
    await runScrapeJob({
      frontier: f,
      concurrency: 1,
      worker: async () => {
        calls++
        return { ok: false, retryable: false, error: 'fatal' }
      },
    })
    assert.strictEqual(calls, 1)
    assert.strictEqual(f.stats().failed, 1)
  })

  await okAsync('worker that throws is treated as retryable failure', async () => {
    const f = new CrawlFrontier({ maxAttempts: 2 })
    f.enqueue('https://a.com/throws')
    let calls = 0
    await runScrapeJob({
      frontier: f,
      concurrency: 1,
      worker: async () => {
        calls++
        throw new Error('boom')
      },
    })
    assert.strictEqual(calls, 2) // retried once (maxAttempts 2)
    assert.strictEqual(f.stats().failed, 1)
  })

  await okAsync('maxPages caps tasks taken', async () => {
    const f = new CrawlFrontier()
    f.enqueueMany([
      'https://a.com/1',
      'https://a.com/2',
      'https://a.com/3',
      'https://a.com/4',
    ])
    const res = await runScrapeJob({
      frontier: f,
      concurrency: 1,
      followLinks: false,
      maxPages: 2,
      worker: async () => ({ ok: true }),
    })
    assert.strictEqual(res.processed, 2)
    assert.ok(f.pending() >= 1, 'remaining URLs left in queue')
  })

  await okAsync('rate limiter spacing → orchestrator sleeps the wait', async () => {
    const f = new CrawlFrontier()
    f.enqueueMany(['https://a.com/1', 'https://a.com/2'])
    const limClock = { now: () => 1000 } // frozen → spacing is deterministic
    const rl = new DomainRateLimiter({ minIntervalMs: 750, clock: limClock })
    const clock = fakeClock()
    await runScrapeJob({
      frontier: f,
      concurrency: 1,
      followLinks: false,
      rateLimiter: rl,
      clock,
      worker: async () => ({ ok: true }),
    })
    // 1st reserve waitMs 0 (no sleep), 2nd reserve waitMs 750 → one sleep(750).
    assert.deepStrictEqual(clock.sleeps, [750])
  })

  await okAsync('abort signal stops processing early', async () => {
    const f = new CrawlFrontier()
    f.enqueueMany(['https://a.com/1', 'https://a.com/2', 'https://a.com/3'])
    const signal = { aborted: false }
    let calls = 0
    const res = await runScrapeJob({
      frontier: f,
      concurrency: 1,
      followLinks: false,
      signal,
      worker: async () => {
        calls++
        signal.aborted = true // abort after the first task
        await tick()
        return { ok: true }
      },
    })
    assert.strictEqual(calls, 1)
    assert.strictEqual(res.aborted, true)
    assert.ok(f.pending() >= 2, 'unprocessed URLs remain')
  })

  await okAsync('runs workers in parallel (observes concurrency > 1)', async () => {
    const f = new CrawlFrontier()
    f.enqueueMany([
      'https://a.com/1',
      'https://a.com/2',
      'https://a.com/3',
      'https://a.com/4',
    ])
    let active = 0
    let maxActive = 0
    await runScrapeJob({
      frontier: f,
      concurrency: 3,
      followLinks: false,
      worker: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await tick()
        await tick()
        active--
        return { ok: true }
      },
    })
    assert.ok(maxActive >= 2, `expected parallel workers, saw max ${maxActive}`)
  })

  await okAsync('throws on missing frontier/worker', async () => {
    await assert.rejects(() => runScrapeJob({ worker: async () => ({ ok: true }) }))
    await assert.rejects(() => runScrapeJob({ frontier: new CrawlFrontier() }))
  })

  console.log(`\n✓ scrape-orchestrator: ${passed} checks passed`)
})().catch((e) => {
  console.error('\n✗ scrape-orchestrator FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
