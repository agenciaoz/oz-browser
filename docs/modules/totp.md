# Módulo `totp`

**Path:** `browser/totp.js`
**Líneas:** ~120
**Bloque/Etapa:** J-3 (v1.3.0)

## Qué hace

Generador TOTP (Time-based One-Time Password) RFC 6238 + decoder base32 RFC 4648, **pure Node**, sin deps externas. Genera los mismos códigos que Google Authenticator, Authy, 1Password.

## Por qué cero deps

Agregar `otplib` o `speakeasy` (incluso lightweight) suma surface attack + dep que mantener. RFC 6238 + HMAC-SHA1 + base32 + dynamic truncation fit en ~120 LOC y se valida contra los test vectors del spec directamente.

## API

```js
const { generateTotp, decodeBase32, _hotp } = require('./totp')

// Generar TOTP (formato Authenticator app)
generateTotp('JBSWY3DPEHPK3PXP', { digits: 6 })
// → '287082' (depends on current time)

// Opcionales:
generateTotp(secret, {
  digits: 6, // default 6
  stepSec: 30, // default 30 (Google Authenticator standard)
  t0Sec: 0, // default 0 (Unix epoch offset)
  nowMs: Date.now(), // inject for tests
})

// Base32 decoder (RFC 4648, tolera whitespace + lowercase + padding opcional)
decodeBase32('NBSWY3DP') // → Buffer<...> "hello"
decodeBase32('jBsW Y3dp ehpk3pxp') // → same as JBSWY3DPEHPK3PXP

// HOTP interno (counter-based) — expuesto para test pinning
_hotp(secretBuffer, counter, digits)
```

## Algoritmo

1. Decode base32 secret → Buffer.
2. Compute counter `T = floor((now - T0) / X)` where T0=0, X=30s.
3. `HMAC-SHA1(secret, big-endian 8-byte counter)`.
4. Dynamic truncation (RFC 4226 §5.3): last 4 bits del HMAC = offset O, take 4 bytes from O, mask high bit, mod 10^digits.
5. Zero-pad a `digits` width.

## Tests

`tests/totp.smoketest.js` — **17 asserts**:

- RFC 4648 base32 vectors (5: empty, whitespace tolerance, hex match, "hello", invalid char throws)
- RFC 6238 Appendix B test vectors (6 timestamps × 8-digit codes — the canonical conformance suite)
- 6-digit Google Authenticator format (3 vectors truncated)
- Zero-padding for low codes (1)
- 30-sec window stability (2)

## Gotchas

- 8-byte counter encoded via `Buffer.writeBigUInt64BE` (Node BigInt) — avoids precision loss for `counter > 2^32` que ocurre cuando `T > 2^32 × 30s = ~4000 years`. Hoy no aplica, pero es safety free.
- `decodeBase32` throws con char inválido. El caller debe try/catch si el secret viene de input untrusted.
- TOTP secret NUNCA debe loguearse — el caller (account-handlers.getTotpForSite) lo lee de accountVault encrypted, genera el código, y solo el código cruza el IPC boundary.

## Consumers

- `browser/account-handlers.js` — `getTotpForSite(site, identityId)` busca account.totpSecret y genera código.
- `browser/preload-content.js` — invoca `oz:accounts:getTotpForSite` en páginas 2FA (no usa totp.js directamente; el secret nunca sale del main process).
