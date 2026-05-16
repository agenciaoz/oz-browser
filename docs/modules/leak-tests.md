# Módulo `leak-tests`

**Path:** `browser/leak-tests.js`
**Líneas:** ~310 (pure)
**Bloque/Etapa:** H-2j (v1.1.4)

## Qué hace

Lógica pura que analiza resultados de WebRTC ICE candidate gathering + responses de ipleak.net y produce un veredicto green/yellow/red con detalles auditables. Sin Electron, sin net.request, sin BrowserWindow — solo análisis. El runtime side vive en `leak-tests-handlers.js`.

## Por qué módulo PURO

- 100% testeable sync sin GUI/main process boot.
- Mismo evaluador usado por IPC + MCP + tests.

## Exports

```js
analyzeWebRtcCandidates({ candidates, proxyPublicIp })
// → { status, reason?, summary, candidates, srflxIps, hostIps, leakedIps }

analyzeDnsLeak({ ipleakJson, proxyCountry, proxyPublicIp })
// → { status, reason?, summary, detectedIp, detectedCountry, dnsServers, issues? }

combineLeakResults({ webrtc, dns, identityId, evaluatedAt })
// → { identityId, evaluatedAt, overall, webrtc, dns }

parseRtcCandidate(input)
// → { type, address, protocol, port } o null
;(STATUSES, LEAK_REASONS, RANK, isPrivateRange, isMdnsLocal)
```

## Veredictos WebRTC

| Condición                                           | Status | Reason                                 |
| --------------------------------------------------- | ------ | -------------------------------------- |
| candidates vacíos                                   | yellow | NO_STUN_RESPONSE                       |
| srflx ≠ proxyPublicIp                               | red    | WEBRTC_LEAK                            |
| host candidate con IP pública (no mDNS, no private) | red    | WEBRTC_PRIVATE_LEAK                    |
| sin proxyPublicIp + srflx detectado                 | yellow | (inconclusive — testear proxy primero) |
| srflx === proxyPublicIp y sin host leaks            | green  | (OK)                                   |

## Veredictos DNS

| Condición                                                     | Status | Reason             |
| ------------------------------------------------------------- | ------ | ------------------ |
| null ipleakJson                                               | yellow | NO_IPLEAK_RESPONSE |
| `ipleakJson.ip !== proxyPublicIp`                             | red    | IP_MISMATCH        |
| `ipleakJson.country_code !== proxyCountry` (case-insensitive) | red    | COUNTRY_MISMATCH   |
| `dns_servers[*].country_code !== proxyCountry`                | yellow | DNS_GEO_MISMATCH   |
| no issues                                                     | green  | (OK)               |

## `parseRtcCandidate`

Acepta 3 formas de input:

1. Structured object: `{type, address, protocol, port}` (modern RTCIceCandidate).
2. Object con candidate string: `{candidate: 'candidate:1 1 UDP ... typ host'}`.
3. Raw SDP string: `'candidate:842163049 1 udp 1677729535 203.0.113.42 41200 typ srflx ...'`.

Returns `null` si unparseable.

## Helpers

- `isPrivateRange(ip)`: cubre RFC 1918 (10/8, 192.168/16, 172.16-31/12) + 127/8 loopback + 169.254/16 link-local + IPv6 fe80/fc/fd unique-local.
- `isMdnsLocal(ip)`: `.local` suffix (modernos browsers anonymize host candidates así por default).

## Tests

`tests/leak-tests.smoketest.js` — **34 asserts**: parseRtcCandidate edge cases (6), private/mDNS helpers (8), analyzeWebRtcCandidates (6), analyzeDnsLeak (7), combineLeakResults worst-of (5).

## Consumers

- `browser/leak-tests-handlers.js` — runtime que spawnea hidden BrowserWindow + net.request, llama acá para juzgar.
- `tests/` directly por unit testing.
