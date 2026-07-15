// OZ Browser — proxy-failover smoke test (v2.0.0-alpha.101).
//   node tests/proxy-failover.smoketest.js

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' } }
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/proxy-failover.js')]
const {
  isProxyError,
  pickFailoverProxy,
  rotateIdentityProxy,
  onNavFail,
  registerFailoverHandler,
} = require('../browser/proxy-failover.js')

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

console.log('OZ Browser — proxy-failover smoke test\n')

// isProxyError
ok('tunnel failed → proxy error', isProxyError('ERR_TUNNEL_CONNECTION_FAILED'))
ok('proxy connection failed → proxy error', isProxyError('ERR_PROXY_CONNECTION_FAILED'))
ok('timed out → proxy error', isProxyError('ERR_TIMED_OUT'))
ok('404 legit → NOT proxy error', !isProxyError('ERR_HTTP_RESPONSE_CODE_FAILURE'))
ok('empty desc → NOT proxy error', !isProxyError(''))

// pickFailoverProxy — picks a healthy proxy != current, prefers low failureCount
{
  const pm = {
    listAssignable: () => [
      { id: 'a', isActive: true, isDisabled: false, failureCount: 0 },
      { id: 'b', isActive: true, isDisabled: false, failureCount: 3 },
      { id: 'cur', isActive: true, isDisabled: false, failureCount: 0 },
      { id: 'dead', isActive: true, isDisabled: true, failureCount: 0 },
    ],
  }
  const pick = pickFailoverProxy(pm, 'cur')
  ok('excludes current', pick !== 'cur')
  ok('excludes disabled', pick !== 'dead')
  ok('prefers lowest failureCount (a over b)', pick === 'a')
  const none = pickFailoverProxy({ listAssignable: () => [] }, 'cur')
  ok('no healthy → null', none === null)
}

// rotateIdentityProxy — reassigns + applies
{
  const assigns = { id1: 'p1' }
  let applied = null
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
        applied = { id, sess }
        return { ok: true }
      },
    },
  }
  return (async () => {
    const r = await rotateIdentityProxy(browser, 'id1', 'auto')
    ok('rotate ok', r.ok === true, JSON.stringify(r))
    ok('rotated away from failing p1', r.from === 'p1' && r.to === 'p2')
    ok('reassigned in store', assigns.id1 === 'p2')
    ok('applied to session', applied && applied.id === 'id1')

    // onNavFail debounce + reload
    let rotations = 0
    let reloaded = 0
    registerFailoverHandler(async () => {
      rotations++
      return { ok: true }
    })
    const tab = { identityId: 'idX', reload: () => reloaded++ }
    await onNavFail(tab, -100, 'ERR_TUNNEL_CONNECTION_FAILED')
    await new Promise((res) => setTimeout(res, 400))
    ok('nav fail triggers one rotation', rotations === 1)
    ok('tab reloaded after rotation', reloaded === 1)
    // immediate second failure is debounced (cooldown)
    await onNavFail(tab, -100, 'ERR_TUNNEL_CONNECTION_FAILED')
    ok('second failure within cooldown is debounced', rotations === 1)
    // non-proxy error ignored
    await onNavFail({ identityId: 'idY', reload: () => {} }, -6, 'ERR_FILE_NOT_FOUND')
    ok('non-proxy error ignored', rotations === 1)

    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) {
      for (const f of failures) console.log(`  - ${f.label}`)
      process.exit(1)
    }
    process.exit(0)
  })()
}
