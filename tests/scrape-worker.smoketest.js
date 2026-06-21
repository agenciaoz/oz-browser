// OZ Browser — scrape-worker smoke test (V3-D close).
//
// Run: node tests/scrape-worker.smoketest.js
//
// makeRecipeWorker over a fake page-driver (navigate/extract/getText shape).

'use strict'

const assert = require('assert')
const path = require('path')

for (const m of ['scrape-worker', 'headless-runner', 'scrape-retry']) {
  delete require.cache[require.resolve(`../browser/${m}.js`)]
}
const { makeRecipeWorker } = require(path.join('..', 'browser', 'scrape-worker.js'))

let passed = 0
async function okAsync(name, fn) {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

function fakeDriver(overrides) {
  return Object.assign(
    {
      navigate: async () => ({ url: 'ok' }),
      extract: async () => ({ items: [1, 2] }),
      getText: async () => ({ text: 'hi' }),
    },
    overrides || {},
  )
}

;(async () => {
  console.log('scrape-worker smoke test')

  await okAsync('navigates each URL + runs recipe, returns data', async () => {
    const driver = fakeDriver()
    const worker = makeRecipeWorker({
      driver,
      identityId: 'id-1',
      recipe: { steps: [{ op: 'extract', name: 'items', schema: { items: 'li' } }] },
    })
    const res = await worker({ url: 'https://a.com/1' })
    assert.strictEqual(res.ok, true)
    assert.deepStrictEqual(res.data.items, { items: [1, 2] })
  })

  await okAsync('navigate failure → not ok, retryable for transient', async () => {
    const driver = fakeDriver({
      navigate: async () => ({
        __error: { code: 'NET', message: 'net::ERR_CONNECTION_RESET' },
      }),
    })
    const worker = makeRecipeWorker({ driver, identityId: 'id-1' })
    const res = await worker({ url: 'https://a.com/x' })
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.retryable, true)
  })

  await okAsync('captcha failure → not retryable', async () => {
    const driver = fakeDriver({
      navigate: async () => ({ __error: { code: 'captcha', message: 'challenge' } }),
    })
    const worker = makeRecipeWorker({ driver, identityId: 'id-1' })
    const res = await worker({ url: 'https://a.com/x' })
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.retryable, false)
  })

  await okAsync('worker does not retry internally (one navigate per pass)', async () => {
    let calls = 0
    const driver = fakeDriver({
      navigate: async () => {
        calls++
        return { __error: { code: 'NET', message: 'net::ERR_TIMED_OUT' } }
      },
    })
    const worker = makeRecipeWorker({
      driver,
      identityId: 'id-1',
      clock: { sleep: () => Promise.resolve() },
    })
    await worker({ url: 'https://a.com/x' })
    assert.strictEqual(calls, 1) // frontier handles requeue, not the worker
  })

  await okAsync('linksName surfaces a url list as links', async () => {
    const driver = fakeDriver({
      extract: async () => ['https://a.com/2', 'https://a.com/3'],
    })
    const worker = makeRecipeWorker({
      driver,
      identityId: 'id-1',
      recipe: { steps: [{ op: 'extract', name: 'found', schema: {} }] },
      linksName: 'found',
    })
    const res = await worker({ url: 'https://a.com/1' })
    assert.strictEqual(res.ok, true)
    assert.deepStrictEqual(res.links, ['https://a.com/2', 'https://a.com/3'])
  })

  console.log(`\n✓ scrape-worker: ${passed} checks passed`)
})().catch((e) => {
  console.error('\n✗ scrape-worker FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
