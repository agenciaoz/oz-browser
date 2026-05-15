// OZ Browser — Proxy Bulk Assign 1:1 smoke test (H-2h, v1.1.3).
//
// Cómo correr:
//   cd oz-browser && node tests/proxy-bulk-assign.smoketest.js

const { buildProxyBulkAssign } = require('../browser/proxy-bulk-assign')

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

console.log('OZ Browser — proxy-bulk-assign smoke test')

function makePm(proxiesById) {
  return {
    get: (id) => proxiesById[id] || null,
    list: () => Object.values(proxiesById),
    update: () => {},
    remove: () => {},
  }
}

// ============================================================
section('factory requires proxyManager + proxyAssignment')
// ============================================================
{
  let t1 = false
  try {
    buildProxyBulkAssign({})
  } catch (_e) {
    t1 = true
  }
  ok('throws when no proxyManager', t1)
  let t2 = false
  try {
    buildProxyBulkAssign({ proxyManager: makePm({}) })
  } catch (_e) {
    t2 = true
  }
  ok('throws when no proxyAssignment', t2)
}

// ============================================================
section('previewPairing — N===M perfect pairs')
// ============================================================
{
  const pm = makePm({
    p1: { id: 'p1', name: 'Proxy 1', host: 'a', port: 80 },
    p2: { id: 'p2', name: 'Proxy 2', host: 'b', port: 80 },
    p3: { id: 'p3', name: 'Proxy 3', host: 'c', port: 80 },
  })
  const pa = { assignToIdentity: () => {} }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa })
  const r = b.previewPairing(['p1', 'p2', 'p3'], ['i1', 'i2', 'i3'])
  ok('top-level ok', r.ok === true)
  ok('pairings length 3', r.pairings.length === 3)
  ok(
    'pair 1 correct',
    r.pairings[0].proxyId === 'p1' && r.pairings[0].identityId === 'i1',
  )
  ok(
    'pair 2 correct',
    r.pairings[1].proxyId === 'p2' && r.pairings[1].identityId === 'i2',
  )
  ok(
    'pair 3 correct',
    r.pairings[2].proxyId === 'p3' && r.pairings[2].identityId === 'i3',
  )
  ok('proxyName resolved', r.pairings[0].proxyName === 'Proxy 1')
  ok('warning null when N===M', r.warning === null)
  ok('no leftovers', r.leftoverProxies.length === 0 && r.leftoverIdentities.length === 0)
  ok(
    'counts',
    r.counts.proxies === 3 && r.counts.identities === 3 && r.counts.paired === 3,
  )
}

// ============================================================
section('previewPairing — N<M warning + leftoverIdentities populated')
// ============================================================
{
  const pm = makePm({
    p1: { id: 'p1', name: 'P1', host: 'a', port: 80 },
    p2: { id: 'p2', name: 'P2', host: 'b', port: 80 },
  })
  const pa = { assignToIdentity: () => {} }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa })
  const r = b.previewPairing(['p1', 'p2'], ['i1', 'i2', 'i3', 'i4'])
  ok('pairings length 2 (min)', r.pairings.length === 2)
  ok('warning surfaces mismatch', /2 proxies vs 4 identities/.test(r.warning))
  ok('leftoverIdentities populated', r.leftoverIdentities.length === 2)
  ok('leftoverIdentities order', r.leftoverIdentities[0] === 'i3')
  ok('counts', r.counts.proxies === 2 && r.counts.paired === 2)
}

// ============================================================
section('previewPairing — N>M warning + leftoverProxies populated')
// ============================================================
{
  const pm = makePm({
    p1: { id: 'p1', name: 'P1', host: 'a', port: 80 },
    p2: { id: 'p2', name: 'P2', host: 'b', port: 80 },
    p3: { id: 'p3', name: 'P3', host: 'c', port: 80 },
    p4: { id: 'p4', name: 'P4', host: 'd', port: 80 },
  })
  const pa = { assignToIdentity: () => {} }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa })
  const r = b.previewPairing(['p1', 'p2', 'p3', 'p4'], ['i1', 'i2'])
  ok('pairings length 2 (min)', r.pairings.length === 2)
  ok('warning surfaces mismatch', /4 proxies vs 2 identities/.test(r.warning))
  ok('leftoverProxies populated', r.leftoverProxies.length === 2)
  ok('leftoverProxies order', r.leftoverProxies[0] === 'p3')
}

// ============================================================
section('previewPairing — N==0 OR M==0 → empty + ok:true')
// ============================================================
{
  const pm = makePm({})
  const pa = { assignToIdentity: () => {} }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa })
  const r1 = b.previewPairing([], ['i1', 'i2'])
  ok('N=0 → ok', r1.ok === true && r1.pairings.length === 0)
  ok('N=0 → leftoverIdentities populated', r1.leftoverIdentities.length === 2)
  const r2 = b.previewPairing(['p1'], [])
  ok('M=0 → ok', r2.ok === true && r2.pairings.length === 0)
  ok('M=0 → leftoverProxies populated', r2.leftoverProxies.length === 1)
  const r3 = b.previewPairing([], [])
  ok('both 0 → ok + no warning', r3.ok === true && r3.warning === null)

  const r4 = b.previewPairing(null, undefined)
  ok('null/undefined defensive', r4.ok === true && r4.pairings.length === 0)
}

// ============================================================
section('executePairing — happy 3 pairs all ok')
// ============================================================
;(async () => {
  const assignCalls = []
  const reloadCalls = []
  const pm = makePm({})
  const pa = {
    assignToIdentity: (id, val) => assignCalls.push({ id, val }),
  }
  const proxyActions = {
    reloadSession: async (id) => {
      reloadCalls.push(id)
      return { ok: true, identityId: id, rules: 'h:80' }
    },
  }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa, proxyActions })
  const r = await b.executePairing([
    { proxyId: 'p1', identityId: 'i1' },
    { proxyId: 'p2', identityId: 'i2' },
    { proxyId: 'p3', identityId: 'i3' },
  ])
  ok('top-level ok', r.ok === true)
  ok('summary.total === 3', r.summary.total === 3)
  ok('summary.ok === 3', r.summary.ok === 3)
  ok('assignToIdentity called 3x', assignCalls.length === 3)
  ok('first assign correct', assignCalls[0].id === 'i1' && assignCalls[0].val === 'p1')
  ok('reloadSession called 3x', reloadCalls.length === 3)
  ok(
    'each result has sessionReload.ok',
    r.results.every((x) => x.sessionReload.ok === true),
  )
})()

// ============================================================
section('executePairing — assignToIdentity throws → ok:false con reason')
// ============================================================
;(async () => {
  const pm = makePm({})
  const pa = {
    assignToIdentity: (id) => {
      if (id === 'i2') throw new Error('vault locked')
    },
  }
  const proxyActions = {
    reloadSession: async (id) => ({ ok: true, identityId: id }),
  }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa, proxyActions })
  const r = await b.executePairing([
    { proxyId: 'p1', identityId: 'i1' },
    { proxyId: 'p2', identityId: 'i2' },
    { proxyId: 'p3', identityId: 'i3' },
  ])
  ok('top-level ok=false when any fails', r.ok === false)
  ok('summary.failed === 1', r.summary.failed === 1)
  const i2r = r.results.find((x) => x.identityId === 'i2')
  ok('i2 reason ASSIGN_FAILED', i2r.reason === 'ASSIGN_FAILED')
  ok('i2 message preserved', /vault locked/.test(i2r.message))
  ok('i1 and i3 still ok', r.results.find((x) => x.identityId === 'i1').ok === true)
})()

// ============================================================
section('executePairing — reloadSession fails → assignment still ok')
// ============================================================
;(async () => {
  const pm = makePm({})
  const pa = { assignToIdentity: () => {} }
  const proxyActions = {
    reloadSession: async (id) => {
      if (id === 'i2')
        return { ok: false, reason: 'SET_PROXY_FAILED', message: 'session ded' }
      return { ok: true }
    },
  }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa, proxyActions })
  const r = await b.executePairing([
    { proxyId: 'p1', identityId: 'i1' },
    { proxyId: 'p2', identityId: 'i2' },
  ])
  ok('top-level ok=true (assignment is the source of truth)', r.ok === true)
  ok('summary.ok === 2', r.summary.ok === 2)
  const i2r = r.results.find((x) => x.identityId === 'i2')
  ok('i2 assignment still ok', i2r.ok === true)
  ok('i2.sessionReload carries fail detail', i2r.sessionReload.ok === false)
  ok('i2.sessionReload reason preserved', i2r.sessionReload.reason === 'SET_PROXY_FAILED')
})()

// ============================================================
section('executePairing — reloadSession throws → captured + assignment ok')
// ============================================================
;(async () => {
  const pm = makePm({})
  const pa = { assignToIdentity: () => {} }
  const proxyActions = {
    reloadSession: async () => {
      throw new Error('boom')
    },
  }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa, proxyActions })
  const r = await b.executePairing([{ proxyId: 'p1', identityId: 'i1' }])
  ok('top-level ok', r.ok === true)
  ok('result.ok true (assignment ok)', r.results[0].ok === true)
  ok('sessionReload.reason THREW', r.results[0].sessionReload.reason === 'THREW')
  ok('sessionReload.message preserved', /boom/.test(r.results[0].sessionReload.message))
})()

// ============================================================
section('executePairing — bad pair { proxyId: null } skipped')
// ============================================================
;(async () => {
  const pm = makePm({})
  const pa = { assignToIdentity: () => {} }
  const b = buildProxyBulkAssign({ proxyManager: pm, proxyAssignment: pa })
  const r = await b.executePairing([
    { proxyId: 'p1', identityId: 'i1' },
    { proxyId: null, identityId: 'i2' },
    { identityId: 'i3' },
  ])
  ok('top-level ok=false', r.ok === false)
  ok('summary.failed === 2', r.summary.failed === 2)
  ok('summary.ok === 1', r.summary.ok === 1)
  const badPairs = r.results.filter((x) => x.reason === 'BAD_PAIR')
  ok('bad pairs flagged', badPairs.length === 2)
})()

setTimeout(() => {
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
}, 50)
