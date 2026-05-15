// OZ Browser — leak-tests smoke test (H-2j, v1.1.4).
//
// Cómo correr:
//   cd oz-browser
//   node tests/leak-tests.smoketest.js
//
// Cubre la lógica pura de leak-tests.js (analyze + parse + combine). Los
// handlers (BrowserWindow + net.request) viven en leak-tests-handlers.js y
// se testean indirectamente — esos paths requieren Electron runtime y se
// validan en smoke visual end-to-end (regla feedback_smoke_visual_bugs).

const Module = require('module')

const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

delete require.cache[require.resolve('../browser/leak-tests.js')]
const {
  analyzeWebRtcCandidates,
  analyzeDnsLeak,
  combineLeakResults,
  parseRtcCandidate,
  STATUSES,
  LEAK_REASONS,
  isPrivateRange,
  isMdnsLocal,
} = require('../browser/leak-tests.js')

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

// ============================================================================
// parseRtcCandidate
// ============================================================================
console.log('\nparseRtcCandidate')

ok(
  'null/undefined → null',
  parseRtcCandidate(null) === null && parseRtcCandidate(undefined) === null,
)

ok(
  'structured input passes through',
  (() => {
    const r = parseRtcCandidate({
      type: 'srflx',
      address: '1.2.3.4',
      protocol: 'udp',
      port: 12345,
    })
    return (
      r &&
      r.type === 'srflx' &&
      r.address === '1.2.3.4' &&
      r.protocol === 'udp' &&
      r.port === 12345
    )
  })(),
)

ok(
  'SDP string: typ host LAN ipv4',
  (() => {
    const r = parseRtcCandidate(
      'candidate:1 1 UDP 2122252543 192.168.1.5 56789 typ host generation 0',
    )
    return (
      r &&
      r.type === 'host' &&
      r.address === '192.168.1.5' &&
      r.protocol === 'udp' &&
      r.port === 56789
    )
  })(),
)

ok(
  'SDP string: typ srflx public ipv4',
  (() => {
    const r = parseRtcCandidate(
      'candidate:842163049 1 udp 1677729535 203.0.113.42 41200 typ srflx raddr 192.168.1.5 rport 56789 generation 0',
    )
    return r && r.type === 'srflx' && r.address === '203.0.113.42' && r.port === 41200
  })(),
)

ok(
  'object with .candidate field uses the SDP string',
  (() => {
    const r = parseRtcCandidate({
      candidate: 'candidate:1 1 UDP 2122252543 10.0.0.1 5000 typ host generation 0',
    })
    return r && r.type === 'host' && r.address === '10.0.0.1'
  })(),
)

ok(
  'malformed SDP → null',
  parseRtcCandidate('this is not a candidate') === null &&
    parseRtcCandidate('candidate:1 1 UDP 100') === null,
)

// ============================================================================
// isPrivateRange / isMdnsLocal helpers
// ============================================================================
console.log('\nprivate/local helpers')

ok('10.x.y.z → private', isPrivateRange('10.0.0.1') && isPrivateRange('10.255.255.1'))
ok('192.168.x.y → private', isPrivateRange('192.168.1.1'))
ok(
  '172.16-31.x.y → private',
  isPrivateRange('172.16.0.1') && isPrivateRange('172.31.255.1'),
)
ok(
  '172.15/32 NOT private',
  !isPrivateRange('172.15.0.1') && !isPrivateRange('172.32.0.1'),
)
ok('127/8 → private (loopback)', isPrivateRange('127.0.0.1'))
ok('169.254 → private (link-local)', isPrivateRange('169.254.169.254'))
ok(
  'IPv6 fe80 / fc / fd → private',
  isPrivateRange('fe80::1') && isPrivateRange('fc00::1') && isPrivateRange('fd00::1'),
)
ok('203.0.113.x (public test net) NOT private', !isPrivateRange('203.0.113.42'))
ok('non-string returns false', !isPrivateRange(null) && !isPrivateRange(123))

ok(
  'mDNS .local detected',
  isMdnsLocal('abc-123-def.local') && !isMdnsLocal('203.0.113.42'),
)

// ============================================================================
// analyzeWebRtcCandidates
// ============================================================================
console.log('\nanalyzeWebRtcCandidates')

ok(
  'empty candidates → yellow / NO_STUN_RESPONSE',
  (() => {
    const r = analyzeWebRtcCandidates({ candidates: [], proxyPublicIp: '203.0.113.42' })
    return r.status === STATUSES.YELLOW && r.reason === LEAK_REASONS.NO_STUN_RESPONSE
  })(),
)

ok(
  'srflx matches proxy → green',
  (() => {
    const r = analyzeWebRtcCandidates({
      candidates: [
        { type: 'host', address: 'abc.local', protocol: 'udp', port: 5000 },
        { type: 'srflx', address: '203.0.113.42', protocol: 'udp', port: 41200 },
      ],
      proxyPublicIp: '203.0.113.42',
    })
    return r.status === STATUSES.GREEN && r.srflxIps.includes('203.0.113.42')
  })(),
)

ok(
  'srflx mismatches proxy → red / WEBRTC_LEAK',
  (() => {
    const r = analyzeWebRtcCandidates({
      candidates: [
        { type: 'srflx', address: '198.51.100.5', protocol: 'udp', port: 12345 },
      ],
      proxyPublicIp: '203.0.113.42',
    })
    return (
      r.status === STATUSES.RED &&
      r.reason === LEAK_REASONS.WEBRTC_LEAK &&
      r.leakedIps.includes('198.51.100.5')
    )
  })(),
)

ok(
  'host candidate with public IP → red / WEBRTC_PRIVATE_LEAK',
  (() => {
    // Some browsers DO expose a public host IP if mDNS is disabled or
    // they're operating in a privileged context (extensions, etc).
    const r = analyzeWebRtcCandidates({
      candidates: [
        { type: 'host', address: '198.51.100.7', protocol: 'udp', port: 5000 },
      ],
      proxyPublicIp: '203.0.113.42',
    })
    return (
      r.status === STATUSES.RED &&
      r.reason === LEAK_REASONS.WEBRTC_PRIVATE_LEAK &&
      r.leakedIps.includes('198.51.100.7')
    )
  })(),
)

ok(
  'host candidates all mDNS/private + matching srflx → green',
  (() => {
    const r = analyzeWebRtcCandidates({
      candidates: [
        { type: 'host', address: 'abc-uuid.local', protocol: 'udp', port: 5000 },
        { type: 'host', address: '192.168.1.5', protocol: 'udp', port: 5001 },
        { type: 'srflx', address: '203.0.113.42', protocol: 'udp', port: 41200 },
      ],
      proxyPublicIp: '203.0.113.42',
    })
    return r.status === STATUSES.GREEN
  })(),
)

ok(
  'srflx present + no proxyPublicIp → yellow (inconclusive)',
  (() => {
    const r = analyzeWebRtcCandidates({
      candidates: [
        { type: 'srflx', address: '203.0.113.42', protocol: 'udp', port: 12345 },
      ],
      proxyPublicIp: null,
    })
    return r.status === STATUSES.YELLOW && r.srflxIps.includes('203.0.113.42')
  })(),
)

// ============================================================================
// analyzeDnsLeak
// ============================================================================
console.log('\nanalyzeDnsLeak')

ok(
  'null ipleakJson → yellow / NO_IPLEAK_RESPONSE',
  (() => {
    const r = analyzeDnsLeak({ ipleakJson: null, proxyCountry: 'AR' })
    return r.status === STATUSES.YELLOW && r.reason === LEAK_REASONS.NO_IPLEAK_RESPONSE
  })(),
)

ok(
  'IP and country match proxy → green',
  (() => {
    const r = analyzeDnsLeak({
      ipleakJson: { ip: '203.0.113.42', country_code: 'AR' },
      proxyCountry: 'AR',
      proxyPublicIp: '203.0.113.42',
    })
    return r.status === STATUSES.GREEN && r.detectedIp === '203.0.113.42'
  })(),
)

ok(
  'IP mismatch → red / IP_MISMATCH',
  (() => {
    const r = analyzeDnsLeak({
      ipleakJson: { ip: '198.51.100.7', country_code: 'AR' },
      proxyCountry: 'AR',
      proxyPublicIp: '203.0.113.42',
    })
    return r.status === STATUSES.RED && r.reason === LEAK_REASONS.IP_MISMATCH
  })(),
)

ok(
  'Country mismatch → red / COUNTRY_MISMATCH',
  (() => {
    const r = analyzeDnsLeak({
      ipleakJson: { ip: '203.0.113.42', country_code: 'CN' },
      proxyCountry: 'AR',
      proxyPublicIp: '203.0.113.42',
    })
    return r.status === STATUSES.RED && r.reason === LEAK_REASONS.COUNTRY_MISMATCH
  })(),
)

ok(
  'DNS server geo mismatch only → yellow / DNS_GEO_MISMATCH',
  (() => {
    const r = analyzeDnsLeak({
      ipleakJson: {
        ip: '203.0.113.42',
        country_code: 'AR',
        dns_servers: [
          { ip: '8.8.8.8', country_code: 'US' },
          { ip: '8.8.4.4', country_code: 'US' },
        ],
      },
      proxyCountry: 'AR',
      proxyPublicIp: '203.0.113.42',
    })
    return r.status === STATUSES.YELLOW && r.reason === LEAK_REASONS.DNS_GEO_MISMATCH
  })(),
)

ok(
  'proxyCountry/PublicIp absent → green when no detectable issue',
  (() => {
    const r = analyzeDnsLeak({
      ipleakJson: { ip: '203.0.113.42', country_code: 'AR' },
      proxyCountry: null,
      proxyPublicIp: null,
    })
    return r.status === STATUSES.GREEN
  })(),
)

ok(
  'country code case-insensitive comparison',
  (() => {
    const r = analyzeDnsLeak({
      ipleakJson: { ip: '203.0.113.42', country_code: 'ar' },
      proxyCountry: 'AR',
    })
    return r.status === STATUSES.GREEN && r.detectedCountry === 'AR'
  })(),
)

// ============================================================================
// combineLeakResults
// ============================================================================
console.log('\ncombineLeakResults')

ok(
  'green + green → green',
  (() => {
    const r = combineLeakResults({
      webrtc: { status: STATUSES.GREEN },
      dns: { status: STATUSES.GREEN },
      identityId: 'id-1',
    })
    return r.overall === STATUSES.GREEN && r.identityId === 'id-1'
  })(),
)

ok(
  'green + yellow → yellow',
  (() => {
    const r = combineLeakResults({
      webrtc: { status: STATUSES.GREEN },
      dns: { status: STATUSES.YELLOW },
    })
    return r.overall === STATUSES.YELLOW
  })(),
)

ok(
  'yellow + red → red (worst wins)',
  (() => {
    const r = combineLeakResults({
      webrtc: { status: STATUSES.YELLOW },
      dns: { status: STATUSES.RED },
    })
    return r.overall === STATUSES.RED
  })(),
)

ok(
  'null webrtc/dns gracefully → green (no signal ≈ no problem)',
  (() => {
    const r = combineLeakResults({ webrtc: null, dns: null })
    return r.overall === STATUSES.GREEN
  })(),
)

ok(
  'evaluatedAt defaults to Date.now() when missing',
  (() => {
    const before = Date.now()
    const r = combineLeakResults({
      webrtc: { status: STATUSES.GREEN },
      dns: { status: STATUSES.GREEN },
    })
    const after = Date.now()
    return (
      typeof r.evaluatedAt === 'number' &&
      r.evaluatedAt >= before &&
      r.evaluatedAt <= after
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
