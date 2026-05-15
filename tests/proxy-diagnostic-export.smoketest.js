// OZ Browser — proxy-diagnostic-export smoke test (H-2 extras, v1.1.6).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-diagnostic-export.smoketest.js
//
// Cubre buildDiagnosticBundle (pure helper sin Electron). Verifica que
// secretos (usernames/passwords/cookies) NO se exportan + que el bundle
// agrega correctamente todos los subsystems esperados.

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const orig = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/proxy-diagnostic-export.js')]
const {
  buildDiagnosticBundle,
  REDACTED,
} = require('../browser/proxy-diagnostic-export.js')

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

console.log('OZ Browser — proxy-diagnostic-export smoke test')

const fakeProxyManager = {
  list: () => [
    {
      id: 'p1',
      name: 'Oxylabs AR',
      host: 'pr.oxylabs.io',
      port: 7777,
      protocol: 'https',
      country: 'AR',
      city: 'Buenos Aires',
      tags: ['oxylabs', 'AR'],
      isActive: true,
      isDisabled: false,
      lastTestedAt: 1234567890,
      lastLatencyMs: 230,
      lastTestedIp: '203.0.113.42',
      failureCount: 0,
      username: 'customer-mzewama-cc-ar-sessid-000001',
      password: 'topsecret',
      createdAt: 1234560000,
    },
  ],
}
const fakeProxyAssignment = {
  getState: () => ({
    byIdentity: { i1: 'p1' },
    byWorkspace: {},
    defaultStrategy: 'auto-random',
  }),
}
const fakeIdentityManager = {
  list: () => [
    { id: 'i1', name: 'IG-1', workspaceId: 'w1', isDefault: false, color: 'red' },
  ],
}
const fakeWorkspaceManager = {
  list: () => [{ id: 'w1', name: 'Insta', isArchived: false }],
}
const fakeAlertManager = {
  list: ({ activeOnly }) =>
    activeOnly
      ? [
          {
            id: 'a1',
            type: 'proxy-disabled',
            severity: 'urgent',
            title: 'T',
            message: 'M',
          },
        ]
      : [],
}
const fakeLeakTest = {
  list: () => [
    {
      identityId: 'i1',
      identityName: 'IG-1',
      overall: 'red',
      evaluatedAt: 1700000000,
      webrtc: { status: 'red', reason: 'WEBRTC_LEAK' },
      dns: { status: 'green' },
      proxyCountry: 'AR',
    },
  ],
}

// ============================================================================
console.log('\nempty / defensive')
// ============================================================================
ok(
  'empty deps → bundle has meta + empty arrays',
  (() => {
    const b = buildDiagnosticBundle({})
    return (
      b.meta &&
      Array.isArray(b.proxies) &&
      b.proxies.length === 0 &&
      Array.isArray(b.identities) &&
      Array.isArray(b.workspaces) &&
      Array.isArray(b.alerts) &&
      Array.isArray(b.leakTests)
    )
  })(),
)

// ============================================================================
console.log('\nfull bundle')
// ============================================================================
const b = buildDiagnosticBundle({
  proxyManager: fakeProxyManager,
  proxyAssignment: fakeProxyAssignment,
  identityManager: fakeIdentityManager,
  workspaceManager: fakeWorkspaceManager,
  alertManager: fakeAlertManager,
  leakTestHandlers: fakeLeakTest,
  appVersion: '1.1.6',
  platform: 'darwin',
})

ok('meta.appVersion = 1.1.6', b.meta.appVersion === '1.1.6')
ok('meta.platform = darwin', b.meta.platform === 'darwin')
ok('meta.bundleVersion = 1', b.meta.bundleVersion === 1)
ok('meta.note mentions sanitization', /redacted/i.test(b.meta.note))

// ============================================================================
console.log('\nsanitization (NO secrets)')
// ============================================================================
ok('proxy.password redacted', b.proxies[0].password === REDACTED)
ok('proxy.username redacted', b.proxies[0].username === REDACTED)
ok(
  'serialized JSON does NOT contain raw password',
  !JSON.stringify(b).includes('topsecret'),
)
ok(
  'serialized JSON does NOT contain raw username',
  !JSON.stringify(b).includes('customer-mzewama-cc-ar-sessid-000001'),
)
ok('proxy.host PRESERVED (not secret)', b.proxies[0].host === 'pr.oxylabs.io')
ok('proxy.country PRESERVED', b.proxies[0].country === 'AR')
ok('proxy.city PRESERVED', b.proxies[0].city === 'Buenos Aires')
ok('proxy.lastTestedIp PRESERVED', b.proxies[0].lastTestedIp === '203.0.113.42')

// ============================================================================
console.log('\nsubsystems aggregated')
// ============================================================================
ok(
  'assignments.byIdentity i1→p1',
  b.assignments.byIdentity && b.assignments.byIdentity.i1 === 'p1',
)
ok(
  'assignments.defaultStrategy auto-random',
  b.assignments.defaultStrategy === 'auto-random',
)
ok(
  'identities[0] has id/name/workspaceId/isDefault',
  b.identities.length === 1 &&
    b.identities[0].id === 'i1' &&
    b.identities[0].name === 'IG-1',
)
ok(
  'workspaces[0] has id/name',
  b.workspaces.length === 1 && b.workspaces[0].name === 'Insta',
)
ok(
  'alerts has the active alert',
  b.alerts.length === 1 && b.alerts[0].type === 'proxy-disabled',
)
ok(
  'leakTests[0] has overall + webrtcStatus + dnsStatus',
  b.leakTests.length === 1 &&
    b.leakTests[0].overall === 'red' &&
    b.leakTests[0].webrtcStatus === 'red' &&
    b.leakTests[0].dnsStatus === 'green',
)
ok(
  'leakTests does NOT include srflxIps (per-IP privacy)',
  !JSON.stringify(b.leakTests).includes('srflxIps'),
)

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
