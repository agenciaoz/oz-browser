# ADR 0030 — Diagnostic export: hard sanitization rules

**Date:** 2026-05-15
**Status:** Accepted (implementación en H-2 extras / v1.1.6)
**Bloque:** H-2 extras — diagnostic export
**Predecesores:** ADR 0008 (vault + encryption), ADR 0017 (proxy model)

## Context

H-2 extras (b) introduce el botón "📋 Export diag" en el proxy-dashboard header. Use case: cuando algo va mal con proxies (Contexto IG-like bug donde la identity ve IP real en lugar de proxy), el user exporta un bundle JSON que adjunta a un issue / manda a soporte para diagnosticar sin reproducir el state.

El bundle agrega state de varios subsystems: proxies, assignments, identities, workspaces, alerts, leakTests. **Algunos de esos contienen secrets**:

- `proxy.password` (auth para Oxylabs / SmartProxy / etc.)
- `proxy.username` (incluye `customer-<id>` que identifica al pagador y permite recrear el username con un brute-force password)
- `cookies` (session tokens — un attacker con un cookie de IG puede impersonar la cuenta hasta que expire)
- `accountVault.password` + `accountVault.totpSecret` (auth para sites)

Si exportamos el bundle sin sanitizar y el user lo manda a un Slack channel/Discord/GitHub issue público, podría comprometer 50 cuentas IG en un click.

## Decision

**Hard sanitization rules** (NO config toggles para opt-out — sanitización es siempre on):

### Redacted siempre

| Field            | Replacement                     |
| ---------------- | ------------------------------- |
| `proxy.password` | `'<redacted>'` (literal string) |
| `proxy.username` | `'<redacted>'`                  |

### Nunca incluidos en el bundle

- Cookies de cualquier identity (no se pide a session.cookies.get).
- `accountVault.getAccounts()` results (no se pide).
- Para `leakTests`: solo se exportan `overall + webrtcStatus + dnsStatus + webrtcReason + dnsReason + proxyCountry`. Específicamente **NO** se exportan:
  - `webrtc.srflxIps` (IPs públicas detectadas — identifican al user)
  - `webrtc.candidates` (raw candidate list, incluye host IPs LAN)
  - `dns.dnsServers` array (ISP fingerprint)
  - `dns.detectedIp` (IP del user via ipleak)

### Preservados (no sensible)

- `proxy.host`, `port`, `protocol`, `country`, `city`, `tags` (info del proveedor, no del user).
- `proxy.lastTestedAt`, `lastLatencyMs`, `lastTestedIp` (último IP visto al hacer test — esto SÍ identifica al user a nivel ASN, pero es necesario para diagnosticar "¿por qué leak test reporta IP X?"). Trade-off aceptado.
- `proxy.failureCount`, `isDisabled` (state).
- Todas las identities/workspaces metadata (id/name/color — no secrets).

## Consequences

✅ **Bundle safe to share**: el user puede pegar el JSON en un GitHub issue / Slack sin riesgo de comprometer auth.

✅ **Tests defensivos**: `tests/proxy-diagnostic-export.smoketest.js` hace `!JSON.stringify(b).includes('topsecret')` y `!JSON.stringify(b).includes('customer-mzewama-cc-ar-sessid-000001')` — si alguien en el futuro agrega un field que pase el password raw por error, el test rompe.

✅ **Auditable**: el bundle incluye `meta.note = 'Sanitized: usernames + passwords + cookies redacted.'` para que el reader sepa qué se omitió.

⚠️ **lastTestedIp se exporta**: trade-off. Sin él no se puede diagnosticar el bug típico ("identity reporta IP X, pero proxy A debería estar dando IP Y"). El user que comparte el bundle ASUME que ese IP es OK divulgar. Mitigación futura: opt-in toggle `--strip-ips` para ultra-paranoid.

⚠️ **Si el user tiene cookies de session sensitivas, ESTOS NO se exportan — pero el `proxy.lastTestedIp` puede mapear a su ISP/ciudad**. Realistic threat model: si un attacker tiene este JSON pero no tiene cookies ni passwords, no puede hacer nada significativo con el IP del ISP del user.

## Code location

- `browser/proxy-diagnostic-export.js buildDiagnosticBundle` — pure, ~140 LOC. Constantes `REDACTED` exported.
- `tests/proxy-diagnostic-export.smoketest.js` — 20 asserts, 8 de los cuales son sanitization-specific (positive: redacted/empty/preserved fields, negative: stringified bundle NO contiene raw secrets).
- `browser/ipc-handlers-extra.js` IPC handler `oz:proxyHealth:exportDiagnostic` — bridge a Electron `dialog.showSaveDialog` + `fs.writeFileSync`.
- `browser/ui/proxy-dashboard-export.js` — UI wire del botón.

## Future

- v1.x: ningún toggle. Sanitización siempre on. Test asserts garantizan no regression.
- v2.x posible: opt-in flag `--include-ips=false` para users ultra-paranoid que quieran omitir `lastTestedIp` también.
- v2.x posible: GPG-encrypted bundle option para que el user pueda cifrar el bundle con la public key de soporte antes de mandarlo (zero-knowledge supporta).
