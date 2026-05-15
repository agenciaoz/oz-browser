// OZ Browser — Proxy Actions Bulk smoke test (H-2f, v1.1.3).
//
// Cómo correr:
//   cd oz-browser && node tests/proxy-actions-bulk.smoketest.js
//
// Cubre los 5 bulk wrappers de proxy-actions-bulk.js — secuencialidad,
// summary, edge cases (no ids[], items inexistentes, throws).

const { buildProxyActionsBulk } = require('../browser/proxy-actions-bulk')

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

console.log('OZ Browser — proxy-actions-bulk smoke test')

// ============================================================
section('buildProxyActionsBulk requires proxyActions')
// ============================================================
{
  let threw = false
  try {
    buildProxyActionsBulk({})
  } catch (_e) {
    threw = true
  }
  ok('throws when proxyActions missing', threw === true)
}

// ============================================================
section('bulkTestProxies — happy 3 ids all ok')
// ============================================================
;(async () => {
  const calls = []
  const fakeActions = {
    testProxy: async (id) => {
      calls.push(id)
      return { ok: true, result: { latencyMs: 100 } }
    },
  }
  const b = buildProxyActionsBulk({ proxyActions: fakeActions })
  const r = await b.bulkTestProxies(['p1', 'p2', 'p3'])
  ok('top-level ok', r.ok === true)
  ok('calls fired in order', calls.join(',') === 'p1,p2,p3')
  ok('results length 3', r.results.length === 3)
  ok('summary.total === 3', r.summary.total === 3)
  ok('summary.ok === 3', r.summary.ok === 3)
  ok('summary.failed === 0', r.summary.failed === 0)
  ok(
    'each result has id',
    r.results.every((x) => typeof x.id === 'string'),
  )
  ok(
    'each result has ok:true',
    r.results.every((x) => x.ok === true),
  )
})()

// ============================================================
section('bulkTestProxies — 1 fails of 3')
// ============================================================
;(async () => {
  const fakeActions = {
    testProxy: async (id) => {
      if (id === 'p2') return { ok: false, reason: 'TEST_FAILED', message: 'boom' }
      return { ok: true, result: { latencyMs: 50 } }
    },
  }
  const b = buildProxyActionsBulk({ proxyActions: fakeActions })
  const r = await b.bulkTestProxies(['p1', 'p2', 'p3'])
  ok('summary.total === 3', r.summary.total === 3)
  ok('summary.ok === 2', r.summary.ok === 2)
  ok('summary.failed === 1', r.summary.failed === 1)
  ok(
    'p2 has reason preserved',
    r.results.find((x) => x.id === 'p2').reason === 'TEST_FAILED',
  )
})()

// ============================================================
section('bulkTestProxies — empty input → ok:true count 0')
// ============================================================
;(async () => {
  const b = buildProxyActionsBulk({
    proxyActions: { testProxy: async () => ({ ok: true }) },
  })
  const r = await b.bulkTestProxies([])
  ok('ok:true on empty', r.ok === true)
  ok('summary all zero', r.summary.total === 0 && r.summary.ok === 0)
  ok('results empty array', r.results.length === 0)

  const r2 = await b.bulkTestProxies(undefined)
  ok('undefined input defensive', r2.ok === true && r2.summary.total === 0)

  const r3 = await b.bulkTestProxies(null)
  ok('null input defensive', r3.ok === true && r3.summary.total === 0)
})()

// ============================================================
section('bulkResetProxies — sequential, results carry id')
// ============================================================
;(async () => {
  const order = []
  const fakeActions = {
    resetProxy: async (id) => {
      order.push(id)
      return { ok: true, proxyId: id }
    },
  }
  const b = buildProxyActionsBulk({ proxyActions: fakeActions })
  const r = await b.bulkResetProxies(['a', 'b'])
  ok('sequential order preserved', order.join(',') === 'a,b')
  ok('proxyId preserved in result', r.results[0].proxyId === 'a')
  ok(
    'ok:true',
    r.results.every((x) => x.ok === true),
  )
})()

// ============================================================
section('bulkSetDisabled — disabled flag forwarded + idempotent')
// ============================================================
;(async () => {
  const calls = []
  const fakeActions = {
    setDisabled: (id, disabled) => {
      calls.push({ id, disabled })
      return { ok: true, isDisabled: disabled }
    },
  }
  const b = buildProxyActionsBulk({ proxyActions: fakeActions })
  const r1 = await b.bulkSetDisabled(['p1', 'p2'], true)
  ok(
    'flag true forwarded',
    calls.every((c) => c.disabled === true),
  )
  ok('all ok', r1.summary.ok === 2)

  const r2 = await b.bulkSetDisabled(['p1', 'p2'], false)
  ok(
    'flag false forwarded',
    calls.slice(2).every((c) => c.disabled === false),
  )
  ok(
    'idempotent — same call twice in a row',
    r2.summary.ok === 2 && r2.summary.failed === 0,
  )

  // truthy coercion
  const r3 = await b.bulkSetDisabled(['p1'], 1)
  ok('truthy coerces to boolean true', calls[calls.length - 1].disabled === true)
  ok('still ok:true', r3.summary.ok === 1)
})()

// ============================================================
section('bulkDeleteProxies — id inexistente → ok:false en results, summary fail=1')
// ============================================================
;(async () => {
  const fakeActions = {
    deleteProxy: (id) => {
      if (id === 'missing') return { ok: false, reason: 'NOT_FOUND' }
      return { ok: true, proxyId: id }
    },
  }
  const b = buildProxyActionsBulk({ proxyActions: fakeActions })
  const r = await b.bulkDeleteProxies(['p1', 'missing', 'p3'])
  ok('top-level ok', r.ok === true)
  ok('summary.failed === 1', r.summary.failed === 1)
  ok(
    'missing result has reason',
    r.results.find((x) => x.id === 'missing').reason === 'NOT_FOUND',
  )
  ok('p1 + p3 ok', r.summary.ok === 2)
})()

// ============================================================
section('bulkReloadSessions — happy + 1 throws')
// ============================================================
;(async () => {
  const fakeActions = {
    reloadSession: async (id) => {
      if (id === 'boom') throw new Error('session ded')
      return { ok: true, identityId: id, rules: 'direct://' }
    },
  }
  const b = buildProxyActionsBulk({ proxyActions: fakeActions })
  const r = await b.bulkReloadSessions(['i1', 'boom', 'i3'])
  ok('top-level ok', r.ok === true)
  ok('summary.total === 3', r.summary.total === 3)
  ok('summary.failed === 1', r.summary.failed === 1)
  const boomR = r.results.find((x) => x.id === 'boom')
  ok('throw → ok:false', boomR.ok === false)
  ok('throw → reason=THREW', boomR.reason === 'THREW')
  ok('throw → message preserved', /session ded/.test(boomR.message))
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
