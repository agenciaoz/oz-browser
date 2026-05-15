// OZ Browser — Proxy Dashboard data aggregator smoke test (v1.1.1).
//
// Cómo correr:
//   cd oz-browser && node tests/proxy-dashboard-data.smoketest.js
//
// Cubre getDashboardData — el snapshot que consume el dashboard tab.

const { getDashboardData } = require('../browser/proxy-dashboard-data')

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

console.log('OZ Browser — proxy-dashboard-data smoke test')

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000

// ============================================================
section('Empty state — no managers')
// ============================================================
{
  const d = getDashboardData({})
  ok('returns object', typeof d === 'object')
  ok('identities = []', Array.isArray(d.identities) && d.identities.length === 0)
  ok('proxies = []', Array.isArray(d.proxies) && d.proxies.length === 0)
  ok('globalStatus is gray', d.globalStatus.status === 'gray')
  ok('capturedAt is ISO string', typeof d.capturedAt === 'string')
}

// ============================================================
section('Full snapshot: 1 proxy + 2 identities + 1 workspace')
// ============================================================
{
  const proxies = [
    {
      id: 'p1',
      name: 'oxy-us',
      label: 'main',
      host: 'us-pr.oxylabs.io',
      port: 10001,
      protocol: 'https',
      country: 'US',
      tags: ['default', 'oxylabs'],
      isActive: true,
      isDisabled: false,
      lastTestedAt: NOW - 5000,
      lastLatencyMs: 465,
      lastTestedIp: '142.91.10.10',
      failureCount: 0,
      bandwidthBytesUsed: 1024,
      createdAt: NOW - DAY_MS,
    },
  ]
  const ids = [
    { id: 'default', name: 'Default', isDefault: true, workspaceId: 'general' },
    { id: 'i1', name: 'Contexto IG', isDefault: false, workspaceId: 'fd9aa34b' },
    { id: 'i2', name: 'El Informe', isDefault: false, workspaceId: '973d22d7' },
  ]
  const wss = [
    { id: 'general', name: 'General Browsing' },
    { id: 'fd9aa34b', name: 'Contextoec' },
    { id: '973d22d7', name: 'El Informe' },
  ]
  const pm = { list: () => proxies }
  const im = { list: () => ids }
  const wm = { list: () => wss }
  const pa = {
    resolve: ({ identityId }) => (identityId === 'i1' ? proxies[0] : null),
  }

  const d = getDashboardData({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
    workspaceManager: wm,
  })

  ok('identities row count = 3', d.identities.length === 3)
  const contexto = d.identities.find((r) => r.name === 'Contexto IG')
  ok('Contexto IG has proxy', contexto && !!contexto.proxy)
  ok('Contexto IG proxy.name = oxy-us', contexto.proxy.name === 'oxy-us')
  ok('Contexto IG workspaceName resolved', contexto.workspaceName === 'Contextoec')
  ok('Contexto IG leakRisk = false', contexto.leakRisk === false)

  const elInforme = d.identities.find((r) => r.name === 'El Informe')
  ok('El Informe leakRisk = true (no proxy)', elInforme.leakRisk === true)
  ok('El Informe proxy = null', elInforme.proxy === null)
  ok('El Informe workspaceName', elInforme.workspaceName === 'El Informe')

  const def = d.identities.find((r) => r.name === 'Default')
  ok('Default isDefault flag', def.isDefault === true)

  ok('proxies row count = 1', d.proxies.length === 1)
  const p = d.proxies[0]
  ok('proxy.usedByCount = 1', p.usedByCount === 1)
  ok('proxy.usedBy[0].name = Contexto IG', p.usedBy[0].name === 'Contexto IG')
  ok('proxy.status = green', p.status === 'green', `got ${p.status}`)
  ok('proxy has lastLatencyMs', p.lastLatencyMs === 465)
  ok('proxy.failureCount = 0', p.failureCount === 0)
  ok('proxy.lastTestedIp preserved', p.lastTestedIp === '142.91.10.10')
}

// ============================================================
section('Proxy disabled → row status red')
// ============================================================
{
  const pm = {
    list: () => [{ id: 'd1', name: 'down', host: 'x.com', port: 80, isDisabled: true }],
  }
  const d = getDashboardData({ proxyManager: pm })
  ok('proxy.status = red', d.proxies[0].status === 'red')
}

// ============================================================
section('Proxy untested → row status yellow')
// ============================================================
{
  const pm = {
    list: () => [
      {
        id: 'd2',
        name: 'untested',
        host: 'x.com',
        port: 80,
        isDisabled: false,
        lastTestedAt: null,
      },
    ],
  }
  const d = getDashboardData({ proxyManager: pm })
  ok('proxy.status = yellow (untested)', d.proxies[0].status === 'yellow')
}

// ============================================================
section('proxyAssignment throw is caught — identity row still rendered')
// ============================================================
{
  const im = {
    list: () => [{ id: 'i1', name: 'X', isDefault: false, workspaceId: 'w' }],
  }
  const pa = {
    resolve: () => {
      throw new Error('boom')
    },
  }
  const pm = { list: () => [] }
  const d = getDashboardData({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
  })
  ok('identity still rendered', d.identities.length === 1)
  ok('leakRisk = true (resolve threw → null)', d.identities[0].leakRisk === true)
}

// ============================================================
section('capturedAt is recent')
// ============================================================
{
  const before = Date.now()
  const d = getDashboardData({ proxyManager: { list: () => [] } })
  const dt = new Date(d.capturedAt).getTime()
  ok(
    'capturedAt within 5s of now',
    Math.abs(dt - before) < 5000,
    `delta=${dt - before}ms`,
  )
}

// ============================================================
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
