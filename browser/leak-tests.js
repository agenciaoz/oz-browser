// OZ Browser — Leak tests (H-2j, v1.1.4) — PURE LOGIC.
//
// Qué hace: analiza resultados de WebRTC ICE candidate gathering y
// respuestas de ipleak.net contra el proxy esperado de una identity, y
// produce un veredicto green/yellow/red con detalles auditables.
//
// Por qué módulo PURO (sin Electron, sin net.request, sin BrowserWindow):
//   - 100% testeable sync sin GUI/main process boot.
//   - El handler-wrapper (leak-tests-handlers.js) ejecuta el WebRTC dance
//     en una hidden BrowserWindow con la session de la identity + invoca
//     ipleak.net via net.request, después llama acá para juzgar.
//   - Mismo evaluador usado por IPC + MCP + tests.
//
// Doc: docs/modules/leak-tests.md
// ADRs: 0005 (modular 500 LOC), 0017 (proxy model), 0018 (fingerprint engine).
//
// Exports:
//   analyzeWebRtcCandidates({candidates, proxyPublicIp})
//   analyzeDnsLeak({ipleakJson, proxyCountry, proxyPublicIp})
//   combineLeakResults({webrtc, dns})
//   parseRtcCandidate(rtcCandidateLike)
//   STATUSES, LEAK_REASONS
//
// Shape de un leak record:
//   {
//     identityId,
//     evaluatedAt,
//     overall: 'red'|'yellow'|'green',
//     webrtc: { status, summary, candidates: [...], leakedIps: [...], reason? },
//     dns:    { status, summary, detectedIp, detectedCountry, dnsServers, reason?, issues? },
//   }

const STATUSES = Object.freeze({
  GREEN: 'green',
  YELLOW: 'yellow',
  RED: 'red',
})

const LEAK_REASONS = Object.freeze({
  NO_STUN_RESPONSE: 'NO_STUN_RESPONSE',
  WEBRTC_LEAK: 'WEBRTC_LEAK',
  WEBRTC_PRIVATE_LEAK: 'WEBRTC_PRIVATE_LEAK',
  NO_IPLEAK_RESPONSE: 'NO_IPLEAK_RESPONSE',
  IP_MISMATCH: 'IP_MISMATCH',
  COUNTRY_MISMATCH: 'COUNTRY_MISMATCH',
  DNS_GEO_MISMATCH: 'DNS_GEO_MISMATCH',
})

// Worst-of ranking — mismo enfoque que anti-detect-health.js.
const RANK = { green: 0, yellow: 1, red: 2 }

// ============================================================================
// WebRTC ICE candidate analysis
// ============================================================================
// Recibe una lista de candidates parseados (ver parseRtcCandidate) + el IP
// público conocido del proxy (proxyPublicIp), y devuelve un veredicto:
//
//   - candidates vacíos                                → yellow / NO_STUN_RESPONSE
//   - srflx que NO matchea proxyPublicIp              → red / WEBRTC_LEAK
//   - sin proxyPublicIp conocido + srflx detectado    → yellow (no podemos
//     juzgar mismatch; reportamos los IPs para inspección manual)
//   - host candidates exposing local IPv4/IPv6        → yellow / WEBRTC_PRIVATE_LEAK
//     (típico bug — proxy filtra pero browser igual revela IP LAN al sitio)
//   - srflx === proxyPublicIp                          → green ✅
//
// El caller decide si yellow es aceptable; el dashboard lo muestra como
// "no concluyente" / "revisar".

function analyzeWebRtcCandidates({ candidates, proxyPublicIp } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  if (list.length === 0) {
    return {
      status: STATUSES.YELLOW,
      reason: LEAK_REASONS.NO_STUN_RESPONSE,
      summary:
        'No ICE candidates gathered — STUN blocked by proxy or browser WebRTC disabled.',
      candidates: [],
      srflxIps: [],
      hostIps: [],
      leakedIps: [],
    }
  }

  const srflx = list.filter((c) => c.type === 'srflx')
  const host = list.filter((c) => c.type === 'host')
  const srflxIps = uniq(srflx.map((c) => c.address).filter(Boolean))
  const hostIps = uniq(host.map((c) => c.address).filter(Boolean))

  // Host candidates with public IPs are a leak — that's the local interface
  // address, exposed even when traffic routes through a proxy. Note: most
  // modern browsers mDNS-anonymize host candidates by default (.local
  // hostnames), so we only flag NON-mDNS, NON-private host candidates.
  const publicHostLeaks = hostIps.filter((ip) => !isMdnsLocal(ip) && !isPrivateRange(ip))

  // Server-reflexive (srflx) candidates expose the public-facing IP. If
  // proxyPublicIp is known and ANY srflx is something else, the proxy isn't
  // hiding the real client IP — WebRTC is bypassing the proxy via UDP.
  let mismatchSrflx = []
  if (proxyPublicIp) {
    mismatchSrflx = srflxIps.filter((ip) => ip !== proxyPublicIp)
  }

  const details = {
    candidates: list,
    srflxIps,
    hostIps,
    leakedIps: uniq([...publicHostLeaks, ...mismatchSrflx]),
  }

  if (mismatchSrflx.length > 0) {
    return {
      status: STATUSES.RED,
      reason: LEAK_REASONS.WEBRTC_LEAK,
      summary: `WebRTC reveals public IP(s) ${mismatchSrflx.join(', ')} instead of proxy IP ${proxyPublicIp}.`,
      ...details,
    }
  }
  if (publicHostLeaks.length > 0) {
    return {
      status: STATUSES.RED,
      reason: LEAK_REASONS.WEBRTC_PRIVATE_LEAK,
      summary: `WebRTC exposes host IP(s) ${publicHostLeaks.join(', ')} — sites can see the real interface.`,
      ...details,
    }
  }
  if (!proxyPublicIp && srflxIps.length > 0) {
    return {
      status: STATUSES.YELLOW,
      summary: `Proxy IP unknown — got srflx ${srflxIps.join(', ')}. Test the proxy first to populate lastTestedIp, then re-run.`,
      ...details,
    }
  }
  // proxyPublicIp matches OR srflx empty and host all mDNS/private — OK.
  return {
    status: STATUSES.GREEN,
    summary: srflxIps.length
      ? `WebRTC srflx matches proxy IP (${srflxIps.join(', ')}).`
      : 'No srflx candidates and no public host leaks. WebRTC is not bypassing the proxy.',
    ...details,
  }
}

// Parse a raw RTCIceCandidate-like object OR a candidate-string into a
// uniform shape. RTCIceCandidate has structured fields in modern browsers
// (.address, .port, .protocol, .type) but on older paths it's a
// 'candidate:...' SDP string.
//
// Input forms accepted:
//   { type, address, protocol, port }      (already parsed)
//   { candidate: 'candidate:1 1 UDP ...' } (sdp string field)
//   'candidate:1 1 UDP 2122252543 192.168.1.5 56789 typ host generation 0'
//
// Returns: { type, address, protocol, port } or null if unparseable.
function parseRtcCandidate(input) {
  if (!input) return null
  // Already structured.
  if (typeof input === 'object' && input.type && input.address) {
    return {
      type: input.type,
      address: input.address,
      protocol: input.protocol || null,
      port: typeof input.port === 'number' ? input.port : null,
    }
  }
  const str =
    typeof input === 'string'
      ? input
      : input && typeof input.candidate === 'string'
        ? input.candidate
        : null
  if (!str) return null
  // SDP candidate line format:
  //   candidate:<foundation> <comp> <proto> <prio> <ip> <port> typ <type> ...
  const parts = str.replace(/^candidate:/, '').split(/\s+/)
  if (parts.length < 8) return null
  const protocol = (parts[2] || '').toLowerCase()
  const address = parts[4]
  const port = Number(parts[5])
  // 'typ' keyword is parts[6], type value at parts[7].
  if (parts[6] !== 'typ') return null
  const type = parts[7]
  if (!address || !type) return null
  return {
    type,
    address,
    protocol: protocol || null,
    port: Number.isFinite(port) ? port : null,
  }
}

// ============================================================================
// DNS / IP leak analysis (ipleak.net JSON response)
// ============================================================================
// ipleak.net/json returns roughly:
//   {
//     "ip": "203.0.113.42",
//     "country_code": "AR",
//     "country_name": "Argentina",
//     "asn": 22927,
//     "isp_name": "Telecom Argentina",
//     ...
//   }
//
// Su endpoint /dns/json/<token>.dnsleak.something returns DNS server list.
// Para v1.1.4 cubrimos el caso simple: comparar ipleakJson.ip y
// ipleakJson.country_code contra el proxy. DNS server list es opcional
// — si el caller la pasa, agregamos validation extra.

function analyzeDnsLeak({ ipleakJson, proxyCountry, proxyPublicIp } = {}) {
  if (!ipleakJson || typeof ipleakJson !== 'object') {
    return {
      status: STATUSES.YELLOW,
      reason: LEAK_REASONS.NO_IPLEAK_RESPONSE,
      summary: 'No response from ipleak.net — network blocked or service unreachable.',
      detectedIp: null,
      detectedCountry: null,
      dnsServers: [],
    }
  }

  const detectedIp = ipleakJson.ip || null
  const detectedCountry = (ipleakJson.country_code || '').toUpperCase() || null
  const dnsServers = Array.isArray(ipleakJson.dns_servers)
    ? ipleakJson.dns_servers
    : Array.isArray(ipleakJson.dns)
      ? ipleakJson.dns
      : []

  const issues = []

  // IP mismatch is the strongest signal — if proxy says X and ipleak sees Y,
  // the proxy isn't being used by HTTP traffic. This is sometimes a false
  // positive when proxy chains rotate exit nodes; we still flag it as red.
  if (proxyPublicIp && detectedIp && detectedIp !== proxyPublicIp) {
    issues.push({
      type: LEAK_REASONS.IP_MISMATCH,
      detected: detectedIp,
      expected: proxyPublicIp,
    })
  }

  // Country mismatch — softer signal, since proxy chains can exit through
  // different geos. But if user picked a US proxy and the request shows
  // CN, something is very wrong.
  if (proxyCountry && detectedCountry && detectedCountry !== proxyCountry.toUpperCase()) {
    issues.push({
      type: LEAK_REASONS.COUNTRY_MISMATCH,
      detected: detectedCountry,
      expected: proxyCountry.toUpperCase(),
    })
  }

  // DNS servers geo mismatch — if the caller provided dnsServers with
  // country_code per entry, flag any that don't match the proxy country.
  const dnsGeoMismatches = []
  if (proxyCountry && dnsServers.length > 0) {
    for (const d of dnsServers) {
      if (
        d &&
        d.country_code &&
        d.country_code.toUpperCase() !== proxyCountry.toUpperCase()
      ) {
        dnsGeoMismatches.push(d)
      }
    }
    if (dnsGeoMismatches.length > 0) {
      issues.push({
        type: LEAK_REASONS.DNS_GEO_MISMATCH,
        servers: dnsGeoMismatches,
        expectedCountry: proxyCountry.toUpperCase(),
      })
    }
  }

  if (issues.length === 0) {
    return {
      status: STATUSES.GREEN,
      summary: detectedIp
        ? `Exit IP ${detectedIp}${detectedCountry ? ` (${detectedCountry})` : ''} matches proxy.`
        : 'ipleak.net reports no IP mismatch.',
      detectedIp,
      detectedCountry,
      dnsServers,
    }
  }

  const hasRed = issues.some(
    (i) =>
      i.type === LEAK_REASONS.IP_MISMATCH || i.type === LEAK_REASONS.COUNTRY_MISMATCH,
  )
  const status = hasRed ? STATUSES.RED : STATUSES.YELLOW
  return {
    status,
    reason: issues[0].type,
    summary: summarizeIssues(issues),
    detectedIp,
    detectedCountry,
    dnsServers,
    issues,
  }
}

// ============================================================================
// Combine WebRTC + DNS into a single leak record (overall = worst-of)
// ============================================================================

function combineLeakResults({ webrtc, dns, identityId, evaluatedAt }) {
  const ranks = [webrtc ? RANK[webrtc.status] || 0 : 0, dns ? RANK[dns.status] || 0 : 0]
  const maxR = Math.max(...ranks)
  const overall =
    maxR >= RANK.red
      ? STATUSES.RED
      : maxR >= RANK.yellow
        ? STATUSES.YELLOW
        : STATUSES.GREEN
  return {
    identityId: identityId || null,
    evaluatedAt: evaluatedAt || Date.now(),
    overall,
    webrtc: webrtc || null,
    dns: dns || null,
  }
}

// ============================================================================
// Helpers
// ============================================================================

function uniq(arr) {
  return Array.from(new Set(arr))
}

function isMdnsLocal(ip) {
  // mDNS-anonymized host candidates look like '<uuid>.local'.
  return typeof ip === 'string' && /\.local$/i.test(ip)
}

function isPrivateRange(ip) {
  if (typeof ip !== 'string') return false
  // IPv4 private ranges per RFC 1918 + RFC 4193 + link-local.
  if (/^10\./.test(ip)) return true
  if (/^192\.168\./.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true
  if (/^127\./.test(ip)) return true
  if (/^169\.254\./.test(ip)) return true
  // IPv6 unique-local / link-local.
  if (/^fe80::/i.test(ip)) return true
  if (/^fc[0-9a-f]{2}::/i.test(ip)) return true
  if (/^fd[0-9a-f]{2}:/i.test(ip)) return true
  return false
}

function summarizeIssues(issues) {
  return issues
    .map((i) => {
      if (i.type === LEAK_REASONS.IP_MISMATCH) {
        return `IP mismatch: ipleak sees ${i.detected}, proxy says ${i.expected}.`
      }
      if (i.type === LEAK_REASONS.COUNTRY_MISMATCH) {
        return `Country mismatch: ipleak sees ${i.detected}, proxy is ${i.expected}.`
      }
      if (i.type === LEAK_REASONS.DNS_GEO_MISMATCH) {
        return `${i.servers.length} DNS server(s) outside ${i.expectedCountry}.`
      }
      return i.type
    })
    .join(' ')
}

module.exports = {
  analyzeWebRtcCandidates,
  analyzeDnsLeak,
  combineLeakResults,
  parseRtcCandidate,
  STATUSES,
  LEAK_REASONS,
  RANK,
  // Internal helpers exposed for test pinning.
  isPrivateRange,
  isMdnsLocal,
}
