// OZ Browser — anti-detect-health smoke test (E2-C-6).
//
// Cómo correr:
//   cd oz-browser
//   node tests/anti-detect-health.smoketest.js
//
// Cubre los 4 vectores y la composición top-level. Toda la lógica pura
// (sin Electron, sin fs) — los handlers se testean indirectamente via las
// validaciones de schema.

const path = require('path')
const Module = require('module')

// anti-detect-health.js → require('./country-locale') → no electron deps.
// Pero el patrón estándar del repo intercepta electron por las dudas.
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

delete require.cache[require.resolve('../browser/anti-detect-health.js')]
delete require.cache[require.resolve('../browser/country-locale.js')]
const {
  evaluateHealth,
  evaluateIpTimezone,
  evaluateFingerprintCoherence,
  evaluateCookieHealth,
  evaluateProxyReachability,
  STATUSES,
  FIX_KINDS,
  PROXY_STALE_MS,
} = require('../browser/anti-detect-health.js')

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

console.log('OZ Browser — anti-detect-health smoke test')

// ---- Helpers ---------------------------------------------------------------

const NOW = 1_700_000_000_000 // 2023-11-14, fixed for determinism
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function fpMacEnUS(extra = {}) {
  return {
    blueprintId: 'mac-arm64-chrome-135',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135',
    platform: 'MacIntel',
    timezone: 'America/New_York',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, Apple M2)',
    },
    screen: { width: 1512, height: 982, colorDepth: 30 },
    ...extra,
  }
}

function fpWinEnUS(extra = {}) {
  return {
    blueprintId: 'win-x64-chrome-135',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135',
    platform: 'Win32',
    timezone: 'America/New_York',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 D3D11)',
    },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    ...extra,
  }
}

function makeProxy(extra = {}) {
  return {
    id: 'proxy-1',
    name: 'oxylabs-us-pr',
    host: 'us-pr.oxylabs.io',
    port: 10001,
    protocol: 'https',
    country: 'US',
    isActive: true,
    isDisabled: false,
    failureCount: 0,
    lastTestedAt: NOW - HOUR, // 1h ago — fresh
    lastLatencyMs: 220,
    ...extra,
  }
}

function identity(extra = {}) {
  return { id: 'ident-1', name: 'Cliente A', color: '#5b8def', ...extra }
}

// ============================================================================
// VECTOR 1 — IP ↔ timezone match
// ============================================================================
section('evaluateIpTimezone')

ok(
  'no proxy → unknown',
  evaluateIpTimezone({ proxy: null, fingerprint: fpMacEnUS() }).status ===
    STATUSES.UNKNOWN,
)
ok(
  'no fingerprint → unknown',
  evaluateIpTimezone({ proxy: makeProxy(), fingerprint: null }).status ===
    STATUSES.UNKNOWN,
)
ok(
  'proxy without country → unknown',
  evaluateIpTimezone({
    proxy: makeProxy({ country: null }),
    fingerprint: fpMacEnUS(),
  }).status === STATUSES.UNKNOWN,
)
ok(
  'unknown country code → unknown',
  evaluateIpTimezone({
    proxy: makeProxy({ country: 'XX' }),
    fingerprint: fpMacEnUS(),
  }).status === STATUSES.UNKNOWN,
)
ok(
  'exact timezone match (US ↔ America/New_York) → green',
  evaluateIpTimezone({ proxy: makeProxy(), fingerprint: fpMacEnUS() }).status ===
    STATUSES.GREEN,
)

const yellowResult = evaluateIpTimezone({
  proxy: makeProxy({ country: 'AR' }),
  fingerprint: fpMacEnUS({ timezone: 'America/New_York' }),
})
ok(
  'AR proxy + America/New_York → yellow (same continent prefix America)',
  yellowResult.status === STATUSES.YELLOW,
)
ok(
  'yellow row carries APPLY_GEO fix',
  yellowResult.fix && yellowResult.fix.kind === FIX_KINDS.APPLY_GEO,
)

const redResult = evaluateIpTimezone({
  proxy: makeProxy({ country: 'JP' }),
  fingerprint: fpMacEnUS({ timezone: 'Europe/Madrid' }),
})
ok(
  'JP proxy + Europe/Madrid → red (different continent)',
  redResult.status === STATUSES.RED,
)
ok(
  'red row carries APPLY_GEO fix',
  redResult.fix && redResult.fix.kind === FIX_KINDS.APPLY_GEO,
)

// ============================================================================
// VECTOR 2 — Fingerprint coherence
// ============================================================================
section('evaluateFingerprintCoherence')

ok(
  'no fingerprint → unknown',
  evaluateFingerprintCoherence({ fingerprint: null }).status === STATUSES.UNKNOWN,
)
ok(
  'mac+mac UA + Apple GPU → green',
  evaluateFingerprintCoherence({ fingerprint: fpMacEnUS() }).status === STATUSES.GREEN,
)
ok(
  'win+win UA + NVIDIA GPU → green',
  evaluateFingerprintCoherence({ fingerprint: fpWinEnUS() }).status === STATUSES.GREEN,
)

const platformUaMismatch = evaluateFingerprintCoherence({
  fingerprint: fpMacEnUS({ ua: 'Mozilla/5.0 (Windows NT 10.0)' }),
})
ok('platform=Mac but UA=Windows → red', platformUaMismatch.status === STATUSES.RED)
ok(
  'platform/UA mismatch carries REROLL_FP fix',
  platformUaMismatch.fix && platformUaMismatch.fix.kind === FIX_KINDS.REROLL_FP,
)

const webglMismatch = evaluateFingerprintCoherence({
  fingerprint: fpWinEnUS({
    webgl: { vendor: 'Apple Inc.', renderer: 'ANGLE (Apple, Apple M2)' },
  }),
})
ok('Win platform + Apple Metal renderer → red', webglMismatch.status === STATUSES.RED)

const localeLangMismatch = evaluateFingerprintCoherence({
  fingerprint: fpMacEnUS({ locale: 'es-ES', languages: ['en-US', 'en'] }),
})
ok(
  'locale=es-ES but languages[0]=en-US → yellow (soft signal)',
  localeLangMismatch.status === STATUSES.YELLOW,
)

const multipleIssues = evaluateFingerprintCoherence({
  fingerprint: fpMacEnUS({
    ua: 'Windows blah',
    locale: 'es-ES',
    languages: ['en-US', 'en'],
  }),
})
ok(
  'multiple issues with at least one red → red wins',
  multipleIssues.status === STATUSES.RED,
)

// ============================================================================
// VECTOR 3 — Cookie health
// ============================================================================
section('evaluateCookieHealth')

ok(
  'cookies = null → unknown',
  evaluateCookieHealth({ cookies: null, now: NOW }).status === STATUSES.UNKNOWN,
)
ok(
  'cookies = [] → unknown',
  evaluateCookieHealth({ cookies: [], now: NOW }).status === STATUSES.UNKNOWN,
)

const allSession = [
  { name: 'a', session: true },
  { name: 'b', session: true },
]
ok(
  'all session cookies → green',
  evaluateCookieHealth({ cookies: allSession, now: NOW }).status === STATUSES.GREEN,
)

const allActive = [
  { name: 'a', expirationDate: NOW / 1000 + 86400 * 30 },
  { name: 'b', expirationDate: NOW / 1000 + 86400 * 30 },
]
ok(
  'all active persistent → green',
  evaluateCookieHealth({ cookies: allActive, now: NOW }).status === STATUSES.GREEN,
)

const someExpired = [
  { name: 'a', expirationDate: NOW / 1000 + 86400 },
  { name: 'b', expirationDate: NOW / 1000 + 86400 },
  { name: 'c', expirationDate: NOW / 1000 + 86400 },
  { name: 'd', expirationDate: NOW / 1000 - 86400 }, // expired (25%)
]
ok(
  '25% expired → yellow',
  evaluateCookieHealth({ cookies: someExpired, now: NOW }).status === STATUSES.YELLOW,
)

const lotsExpired = [
  { name: 'a', expirationDate: NOW / 1000 - 86400 },
  { name: 'b', expirationDate: NOW / 1000 - 86400 },
  { name: 'c', expirationDate: NOW / 1000 - 86400 },
  { name: 'd', expirationDate: NOW / 1000 + 86400 },
]
const redCookies = evaluateCookieHealth({ cookies: lotsExpired, now: NOW })
ok('75% expired → red', redCookies.status === STATUSES.RED)
ok(
  'red cookies carries MARK_RELOGIN fix',
  redCookies.fix && redCookies.fix.kind === FIX_KINDS.MARK_RELOGIN,
)

const mixed = [
  { name: 'sess', session: true },
  { name: 'a', expirationDate: NOW / 1000 + 86400 },
  { name: 'b', expirationDate: NOW / 1000 - 1 },
]
const mixedRes = evaluateCookieHealth({ cookies: mixed, now: NOW })
ok(
  'mixed: session + 1 active + 1 expired → 50% expired (1/2 persistent) → red',
  mixedRes.status === STATUSES.RED,
)
ok(
  'mixed details surface counts',
  mixedRes.details.session === 1 &&
    mixedRes.details.active === 1 &&
    mixedRes.details.expired === 1,
)

// ============================================================================
// VECTOR 4 — Proxy reachability
// ============================================================================
section('evaluateProxyReachability')

ok(
  'no proxy → unknown (direct connection is OK)',
  evaluateProxyReachability({ proxy: null, now: NOW }).status === STATUSES.UNKNOWN,
)

const disabled = evaluateProxyReachability({
  proxy: makeProxy({ isDisabled: true, failureCount: 4 }),
  now: NOW,
})
ok('isDisabled → red', disabled.status === STATUSES.RED)
ok(
  'disabled has REASSIGN_PROXY fix',
  disabled.fix && disabled.fix.kind === FIX_KINDS.REASSIGN_PROXY,
)

const neverTested = evaluateProxyReachability({
  proxy: makeProxy({ lastTestedAt: null }),
  now: NOW,
})
ok('never tested → yellow', neverTested.status === STATUSES.YELLOW)
ok(
  'never tested has TEST_PROXY fix',
  neverTested.fix && neverTested.fix.kind === FIX_KINDS.TEST_PROXY,
)

const stale = evaluateProxyReachability({
  proxy: makeProxy({ lastTestedAt: NOW - PROXY_STALE_MS - HOUR }),
  now: NOW,
})
ok('stale (>24h) → yellow', stale.status === STATUSES.YELLOW)

const recentFailures = evaluateProxyReachability({
  proxy: makeProxy({ failureCount: 1 }),
  now: NOW,
})
ok('failureCount > 0 + still active → yellow', recentFailures.status === STATUSES.YELLOW)

const healthy = evaluateProxyReachability({ proxy: makeProxy(), now: NOW })
ok('fresh + 0 failures → green', healthy.status === STATUSES.GREEN)

// ============================================================================
// TOP-LEVEL — evaluateHealth
// ============================================================================
section('evaluateHealth (composition)')

let threw = false
try {
  evaluateHealth({})
} catch (_e) {
  threw = true
}
ok('throws when identity.id missing', threw)

const allGreen = evaluateHealth({
  identity: identity(),
  fingerprint: fpMacEnUS(),
  proxy: makeProxy(),
  cookies: allActive,
  now: NOW,
})
ok('all green → overall green', allGreen.overall === STATUSES.GREEN)
ok('all green has 4 vectors', Object.keys(allGreen.vectors).length === 4)
ok('record carries identityId', allGreen.identityId === 'ident-1')
ok('record carries evaluatedAt', allGreen.evaluatedAt === NOW)

const oneYellow = evaluateHealth({
  identity: identity(),
  fingerprint: fpMacEnUS(),
  proxy: makeProxy({ failureCount: 1 }),
  cookies: allActive,
  now: NOW,
})
ok('one yellow → overall yellow', oneYellow.overall === STATUSES.YELLOW)

const oneRed = evaluateHealth({
  identity: identity(),
  fingerprint: fpMacEnUS({ timezone: 'Asia/Tokyo' }),
  proxy: makeProxy({ country: 'US' }),
  cookies: allActive,
  now: NOW,
})
ok('one red (TZ mismatch) → overall red', oneRed.overall === STATUSES.RED)

const noProxyNoFp = evaluateHealth({
  identity: identity(),
  fingerprint: null,
  proxy: null,
  cookies: null,
  now: NOW,
})
ok(
  'all unknown → overall green (unknown ≈ no signal)',
  noProxyNoFp.overall === STATUSES.GREEN,
)

const mixedSeverity = evaluateHealth({
  identity: identity(),
  fingerprint: fpMacEnUS(),
  proxy: makeProxy({ isDisabled: true, failureCount: 5 }),
  cookies: someExpired, // yellow
  now: NOW,
})
ok('red + yellow → overall red (worst wins)', mixedSeverity.overall === STATUSES.RED)

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
