// OZ Browser — network-handlers smoke test (v3-A) with a FAKE session.
//
// Verifies the per-identity intercept wiring: one onBeforeRequest listener that
// blocks matching URLs, captures when toggled, and that clear() resets. Drives
// the captured listener directly (no Electron).
//
// Run: node tests/network-handlers.smoketest.js

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/network-handlers.js')]
const { buildNetworkHandlers } = require(
  path.join('..', 'browser', 'network-handlers.js'),
)

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// Fake session whose webRequest captures the listener so we can fire requests.
function makeFakeBrowser() {
  const ses = {
    webRequest: {
      listener: null,
      onBeforeRequest(fn) {
        this.listener = fn
      },
    },
  }
  return {
    _ses: ses,
    identityManager: { resolve: () => ({ session: ses }) },
  }
}

// Fire a request through the wired listener; returns the cb response.
function fire(ses, url, method, resourceType) {
  return new Promise((resolve) => {
    ses.webRequest.listener(
      { url, method: method || 'GET', resourceType: resourceType || 'xhr' },
      resolve,
    )
  })
}

async function main() {
  console.log('network-handlers smoke test (fake session)')

  // block ------------------------------------------------------------------
  {
    const b = makeFakeBrowser()
    const h = buildNetworkHandlers(b)
    const r = h.block({ identityId: 'id1', patterns: ['*doubleclick*', '*.png'] })
    assert.strictEqual(r.ok, true)
    ok('block: wires a listener', () =>
      assert.ok(typeof b._ses.webRequest.listener === 'function'),
    )

    const blocked = await fire(b._ses, 'https://x.doubleclick.net/a')
    ok('block: matching request is cancelled', () =>
      assert.deepStrictEqual(blocked, { cancel: true }),
    )

    const allowed = await fire(b._ses, 'https://example.com/app.js')
    ok('block: non-matching request passes through', () =>
      assert.deepStrictEqual(allowed, {}),
    )
  }

  // capture ----------------------------------------------------------------
  {
    const b = makeFakeBrowser()
    const h = buildNetworkHandlers(b)
    h.capture({ identityId: 'id1', on: true, patterns: ['*api*'] })
    await fire(b._ses, 'https://api.site.com/v1')
    await fire(b._ses, 'https://cdn.site.com/img.png') // not captured
    const log = h.captured({ identityId: 'id1' })
    ok('capture: only matching requests are logged', () => {
      assert.strictEqual(log.count, 1)
      assert.strictEqual(log.items[0].url, 'https://api.site.com/v1')
      assert.strictEqual(log.items[0].method, 'GET')
    })
  }

  // clear ------------------------------------------------------------------
  {
    const b = makeFakeBrowser()
    const h = buildNetworkHandlers(b)
    h.block({ identityId: 'id1', patterns: ['*ads*'] })
    h.capture({ identityId: 'id1', on: true })
    await fire(b._ses, 'https://ads.com/x')
    h.clear({ identityId: 'id1' })
    const afterBlock = await fire(b._ses, 'https://ads.com/x')
    ok('clear: blocking + capture reset (request passes, log empty)', () => {
      assert.deepStrictEqual(afterBlock, {})
      assert.strictEqual(h.captured({ identityId: 'id1' }).count, 0)
    })
  }

  // error path -------------------------------------------------------------
  {
    const b = makeFakeBrowser()
    b.identityManager.resolve = () => ({ session: null })
    const h = buildNetworkHandlers(b)
    ok('NO_SESSION when identity has no session', () => {
      const r = h.block({ identityId: 'id1', patterns: ['x'] })
      assert.ok(r.__error && r.__error.code === 'NO_SESSION')
    })
    ok('BAD_IDENTITY when identityId missing', () => {
      assert.strictEqual(h.captured({}).__error.code, 'BAD_IDENTITY')
    })
  }

  console.log(`\nnetwork-handlers: ${passed} checks passed ✓`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
