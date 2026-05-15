// OZ Browser — proxy-dashboard-leaks UI helpers smoke test (H-2j, v1.1.4).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-dashboard-leaks.smoketest.js
//
// Cubre las funciones puras del módulo UI (IIFE evaluado via vm): render
// helpers + format dialog. fetchLeakMap / runLeakTest / subscribeChanged
// se cubren indirectamente en smoke visual end-to-end (esos paths
// requieren el bridge real window.oz.leakTest.*).

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(
  path.join(__dirname, '../browser/ui/proxy-dashboard-leaks.js'),
  'utf8',
)

const fakeWindow = {}
const ctx = { window: fakeWindow }
vm.createContext(ctx)
vm.runInContext(src, ctx)

const api = ctx.window.OZ_DashboardLeaks

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
const t = (key, fallback) => fallback || key
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

console.log('OZ Browser — proxy-dashboard-leaks smoke test')

ok('exports OZ_DashboardLeaks', !!api && typeof api === 'object')
ok(
  'exports fetchLeakMap/renderLeakButton/runLeakTest/subscribeChanged/formatResultDialog/buildLeakSummary',
  typeof api.fetchLeakMap === 'function' &&
    typeof api.renderLeakButton === 'function' &&
    typeof api.runLeakTest === 'function' &&
    typeof api.subscribeChanged === 'function' &&
    typeof api.formatResultDialog === 'function' &&
    typeof api.buildLeakSummary === 'function',
)

// ============================================================================
console.log('\nrenderLeakButton')
// ============================================================================

ok(
  'default identity → empty string (no proxy to test)',
  api.renderLeakButton({ id: 'i1', isDefault: true }, null, t, esc) === '',
)

ok(
  'no cached record → button without badge',
  (() => {
    const html = api.renderLeakButton({ id: 'i1', isDefault: false }, null, t, esc)
    return (
      typeof html === 'string' &&
      html.includes('data-act="run-leak-test"') &&
      html.includes('data-id="i1"') &&
      html.includes('Leak test') &&
      !html.includes('class="pill"')
    )
  })(),
)

ok(
  'cached green record → button with green pill badge',
  (() => {
    const html = api.renderLeakButton(
      { id: 'i1', isDefault: false },
      {
        overall: 'green',
        webrtc: { status: 'green', summary: 'OK' },
        dns: { status: 'green', summary: 'OK' },
      },
      t,
      esc,
    )
    return (
      typeof html === 'string' &&
      html.includes('class="pill"') &&
      html.includes('data-status="green"')
    )
  })(),
)

ok(
  'cached red record → button with red pill badge',
  (() => {
    const html = api.renderLeakButton(
      { id: 'i1', isDefault: false },
      {
        overall: 'red',
        webrtc: { status: 'red', summary: 'WebRTC leak' },
        dns: { status: 'green' },
      },
      t,
      esc,
    )
    return html.includes('data-status="red"')
  })(),
)

ok(
  'identityId HTML-escaped',
  (() => {
    const html = api.renderLeakButton(
      { id: '<i>bad</i>', isDefault: false },
      null,
      t,
      esc,
    )
    return !html.includes('<i>bad</i>') && html.includes('&lt;i&gt;')
  })(),
)

// ============================================================================
console.log('\nbuildLeakSummary')
// ============================================================================

ok('null record → empty string', api.buildLeakSummary(null, t) === '')

ok(
  'record with both webrtc + dns → multi-line summary',
  (() => {
    const s = api.buildLeakSummary(
      {
        webrtc: { status: 'green', summary: 'WebRTC srflx matches' },
        dns: { status: 'red', summary: 'IP mismatch detected' },
      },
      t,
    )
    return (
      typeof s === 'string' &&
      s.includes('WebRTC') &&
      s.includes('DNS') &&
      s.includes('IP mismatch detected')
    )
  })(),
)

// ============================================================================
console.log('\nformatResultDialog')
// ============================================================================

ok(
  'null record → no-result label',
  (() => {
    const out = api.formatResultDialog(null, t)
    return typeof out === 'string' && out.includes('No result.')
  })(),
)

ok(
  '__error record → error label + message',
  (() => {
    const out = api.formatResultDialog(
      { __error: { code: 'X', message: 'something broke' } },
      t,
    )
    return out.includes('Leak test failed') && out.includes('something broke')
  })(),
)

ok(
  'full record → multi-line with overall + proxy + srflx + detected IP',
  (() => {
    const out = api.formatResultDialog(
      {
        identityName: 'IG-test',
        overall: 'red',
        proxyName: 'Oxy-AR-1',
        proxyCountry: 'AR',
        proxyPublicIp: '203.0.113.42',
        webrtc: {
          status: 'red',
          summary: 'WebRTC leak',
          srflxIps: ['198.51.100.7'],
          leakedIps: ['198.51.100.7'],
        },
        dns: {
          status: 'green',
          summary: 'IP and country match',
          detectedIp: '203.0.113.42',
          detectedCountry: 'AR',
        },
      },
      t,
    )
    return (
      out.includes('IG-test') &&
      out.includes('red') &&
      out.includes('Oxy-AR-1') &&
      out.includes('AR') &&
      out.includes('203.0.113.42') &&
      out.includes('198.51.100.7') &&
      out.includes('WebRTC leak') &&
      out.includes('IP and country match')
    )
  })(),
)

// ============================================================================
// SUMMARY
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
