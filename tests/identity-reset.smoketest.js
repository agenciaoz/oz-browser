// OZ Browser — identity-handlers.reset smoke test (v2.0.0-alpha.34).
//
// Run:
//   cd oz-browser
//   node tests/identity-reset.smoketest.js
//
// Covers reset(identityId): Ghost parity (support art. 320) — regenerates the
// fingerprint + closes the identity's UNLOCKED tabs across all windows, keeps
// everything else. No cookie wipe.

const Module = require('module')
const fakeElectron = {
  app: {
    getPath: () => '/tmp',
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

const assert = require('assert')
const { buildIdentityHandlers } = require('../browser/identity-handlers.js')

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

function makeWindow(tabs) {
  const removed = []
  return {
    removed,
    tabs: {
      tabList: tabs,
      remove(id) {
        const i = this.tabList.findIndex((t) => t.id === id)
        if (i >= 0) {
          removed.push(id)
          this.tabList.splice(i, 1)
        }
      },
    },
  }
}

function makeBrowser(windows, identities) {
  const regenCalls = []
  const broadcasts = []
  return {
    _regenCalls: regenCalls,
    _broadcasts: broadcasts,
    identityManager: {
      get: (id) => identities.find((i) => i.id === id) || null,
    },
    fingerprintEngine: {
      regenerate(id) {
        regenCalls.push(id)
        return { seed: 'new-' + id }
      },
    },
    windows,
    broadcastToWebUI(channel, payload) {
      broadcasts.push({ channel, payload })
    },
  }
}

console.log('identity reset smoke test')

ok('closes unlocked tabs of the identity + regenerates fingerprint', () => {
  const win = makeWindow([
    { id: 't1', identityId: 'A', locked: false },
    { id: 't2', identityId: 'A', locked: true }, // locked → kept
    { id: 't3', identityId: 'B', locked: false }, // other identity → kept
    { id: 't4', identityId: 'A', locked: false },
  ])
  const browser = makeBrowser([win], [{ id: 'A', name: 'Pedro' }])
  const h = buildIdentityHandlers(browser)
  const r = h.reset('A')

  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.closedTabs, 2) // t1 + t4
  assert.deepStrictEqual(win.removed.sort(), ['t1', 't4'])
  assert.deepStrictEqual(win.tabs.tabList.map((t) => t.id).sort(), ['t2', 't3']) // locked + other-identity survive
  assert.deepStrictEqual(browser._regenCalls, ['A'])
  assert(browser._broadcasts.some((b) => b.channel === 'oz:fingerprint:changed'))
})

ok('closes tabs across multiple windows', () => {
  const w1 = makeWindow([{ id: 'a', identityId: 'X', locked: false }])
  const w2 = makeWindow([
    { id: 'b', identityId: 'X', locked: false },
    { id: 'c', identityId: 'Y', locked: false },
  ])
  const browser = makeBrowser([w1, w2], [{ id: 'X', name: 'X' }])
  const r = buildIdentityHandlers(browser).reset('X')
  assert.strictEqual(r.closedTabs, 2)
  assert.deepStrictEqual(w1.removed, ['a'])
  assert.deepStrictEqual(w2.removed, ['b'])
})

ok('unknown identity → ok:false not-found, no side effects', () => {
  const win = makeWindow([{ id: 't1', identityId: 'A', locked: false }])
  const browser = makeBrowser([win], [{ id: 'A', name: 'A' }])
  const r = buildIdentityHandlers(browser).reset('NOPE')
  assert.deepStrictEqual(r, { ok: false, reason: 'not-found' })
  assert.strictEqual(win.removed.length, 0)
  assert.strictEqual(browser._regenCalls.length, 0)
})

ok('tolerates missing fingerprintEngine (still closes tabs)', () => {
  const win = makeWindow([{ id: 't1', identityId: 'A', locked: false }])
  const browser = makeBrowser([win], [{ id: 'A', name: 'A' }])
  delete browser.fingerprintEngine
  const r = buildIdentityHandlers(browser).reset('A')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.closedTabs, 1)
  assert.strictEqual(r.fingerprint, null)
})

console.log(`\nidentity reset: ${passed} checks passed ✓`)
