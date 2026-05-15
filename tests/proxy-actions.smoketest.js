// OZ Browser — Proxy Actions smoke test (v1.1.2).
//
// Cómo correr:
//   cd oz-browser && node tests/proxy-actions.smoketest.js
//
// Cubre las 7 acciones del dashboard live ops (H-2c + H-2d).

const {
  buildProxyActions,
  _normalizeSessidInUsername,
} = require('../browser/proxy-actions')

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
function section(name) {
  console.log(`\n— ${name} —`)
}

console.log('OZ Browser — proxy-actions smoke test')

// ============================================================
section('_normalizeSessidInUsername edge cases')
// ============================================================
{
  ok(
    'oxylabs format with sessid → rotated',
    /-sessid-[a-z0-9]+/.test(
      _normalizeSessidInUsername('customer-x-cc-us-sessid-old001-sesstime-30'),
    ),
  )
  ok('no sessid → null', _normalizeSessidInUsername('customer-mzewama-cc-us') === null)
  ok('null input → null', _normalizeSessidInUsername(null) === null)
  ok('undefined input → undefined', _normalizeSessidInUsername(undefined) === undefined)
  ok('empty string → empty', _normalizeSessidInUsername('') === '')
  ok('non-string → input passthrough', _normalizeSessidInUsername(123) === 123)
  // Rotation is non-deterministic but format must hold
  const before = 'customer-x-cc-us-sessid-aaa-sesstime-30'
  const after = _normalizeSessidInUsername(before)
  ok(
    'rotation preserves prefix + sesstime',
    after.startsWith('customer-x-cc-us-sessid-') && after.includes('-sesstime-30'),
  )
  ok('rotation changes sessid', after !== before)
}

// ============================================================
section('buildProxyActions requires proxyManager')
// ============================================================
{
  let threw = false
  try {
    buildProxyActions({})
  } catch (e) {
    threw = true
  }
  ok('throws when proxyManager missing', threw === true)
}

// ============================================================
section('testProxy — happy path + no daemon')
// ============================================================
{
  const calls = []
  const pm = { list: () => [], get: () => null, update: () => {}, remove: () => {} }
  const ph = {
    testOne: async (id) => {
      calls.push(id)
      return { ok: true, latencyMs: 100 }
    },
  }
  const a = buildProxyActions({ proxyManager: pm, proxyHealth: ph })
  ;(async () => {
    const r = await a.testProxy('p1')
    ok('testProxy ok', r.ok === true)
    ok('testProxy result preserved', r.result && r.result.latencyMs === 100)
    ok('proxyHealth.testOne called', calls.includes('p1'))

    // No daemon variant
    const a2 = buildProxyActions({ proxyManager: pm })
    const r2 = await a2.testProxy('p1')
    ok('testProxy no daemon = ok:false', r2.ok === false)
    ok('reason = NO_HEALTH_DAEMON', r2.reason === 'NO_HEALTH_DAEMON')

    // testOne throws
    const a3 = buildProxyActions({
      proxyManager: pm,
      proxyHealth: {
        testOne: async () => {
          throw new Error('network down')
        },
      },
    })
    const r3 = await a3.testProxy('p1')
    ok('testProxy throw → ok:false', r3.ok === false)
    ok('reason = TEST_FAILED', r3.reason === 'TEST_FAILED')
    ok('message preserved', /network down/.test(r3.message))
  })()
}

// ============================================================
section('resetProxy — patches manager + re-tests')
// ============================================================
;(async () => {
  const updates = []
  const tests = []
  const pm = {
    get: (id) => (id === 'p1' ? { id: 'p1', failureCount: 5, isDisabled: true } : null),
    update: (id, patch) => updates.push({ id, patch }),
    list: () => [],
    remove: () => {},
  }
  const ph = {
    testOne: async (id) => tests.push(id),
  }
  const a = buildProxyActions({ proxyManager: pm, proxyHealth: ph })
  const r = await a.resetProxy('p1')
  ok('resetProxy ok', r.ok === true)
  ok('update patch has failureCount=0', updates[0].patch.failureCount === 0)
  ok('update patch has isDisabled=false', updates[0].patch.isDisabled === false)
  ok('update patch has lastTestedAt=null', updates[0].patch.lastTestedAt === null)
  ok('re-test fired', tests.includes('p1'))

  // Not found
  const r2 = await a.resetProxy('missing')
  ok('not found → ok:false', r2.ok === false)
  ok('reason = NOT_FOUND', r2.reason === 'NOT_FOUND')
})()

// ============================================================
section('setDisabled toggle')
// ============================================================
{
  const updates = []
  const pm = {
    get: (id) => (id === 'p1' ? { id: 'p1' } : null),
    update: (id, patch) => updates.push({ id, patch }),
    list: () => [],
    remove: () => {},
  }
  const a = buildProxyActions({ proxyManager: pm })
  const r1 = a.setDisabled('p1', true)
  ok('setDisabled true ok', r1.ok === true)
  ok('isDisabled returned true', r1.isDisabled === true)
  ok('update patch isDisabled=true', updates[0].patch.isDisabled === true)

  const r2 = a.setDisabled('p1', false)
  ok('setDisabled false ok', r2.ok === true)
  ok('update patch isDisabled=false', updates[1].patch.isDisabled === false)

  const r3 = a.setDisabled('missing', true)
  ok('not found', r3.ok === false && r3.reason === 'NOT_FOUND')
}

// ============================================================
section('rotateSticky — happy + non-sticky')
// ============================================================
{
  const updates = []
  const pm = {
    get: (id) => {
      if (id === 'p1')
        return { id: 'p1', username: 'customer-x-cc-us-sessid-aaa-sesstime-30' }
      if (id === 'p2') return { id: 'p2', username: 'customer-x-cc-us' }
      return null
    },
    update: (id, patch) => updates.push({ id, patch }),
    list: () => [],
    remove: () => {},
  }
  const a = buildProxyActions({ proxyManager: pm })

  const r1 = a.rotateSticky('p1')
  ok('rotateSticky sticky ok', r1.ok === true)
  ok('newUsername has new sessid', /-sessid-[a-z0-9]+-sesstime-30/.test(r1.newUsername))
  ok('update fired with new username', updates[0].patch.username === r1.newUsername)

  const r2 = a.rotateSticky('p2')
  ok('rotateSticky non-sticky → ok:false', r2.ok === false)
  ok('reason = NOT_STICKY', r2.reason === 'NOT_STICKY')

  const r3 = a.rotateSticky('missing')
  ok('rotateSticky missing → NOT_FOUND', r3.reason === 'NOT_FOUND')
}

// ============================================================
section('deleteProxy — clears assignments + removes')
// ============================================================
{
  const cleared = []
  const removed = []
  const pm = {
    get: (id) => (id === 'p1' ? { id: 'p1' } : null),
    update: () => {},
    list: () => [],
    remove: (id) => removed.push(id),
  }
  const pa = { clearByProxyId: (id) => cleared.push(id) }
  const a = buildProxyActions({ proxyManager: pm, proxyAssignment: pa })

  const r1 = a.deleteProxy('p1')
  ok('deleteProxy ok', r1.ok === true)
  ok('clearByProxyId called', cleared.includes('p1'))
  ok('proxyManager.remove called', removed.includes('p1'))

  const r2 = a.deleteProxy('missing')
  ok('missing → NOT_FOUND', r2.reason === 'NOT_FOUND')
}

// ============================================================
section('reloadSession — happy + edge cases')
// ============================================================
;(async () => {
  const proxyCalls = []
  const setProxy = async (cfg) => proxyCalls.push(cfg)
  const ses = { setProxy }
  const im = {
    get: (id) => (id === 'i1' ? { id: 'i1', workspaceId: 'w' } : null),
    getSession: () => ses,
  }
  const proxy = {
    id: 'p1',
    host: 'us.oxylabs.io',
    port: 10001,
    protocol: 'https',
  }
  const pa = { resolve: () => proxy }
  const a = buildProxyActions({
    proxyManager: { list: () => [], get: () => null, update: () => {}, remove: () => {} },
    proxyAssignment: pa,
    identityManager: im,
    toProxyRulesString: (p) => `${p.host}:${p.port}`,
  })

  const r = await a.reloadSession('i1')
  ok('reloadSession ok', r.ok === true)
  ok('setProxy called with rules', proxyCalls[0].proxyRules === 'us.oxylabs.io:10001')
  ok('returns proxyId', r.proxyId === 'p1')

  // Identity not found
  const r2 = await a.reloadSession('missing')
  ok('missing identity', r2.ok === false && r2.reason === 'NOT_FOUND')

  // No proxy assigned → direct://
  const a2 = buildProxyActions({
    proxyManager: { list: () => [], get: () => null, update: () => {}, remove: () => {} },
    proxyAssignment: { resolve: () => null },
    identityManager: im,
    toProxyRulesString: () => 'direct://',
  })
  const r3 = await a2.reloadSession('i1')
  ok('no proxy → setProxy direct://', r3.ok === true && r3.rules === 'direct://')

  // setProxy throws
  const a3 = buildProxyActions({
    proxyManager: { list: () => [], get: () => null, update: () => {}, remove: () => {} },
    proxyAssignment: pa,
    identityManager: {
      get: (id) => ({ id, workspaceId: 'w' }),
      getSession: () => ({
        setProxy: async () => {
          throw new Error('boom')
        },
      }),
    },
    toProxyRulesString: (p) => `${p.host}:${p.port}`,
  })
  const r4 = await a3.reloadSession('i1')
  ok('setProxy throw → ok:false', r4.ok === false)
  ok('reason = SET_PROXY_FAILED', r4.reason === 'SET_PROXY_FAILED')
})()

// ============================================================
section('reassignProxy — updates assignment + cascades reload')
// ============================================================
;(async () => {
  const assignmentCalls = []
  const setProxy = async () => {}
  const im = {
    get: () => ({ id: 'i1', workspaceId: 'w' }),
    getSession: () => ({ setProxy }),
  }
  const pa = {
    assignToIdentity: (id, val) => assignmentCalls.push({ id, val }),
    resolve: () => ({ id: 'pX', host: 'h', port: 1, protocol: 'https' }),
  }
  const a = buildProxyActions({
    proxyManager: { list: () => [], get: () => null, update: () => {}, remove: () => {} },
    proxyAssignment: pa,
    identityManager: im,
    toProxyRulesString: () => 'h:1',
  })

  const r = await a.reassignProxy('i1', 'pX')
  ok('reassign ok', r.ok === true)
  ok(
    'assignToIdentity called',
    assignmentCalls[0].id === 'i1' && assignmentCalls[0].val === 'pX',
  )
  ok('cascade reloadSession returned', r.sessionReload && r.sessionReload.ok === true)

  // No proxyAssignment
  const a2 = buildProxyActions({
    proxyManager: { list: () => [], get: () => null, update: () => {}, remove: () => {} },
    identityManager: im,
  })
  const r2 = await a2.reassignProxy('i1', 'pX')
  ok('no assignment mgr → ok:false', r2.ok === false)
  ok('reason = NO_ASSIGNMENT_MGR', r2.reason === 'NO_ASSIGNMENT_MGR')
})()

// Allow async tests to complete then summarize.
setTimeout(() => {
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
}, 100)
