// OZ Browser — scrape-retry + bulk-runner-retry smoke test (V3-D).
//
// Run:
//   cd oz-browser
//   node tests/scrape-retry.smoketest.js
//
// Covers the pure error classifier + backoff math + the runWithRetry glue
// (with a fake clock so no real time passes).

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/scrape-retry.js')]
delete require.cache[require.resolve('../browser/bulk-runner-retry.js')]
const R = require(path.join('..', 'browser', 'scrape-retry.js'))
const { runWithRetry } = require(path.join('..', 'browser', 'bulk-runner-retry.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}
async function okAsync(name, fn) {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

// A fake clock that records sleeps instead of waiting.
function fakeClock() {
  const sleeps = []
  return {
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  }
}

;(async () => {
  console.log('scrape-retry smoke test')

  // ---- classifyError --------------------------------------------------------

  ok('classify: transient classes are retryable', () => {
    for (const [err, klass] of [
      [new Error('net::ERR_CONNECTION_RESET'), 'network'],
      [{ code: 'ECONNRESET', message: 'socket' }, 'network'],
      [new Error('Navigation timeout of 30000 ms exceeded'), 'timeout'],
      [new Error('navigation failed'), 'navigation'],
      [new Error('something weird'), 'unknown'],
    ]) {
      const r = R.classifyError(err)
      assert.strictEqual(r.class, klass, 'class for ' + (err.message || err.code))
      assert.strictEqual(r.retryable, true, klass + ' should retry')
    }
  })

  ok('classify: human/fatal classes are NOT retryable', () => {
    for (const [err, klass] of [
      [{ code: 'needs_login', message: 'login' }, 'needs_login'],
      [{ code: 'rate-limit', message: 'cap' }, 'rate-limit'],
      [{ code: 'captcha', message: 'x' }, 'captcha'],
      [new Error('hCaptcha challenge present'), 'captcha'],
      [
        (() => {
          const e = new Error('user cancelled')
          e.name = 'AbortError'
          return e
        })(),
        'aborted',
      ],
      [new TypeError('Cannot read properties of undefined'), 'fatal'],
    ]) {
      const r = R.classifyError(err)
      assert.strictEqual(r.class, klass, 'class match ' + klass)
      assert.strictEqual(r.retryable, false, klass + ' must not retry')
    }
  })

  ok('classify: null → unknown/retryable (defensive)', () => {
    const r = R.classifyError(null)
    assert.strictEqual(r.class, 'unknown')
    assert.strictEqual(r.retryable, true)
  })

  // ---- buildRetryPolicy -----------------------------------------------------

  ok('policy: defaults + clamps junk', () => {
    const p = R.buildRetryPolicy(null)
    assert.strictEqual(p.maxAttempts, R.DEFAULTS.maxAttempts)
    // Junk maxAttempts falls back to the default; never below 1.
    const p2 = R.buildRetryPolicy({ maxAttempts: -5, baseMs: 'x', factor: 0 })
    assert.strictEqual(p2.maxAttempts, R.DEFAULTS.maxAttempts)
    assert.ok(p2.maxAttempts >= 1)
    assert.ok(p2.baseMs > 0)
  })

  // ---- backoffDelay ---------------------------------------------------------

  ok('backoff: no-jitter is exponential and capped', () => {
    const opts = { baseMs: 100, factor: 2, maxMs: 1000, jitter: false }
    assert.strictEqual(R.backoffDelay(1, opts), 100)
    assert.strictEqual(R.backoffDelay(2, opts), 200)
    assert.strictEqual(R.backoffDelay(3, opts), 400)
    assert.strictEqual(R.backoffDelay(10, opts), 1000) // capped at maxMs
  })

  ok('backoff: equal-jitter stays within [half, full]', () => {
    const opts = { baseMs: 1000, factor: 2, maxMs: 60000, jitter: true, rng: () => 0 }
    // attempt 2 raw = 2000; equal jitter with rng=0 → half = 1000
    assert.strictEqual(R.backoffDelay(2, opts), 1000)
    const optsHi = { ...opts, rng: () => 1 }
    assert.strictEqual(R.backoffDelay(2, optsHi), 2000)
  })

  // ---- shouldRetry ----------------------------------------------------------

  ok('shouldRetry: stops at maxAttempts and on non-retryable', () => {
    const p = R.buildRetryPolicy({ maxAttempts: 3 })
    assert.strictEqual(R.shouldRetry(new Error('net::ERR_X'), 1, p), true)
    assert.strictEqual(R.shouldRetry(new Error('net::ERR_X'), 3, p), false) // exhausted
    assert.strictEqual(R.shouldRetry({ code: 'captcha' }, 1, p), false)
  })

  ok('shouldRetry: respects retryClasses allowlist', () => {
    const p = R.buildRetryPolicy({ maxAttempts: 5, retryClasses: ['network'] })
    assert.strictEqual(R.shouldRetry(new Error('net::ERR_X'), 1, p), true)
    assert.strictEqual(R.shouldRetry(new Error('timeout exceeded'), 1, p), false)
  })

  // ---- runWithRetry ---------------------------------------------------------

  await okAsync('runWithRetry: succeeds first try, no sleeps', async () => {
    const clock = fakeClock()
    const out = await runWithRetry({
      runFn: () => Promise.resolve('ok'),
      policyOpts: { maxAttempts: 3 },
      clock,
    })
    assert.strictEqual(out.result, 'ok')
    assert.strictEqual(out.attempts, 1)
    assert.strictEqual(clock.sleeps.length, 0)
  })

  await okAsync('runWithRetry: retries transient then succeeds', async () => {
    const clock = fakeClock()
    let calls = 0
    const out = await runWithRetry({
      runFn: () => {
        calls++
        if (calls < 3) return Promise.reject(new Error('net::ERR_CONNECTION_RESET'))
        return Promise.resolve('done')
      },
      policyOpts: { maxAttempts: 3, baseMs: 10, jitter: false },
      clock,
    })
    assert.strictEqual(out.result, 'done')
    assert.strictEqual(out.attempts, 3)
    assert.deepStrictEqual(clock.sleeps, [10, 20]) // backoff before attempts 2 and 3
  })

  await okAsync('runWithRetry: non-retryable fails immediately', async () => {
    const clock = fakeClock()
    let calls = 0
    let threw = null
    try {
      await runWithRetry({
        runFn: () => {
          calls++
          return Promise.reject(
            Object.assign(new Error('login'), { code: 'needs_login' }),
          )
        },
        policyOpts: { maxAttempts: 5 },
        clock,
      })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, 'should throw')
    assert.strictEqual(calls, 1, 'no retry for needs_login')
    assert.strictEqual(clock.sleeps.length, 0)
    assert.strictEqual(threw.retryAttempts, 1)
  })

  await okAsync('runWithRetry: exhausts attempts and rethrows last error', async () => {
    const clock = fakeClock()
    let calls = 0
    let threw = null
    try {
      await runWithRetry({
        runFn: () => {
          calls++
          return Promise.reject(new Error('net::ERR_TIMED_OUT'))
        },
        policyOpts: { maxAttempts: 3, baseMs: 5, jitter: false },
        clock,
      })
    } catch (e) {
      threw = e
    }
    assert.ok(threw)
    assert.strictEqual(calls, 3)
    assert.strictEqual(threw.retryAttempts, 3)
    assert.deepStrictEqual(clock.sleeps, [5, 10])
  })

  await okAsync('runWithRetry: aborted signal stops before running', async () => {
    const clock = fakeClock()
    let calls = 0
    let threw = null
    try {
      await runWithRetry({
        runFn: () => {
          calls++
          return Promise.resolve('x')
        },
        policyOpts: { maxAttempts: 3 },
        clock,
        signal: { aborted: true },
      })
    } catch (e) {
      threw = e
    }
    assert.ok(threw)
    assert.strictEqual(threw.name, 'AbortError')
    assert.strictEqual(calls, 0)
  })

  console.log(`\n✓ scrape-retry: ${passed} checks passed`)
})().catch((e) => {
  console.error('\n✗ scrape-retry FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
