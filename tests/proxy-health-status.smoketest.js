// OZ Browser — Proxy Health Status aggregator smoke test (v1.1.1).
//
// Cómo correr:
//   cd oz-browser && node tests/proxy-health-status.smoketest.js
//
// Cubre el decision tree del badge global: gray / green / yellow / red según
// el state agregado de proxies + assignments + identities.

const { computeGlobalStatus } = require('../browser/proxy-health-status')

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

console.log('OZ Browser — proxy-health-status smoke test')

// Helpers
const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const fakePM = (proxies) => ({ list: () => proxies })
const fakeIM = (identities) => ({ list: () => identities })
const fakePA = (resolutions) => ({
  resolve: ({ identityId }) => resolutions[identityId] || null,
})

// ============================================================
section('Empty pool')
// ============================================================
{
  const s = computeGlobalStatus({ proxyManager: fakePM([]) })
  ok('status = gray', s.status === 'gray')
  ok('total = 0', s.counts.total === 0)
  ok('hint mentions no proxies', /no proxies/i.test(s.hint))
}

// ============================================================
section('Single healthy proxy, no identities')
// ============================================================
{
  const pm = fakePM([{ id: 'a', isDisabled: false, lastTestedAt: NOW, failureCount: 0 }])
  const s = computeGlobalStatus({ proxyManager: pm })
  ok('status = green', s.status === 'green', `got ${s.status}`)
  ok('ok = 1', s.counts.ok === 1)
  ok('fail = 0', s.counts.fail === 0)
}

// ============================================================
section('Single disabled proxy')
// ============================================================
{
  const pm = fakePM([{ id: 'b', isDisabled: true }])
  const s = computeGlobalStatus({ proxyManager: pm })
  ok('status = red', s.status === 'red')
  ok('disabled count = 1', s.counts.disabled === 1)
}

// ============================================================
section('Untested proxy')
// ============================================================
{
  const pm = fakePM([{ id: 'c', isDisabled: false, lastTestedAt: null }])
  const s = computeGlobalStatus({ proxyManager: pm })
  ok('status = yellow', s.status === 'yellow', `got ${s.status}`)
  ok('untested = 1', s.counts.untested === 1)
}

// ============================================================
section('Stale proxy (>24h since last test)')
// ============================================================
{
  const pm = fakePM([
    { id: 'd', isDisabled: false, lastTestedAt: NOW - 2 * DAY, failureCount: 0 },
  ])
  const s = computeGlobalStatus({ proxyManager: pm })
  ok('status = yellow (stale)', s.status === 'yellow')
  ok('stale count = 1', s.counts.stale === 1)
}

// ============================================================
section('Proxy with failures')
// ============================================================
{
  const pm = fakePM([
    { id: 'e', isDisabled: false, lastTestedAt: NOW - 60000, failureCount: 2 },
  ])
  const s = computeGlobalStatus({ proxyManager: pm })
  ok('status = yellow (failures)', s.status === 'yellow')
  ok('fail count = 1', s.counts.fail === 1)
}

// ============================================================
section('Mixed: healthy + identity with no proxy = red (leak risk)')
// ============================================================
{
  const pm = fakePM([{ id: 'f', isDisabled: false, lastTestedAt: NOW, failureCount: 0 }])
  const pa = fakePA({ i1: { id: 'f' } }) // i1 has proxy, i2 doesn't
  const im = fakeIM([
    { id: 'default', isDefault: true },
    { id: 'i1', isDefault: false },
    { id: 'i2', isDefault: false }, // unassigned
  ])
  const s = computeGlobalStatus({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
  })
  ok('status = red (1 identity unassigned)', s.status === 'red', `got ${s.status}`)
  ok('unassigned = 1', s.counts.unassigned === 1)
  ok('identitiesWithProxy = 1', s.counts.identitiesWithProxy === 1)
  ok('identities total = 3', s.counts.identities === 3)
  ok('hint mentions leak', /no proxy|using real IP/i.test(s.hint))
}

// ============================================================
section('Single non-default identity unassigned does NOT trigger red')
// ============================================================
{
  // Edge case: only 1 identity besides default, unassigned. Heuristic
  // requires identities.length > 1 to flag red.
  const pm = fakePM([{ id: 'g', isDisabled: false, lastTestedAt: NOW, failureCount: 0 }])
  const pa = fakePA({}) // nobody resolved
  const im = fakeIM([{ id: 'default', isDefault: true }])
  const s = computeGlobalStatus({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
  })
  // Default-only → no leak concern. green.
  ok('status = green (only default)', s.status === 'green', `got ${s.status}`)
}

// ============================================================
section('All-clear: 3 identities all assigned, 1 healthy proxy')
// ============================================================
{
  const pm = fakePM([{ id: 'h', isDisabled: false, lastTestedAt: NOW, failureCount: 0 }])
  const pa = fakePA({ i1: { id: 'h' }, i2: { id: 'h' }, i3: { id: 'h' } })
  const im = fakeIM([
    { id: 'default', isDefault: true },
    { id: 'i1', isDefault: false },
    { id: 'i2', isDefault: false },
    { id: 'i3', isDefault: false },
  ])
  const s = computeGlobalStatus({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
  })
  ok('status = green', s.status === 'green', `got ${s.status}`)
  ok('identitiesWithProxy = 3', s.counts.identitiesWithProxy === 3)
  ok('unassigned = 0', s.counts.unassigned === 0)
}

// ============================================================
section('lastTestedAt aggregation = max across pool')
// ============================================================
{
  const t1 = NOW - 60000
  const t2 = NOW - 1000
  const pm = fakePM([
    { id: 'i', isDisabled: false, lastTestedAt: t1, failureCount: 0 },
    { id: 'j', isDisabled: false, lastTestedAt: t2, failureCount: 0 },
  ])
  const s = computeGlobalStatus({ proxyManager: pm })
  ok('lastTestedAt = most recent', s.lastTestedAt === t2, `got ${s.lastTestedAt}`)
}

// ============================================================
section('Defensive: no proxyManager → gray')
// ============================================================
{
  const s = computeGlobalStatus({})
  ok('status = gray', s.status === 'gray')
}

// ============================================================
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
