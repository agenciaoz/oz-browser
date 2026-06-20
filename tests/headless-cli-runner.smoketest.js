// OZ Browser — headless CLI + runner smoke test (V3-D).
//
// Run:
//   cd oz-browser
//   node tests/headless-cli-runner.smoketest.js
//
// Covers the pure arg parser + recipe validation + the step runner using a
// fake driver (page-handlers shape) and a fake clock.

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/headless-cli.js')]
delete require.cache[require.resolve('../browser/headless-runner.js')]
const CLI = require(path.join('..', 'browser', 'headless-cli.js'))
const RUN = require(path.join('..', 'browser', 'headless-runner.js'))

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

function fakeClock() {
  const sleeps = []
  return { sleeps, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) }
}

;(async () => {
  console.log('headless cli + runner smoke test')

  // ---- CLI parser -----------------------------------------------------------

  ok('isHeadlessInvocation detects the flag', () => {
    assert.strictEqual(CLI.isHeadlessInvocation(['--headless', '--identity', 'x']), true)
    assert.strictEqual(CLI.isHeadlessInvocation(['start']), false)
    assert.strictEqual(CLI.isHeadlessInvocation(null), false)
  })

  ok('parse: space and = forms, required flags present', () => {
    const a = CLI.parseHeadlessArgs([
      '--headless',
      '--identity',
      'id-1',
      '--recipe=/tmp/r.json',
      '--proxy',
      'px-2',
    ])
    assert.strictEqual(a.headless, true)
    assert.strictEqual(a.identityId, 'id-1')
    assert.strictEqual(a.recipePath, '/tmp/r.json')
    assert.strictEqual(a.proxyId, 'px-2')
    assert.deepStrictEqual(a.errors, [])
  })

  ok('parse: missing required → errors', () => {
    const a = CLI.parseHeadlessArgs(['--headless'])
    assert.ok(a.errors.some((e) => e.includes('--identity')))
    assert.ok(a.errors.some((e) => e.includes('--recipe')))
  })

  ok('parse: a value flag followed by another flag is reported missing', () => {
    const a = CLI.parseHeadlessArgs(['--headless', '--identity', '--recipe', '/r.json'])
    assert.strictEqual(a.recipePath, '/r.json')
    assert.ok(
      a.errors.some(
        (e) =>
          e.includes('--identity requires a value') ||
          e.includes('--identity is required'),
      ),
    )
  })

  ok('parse: not headless → no required-field errors', () => {
    const a = CLI.parseHeadlessArgs(['start'])
    assert.strictEqual(a.headless, false)
    assert.deepStrictEqual(a.errors, [])
  })

  // ---- recipe validation ----------------------------------------------------

  ok('validateRecipe: rejects bad shapes', () => {
    assert.strictEqual(RUN.validateRecipe(null).valid, false)
    assert.strictEqual(RUN.validateRecipe({}).valid, false)
    assert.strictEqual(RUN.validateRecipe({ steps: [] }).valid, false)
    const badOp = RUN.validateRecipe({ steps: [{ op: 'frobnicate' }] })
    assert.strictEqual(badOp.valid, false)
    assert.ok(
      badOp.errors[0].includes('frobnicate') || badOp.errors[0].includes('unknown op'),
    )
  })

  ok('validateRecipe: accepts a good recipe', () => {
    const v = RUN.validateRecipe({
      steps: [
        { op: 'navigate', url: 'https://a.com' },
        { op: 'getText', selector: 'h1' },
      ],
    })
    assert.strictEqual(v.valid, true)
    assert.deepStrictEqual(v.errors, [])
  })

  // ---- runner with a fake driver --------------------------------------------

  function makeDriver(overrides) {
    return Object.assign(
      {
        navigate: async () => ({ url: 'https://a.com', status: 'ok' }),
        getText: async () => ({ text: 'Hello' }),
        extract: async () => ({ items: [1, 2, 3] }),
      },
      overrides || {},
    )
  }

  await okAsync('runner: happy path collects named data', async () => {
    const driver = makeDriver()
    const res = await RUN.runHeadlessRecipe({
      recipe: {
        steps: [
          { op: 'navigate', url: 'https://a.com' },
          { op: 'extract', name: 'items', schema: { items: 'li' } },
        ],
      },
      driver,
      identityId: 'id-1',
      clock: fakeClock(),
    })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.steps.length, 2)
    assert.deepStrictEqual(res.data.items, { items: [1, 2, 3] })
  })

  await okAsync('runner: required step failure aborts the rest', async () => {
    let navCalls = 0
    let secondCalled = false
    const driver = makeDriver({
      navigate: async () => {
        navCalls++
        return { __error: { code: 'NOT_FOUND', message: 'no tab' } } // fatal-ish, non-retryable class 'unknown'? NOT_FOUND → unknown → retryable
      },
      getText: async () => {
        secondCalled = true
        return { text: 'x' }
      },
    })
    const res = await RUN.runHeadlessRecipe({
      recipe: {
        steps: [
          { op: 'navigate', url: 'https://a.com' },
          { op: 'getText', selector: 'h1' },
        ],
      },
      driver,
      identityId: 'id-1',
      retry: { maxAttempts: 1 }, // no retries → fail fast
      clock: fakeClock(),
    })
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.steps[0].ok, false)
    assert.strictEqual(secondCalled, false, 'second step must not run after hard failure')
    assert.strictEqual(navCalls, 1)
  })

  await okAsync('runner: optional step failure does not abort', async () => {
    const driver = makeDriver({
      getText: async () => ({ __error: { code: 'BAD_SELECTOR', message: 'x' } }),
    })
    const res = await RUN.runHeadlessRecipe({
      recipe: {
        steps: [
          { op: 'getText', selector: '.maybe', optional: true },
          { op: 'navigate', url: 'https://a.com' },
        ],
      },
      driver,
      identityId: 'id-1',
      retry: { maxAttempts: 1 },
      clock: fakeClock(),
    })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.steps[0].ok, false)
    assert.strictEqual(res.steps[1].ok, true)
  })

  await okAsync('runner: retries a transient step then succeeds', async () => {
    let calls = 0
    const driver = makeDriver({
      navigate: async () => {
        calls++
        if (calls < 2)
          return { __error: { code: 'NET', message: 'net::ERR_CONNECTION_RESET' } }
        return { url: 'ok' }
      },
    })
    const clock = fakeClock()
    const res = await RUN.runHeadlessRecipe({
      recipe: { steps: [{ op: 'navigate', url: 'https://a.com' }] },
      driver,
      identityId: 'id-1',
      retry: { maxAttempts: 3, baseMs: 5, jitter: false },
      clock,
    })
    assert.strictEqual(res.ok, true)
    assert.strictEqual(calls, 2)
    assert.strictEqual(res.steps[0].attempts, 2)
    assert.deepStrictEqual(clock.sleeps, [5])
  })

  await okAsync('runner: invalid recipe returns errors, runs nothing', async () => {
    const res = await RUN.runHeadlessRecipe({
      recipe: { steps: [] },
      driver: makeDriver(),
      identityId: 'id-1',
    })
    assert.strictEqual(res.ok, false)
    assert.ok(res.errors && res.errors.length > 0)
  })

  console.log(`\n✓ headless cli + runner: ${passed} checks passed`)
})().catch((e) => {
  console.error('\n✗ headless FAILED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
