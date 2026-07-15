// OZ Browser — proxy reconnect (manual failover) smoke test (v2.0.0-alpha.102).
//   node tests/proxy-reconnect.smoketest.js

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' } }
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

const { buildProxyHandlers } = require('../browser/proxy-handlers.js')
const { buildProxyTools } = require('../browser/mcp-tools-proxies.js')

let passed = 0
let failed = 0
const failures = []
function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

console.log('OZ Browser — proxy reconnect smoke test\n')

function makeBrowser() {
  const assigns = { id1: 'p1' }
  const state = { applied: null, refreshed: null, broadcasts: [] }
  const browser = {
    proxyManager: {
      listAssignable: () => [
        { id: 'p1', isActive: true, isDisabled: false, failureCount: 5 },
        { id: 'p2', isActive: true, isDisabled: false, failureCount: 0 },
      ],
    },
    proxyAssignment: {
      resolve: ({ identityId }) => ({ id: assigns[identityId] }),
      assignToIdentity: (id, v) => {
        assigns[id] = v
        return true
      },
    },
    identityManager: {
      resolve: (id) => ({ identity: { id }, session: { fake: true } }),
    },
    stickyRotation: {
      applyForIdentity: async (id, sess) => {
        state.applied = { id, sess }
        return { ok: true }
      },
    },
    broadcastToWebUI: (ch) => state.broadcasts.push(ch),
    handlers: {},
  }
  browser.handlers.tabs = {
    refreshAllInIdentity: (identityId) => {
      state.refreshed = identityId
      return { ok: true, count: 3 }
    },
  }
  return { browser, assigns, state }
}

;(async () => {
  // handler happy path
  {
    const { browser, assigns, state } = makeBrowser()
    const h = buildProxyHandlers(browser)
    ok('handler reconnect exists', typeof h.reconnect === 'function')
    const r = await h.reconnect('id1')
    ok('reconnect ok', r && r.ok === true, JSON.stringify(r))
    ok('rotated p1 → p2', r.from === 'p1' && r.to === 'p2')
    ok('reassigned in store', assigns.id1 === 'p2')
    ok('applied to session', state.applied && state.applied.id === 'id1')
    ok('tabs reloaded (count propagado)', r.reloaded === 3 && state.refreshed === 'id1')
    ok('broadcast oz:proxies:changed', state.broadcasts.includes('oz:proxies:changed'))
  }

  // handler sad paths
  {
    const { browser } = makeBrowser()
    browser.proxyManager.listAssignable = () => [
      { id: 'p1', isActive: true, isDisabled: false, failureCount: 5 },
    ]
    const h = buildProxyHandlers(browser)
    const r = await h.reconnect('id1')
    ok(
      'sin proxy sano → no_healthy_proxy',
      r.ok === false && r.reason === 'no_healthy_proxy',
    )
    const r2 = await h.reconnect()
    ok('sin identityId → bad_args', r2.ok === false && r2.reason === 'bad_args')
  }

  // handler tolera fallo del reload de tabs (rotación igual ok)
  {
    const { browser } = makeBrowser()
    browser.handlers.tabs = {
      refreshAllInIdentity: () => {
        throw new Error('boom')
      },
    }
    const h = buildProxyHandlers(browser)
    const r = await h.reconnect('id1')
    ok('reload throw → rotación igual ok, reloaded 0', r.ok === true && r.reloaded === 0)
  }

  // MCP tool wiring
  {
    const calls = []
    const tools = buildProxyTools({
      proxies: () => ({
        reconnect: (identityId) => {
          calls.push(identityId)
          return { ok: true, from: 'a', to: 'b', reloaded: 1 }
        },
      }),
    })
    const tool = tools.find((t) => t.name === 'oz.proxies.reconnect')
    ok('tool oz.proxies.reconnect registrada', !!tool)
    ok(
      'nombre sanitizado ≤21 chars',
      tool && tool.name.replace(/\./g, '_').length <= 21,
      tool && tool.name.replace(/\./g, '_'),
    )
    ok(
      'inputSchema requiere identityId',
      tool && tool.inputSchema.required.includes('identityId'),
    )
    const r = tool.call({ identityId: 'idZ' })
    ok('tool delega en handlers.proxies.reconnect', calls[0] === 'idZ' && r.ok === true)
    ok('catálogo proxies = 23 tools', tools.length === 23, `len=${tools.length}`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  process.exit(0)
})()
