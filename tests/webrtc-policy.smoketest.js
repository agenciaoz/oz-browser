// OZ Browser — webrtc-policy smoke test (alpha.109).
//
//   node tests/webrtc-policy.smoketest.js

const { decideWebRtcPolicy, POLICIES } = require('../browser/webrtc-policy')

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

console.log('OZ Browser — webrtc-policy smoke test')

// proxy → proxy-only (cero leak)
ok(
  'routingMode proxy → disable_non_proxied_udp',
  decideWebRtcPolicy({ routingMode: 'proxy' }) === POLICIES.PROXY_ONLY,
)

// enforce sin proxy resoluble (fail-closed) → también proxy-only
ok(
  'enforce sin proxy → disable_non_proxied_udp',
  decideWebRtcPolicy({ routingMode: 'none', enforce: true }) === POLICIES.PROXY_ONLY,
)

// direct opt-out → oculta IPs privadas pero permite la pública (su IP real)
ok(
  'routingMode direct → default_public_interface_only',
  decideWebRtcPolicy({ routingMode: 'direct' }) === POLICIES.PUBLIC_ONLY,
)

// none sin enforce (dev/master) → default
ok(
  'routingMode none sin enforce → default',
  decideWebRtcPolicy({ routingMode: 'none' }) === POLICIES.DEFAULT,
)

// override explícito del user gana sobre todo
ok(
  'override gana sobre proxy',
  decideWebRtcPolicy({ routingMode: 'proxy', override: POLICIES.DEFAULT }) ===
    POLICIES.DEFAULT,
)
ok(
  'override inválido se ignora (cae a la lógica normal)',
  decideWebRtcPolicy({ routingMode: 'proxy', override: 'garbage' }) ===
    POLICIES.PROXY_ONLY,
)

// direct gana sobre enforce (coherente con sticky-rotation: el tráfico va
// directo, forzar proxy-only rompería WebRTC sin ganar privacidad).
ok(
  'direct + enforce → public-only (direct prioriza, como el ruteo)',
  decideWebRtcPolicy({ routingMode: 'direct', enforce: true }) === POLICIES.PUBLIC_ONLY,
)

// defaults defensivos
ok('sin args → default', decideWebRtcPolicy() === POLICIES.DEFAULT)

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
