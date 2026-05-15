// OZ Browser — proxy-dashboard-health UI helpers smoke test (H-2i, v1.1.4).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-dashboard-health.smoketest.js
//
// El módulo browser/ui/proxy-dashboard-health.js es UI (IIFE que attacha a
// window). Lo evaluamos via vm con un fake window/document/oz para testear
// las funciones puras: deriveStatus, buildStatusSummary, renderFixButton.
// fetchHealthMap + subscribeChanged se cubren indirectamente en el smoke
// visual end-to-end (regla feedback_smoke_visual_bugs).

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(
  path.join(__dirname, '../browser/ui/proxy-dashboard-health.js'),
  'utf8',
)

const fakeWindow = {}
const ctx = { window: fakeWindow }
vm.createContext(ctx)
vm.runInContext(src, ctx)

const api = ctx.window.OZ_DashboardHealth

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
// Match the real esc() in proxy-dashboard.js — HTML-entity-encodes &<>.
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

console.log('OZ Browser — proxy-dashboard-health smoke test')

ok('exports OZ_DashboardHealth', !!api && typeof api === 'object')
ok(
  'exports fetchHealthMap/deriveStatus/buildStatusSummary/renderFixButton/subscribeChanged',
  typeof api.fetchHealthMap === 'function' &&
    typeof api.deriveStatus === 'function' &&
    typeof api.buildStatusSummary === 'function' &&
    typeof api.renderFixButton === 'function' &&
    typeof api.subscribeChanged === 'function',
)

// ============================================================================
console.log('\nderiveStatus')
// ============================================================================

ok(
  'non-default identity without proxy → red (leak risk wins)',
  api.deriveStatus({ isDefault: false, proxy: null }, null) === 'red',
)

ok(
  'no healthRecord + has proxy → green (legacy fallback)',
  api.deriveStatus({ isDefault: false, proxy: { id: 'p1' } }, null) === 'green',
)

ok(
  'no healthRecord + default identity → gray (legacy fallback)',
  api.deriveStatus({ isDefault: true, proxy: null }, null) === 'gray',
)

ok(
  'healthRecord.overall=green → green',
  api.deriveStatus({ isDefault: false, proxy: { id: 'p1' } }, { overall: 'green' }) ===
    'green',
)

ok(
  'healthRecord.overall=yellow → yellow',
  api.deriveStatus({ isDefault: false, proxy: { id: 'p1' } }, { overall: 'yellow' }) ===
    'yellow',
)

ok(
  'healthRecord.overall=red → red',
  api.deriveStatus({ isDefault: false, proxy: { id: 'p1' } }, { overall: 'red' }) ===
    'red',
)

ok(
  'non-default no-proxy + green healthRecord → red still (leak risk wins)',
  api.deriveStatus({ isDefault: false, proxy: null }, { overall: 'green' }) === 'red',
)

// ============================================================================
console.log('\nbuildStatusSummary')
// ============================================================================

ok('null healthRecord → null', api.buildStatusSummary(null, t) === null)

ok(
  'all green → null (no problem to surface)',
  api.buildStatusSummary(
    {
      vectors: {
        ipTimezone: { status: 'green', summary: 'OK' },
        fingerprintCoherence: { status: 'green' },
        cookieHealth: { status: 'green' },
        proxyReachability: { status: 'green' },
      },
    },
    t,
  ) === null,
)

ok(
  'yellow ipTimezone → summary contains TZ label',
  (() => {
    const s = api.buildStatusSummary(
      {
        vectors: {
          ipTimezone: { status: 'yellow', summary: 'TZ off-by-1 hour' },
          fingerprintCoherence: { status: 'green' },
          cookieHealth: { status: 'green' },
          proxyReachability: { status: 'green' },
        },
      },
      t,
    )
    return (
      typeof s === 'string' &&
      s.includes('Timezone vs proxy') &&
      s.includes('TZ off-by-1 hour')
    )
  })(),
)

ok(
  'multiple problems → returns the WORST (red wins yellow)',
  (() => {
    const s = api.buildStatusSummary(
      {
        vectors: {
          ipTimezone: { status: 'yellow', summary: 'soft mismatch' },
          fingerprintCoherence: { status: 'red', summary: 'platform vs UA' },
          cookieHealth: { status: 'yellow' },
          proxyReachability: { status: 'green' },
        },
      },
      t,
    )
    return (
      typeof s === 'string' &&
      s.includes('Fingerprint coherence') &&
      s.includes('platform vs UA')
    )
  })(),
)

// ============================================================================
console.log('\nrenderFixButton')
// ============================================================================

ok(
  'no healthRecord → empty string',
  api.renderFixButton({ id: 'i1', isDefault: false }, null, t, esc) === '',
)

ok(
  'default identity → empty string even with fix available',
  api.renderFixButton(
    { id: 'i1', isDefault: true },
    {
      vectors: {
        ipTimezone: {
          status: 'red',
          fix: { kind: 'apply-geo-suggestion', label: 'Apply' },
        },
      },
    },
    t,
    esc,
  ) === '',
)

ok(
  'ipTimezone fix kind apply-geo-suggestion → button with data-act',
  (() => {
    const html = api.renderFixButton(
      { id: 'ident-abc', isDefault: false },
      {
        vectors: {
          ipTimezone: {
            status: 'red',
            fix: { kind: 'apply-geo-suggestion', label: 'Apply BR' },
          },
        },
      },
      t,
      esc,
    )
    return (
      typeof html === 'string' &&
      html.includes('data-act="apply-geo-fix"') &&
      html.includes('data-id="ident-abc"') &&
      html.includes('Apply BR') &&
      html.includes('Apply geo')
    )
  })(),
)

ok(
  'different fix kind → empty (only APPLY_GEO surfaces inline)',
  api.renderFixButton(
    { id: 'i1', isDefault: false },
    {
      vectors: {
        ipTimezone: {
          status: 'red',
          fix: { kind: 'reroll-fingerprint', label: 'Reroll' },
        },
      },
    },
    t,
    esc,
  ) === '',
)

ok(
  'fix label is HTML-escaped',
  (() => {
    const html = api.renderFixButton(
      { id: 'i1', isDefault: false },
      {
        vectors: {
          ipTimezone: {
            status: 'red',
            fix: { kind: 'apply-geo-suggestion', label: '<script>x</script>' },
          },
        },
      },
      t,
      esc,
    )
    return typeof html === 'string' && !html.includes('<script>')
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
