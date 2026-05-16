# ADR 0028 — TOTP generation from scratch (no external dep)

**Date:** 2026-05-15
**Status:** Accepted (implementación en J-3 / v1.3.0)
**Bloque:** J — Auto-login completo
**Predecesores:** ADR 0008 (vault + AES-256-GCM)

## Context

J-3 implementa auto-fill de TOTP codes en páginas 2FA de IG/X/FB/Google. El `account.totpSecret` ya se guarda encriptado en el vault desde 1.5b, pero no había generador de códigos rotativos — habría que implementar RFC 6238 o pull a dep.

Opciones de dep:

- **`otplib`** (~150KB): industry standard, soporta HOTP + TOTP + Google Auth flavors. Pesa.
- **`speakeasy`** (~50KB): similar, más legacy.
- **`@levminer/speakeasy`**: fork mantenido.
- **From scratch** (~120 LOC): Node `crypto.createHmac('sha1', secret)` + base32 decoder + dynamic truncation.

## Decision

**Implementar RFC 6238 from scratch** en `browser/totp.js` (~120 LOC, cero deps). Razones:

1. **Surface attack mínimo**: el TOTP secret es uno de los items más sensibles del vault. Agregar una dep amplifica supply-chain risk (compromised npm publish → leak de TOTP secrets de TODOS los users del browser).
2. **El spec fit en ~120 LOC**: RFC 6238 + HMAC-SHA1 + base32 + dynamic truncation. Algorithm es público, well-specified, y los test vectors (RFC 6238 Appendix B) son canónicos.
3. **Validation directa**: tests run los 6 vectores del Appendix B + 5 base32 vectors del RFC 4648 § 10. Match exacto = correctness garantizada contra el spec.
4. **Maintenance burden mínimo**: HMAC-SHA1 no va a cambiar nunca; base32 tampoco. El módulo es "write once, forget".
5. **Sin breaking changes posibles**: cualquier consumer (Google Authenticator, Authy, 1Password) genera los mismos códigos si el secret + tiempo son los mismos. No hay "v2 del spec" que romper.

## Consequences

✅ **Vault contents (secrets) never cross the IPC boundary**: el secret vive solo en main process. El renderer recibe solo el código rotativo 6-dígito. Esta property no es exclusiva de from-scratch (`otplib` podría hacer lo mismo), pero la implementación bajo nuestro control lo garantiza por diseño.

✅ **Tests directos contra el spec**: 17 asserts cubren todos los test vectors del RFC + edge cases del base32 decoder. Confianza alta en correctness.

⚠️ **Si Google introduce un futuro variant** (SHA-256, longer counters, etc.): habría que extender el módulo. Hoy nadie usa esos variants — Google Auth + Authy + 1Password todos usan SHA1 + 6 digits + 30s. Risk realista: bajo.

⚠️ **No cubrimos HOTP** (counter-based, no time-based) explícitamente como public API — solo `_hotp` interno para test pinning. Si en el futuro algún provider usa HOTP, hay que exponerlo.

## Alternatives considered

**`otplib`**: pros — battle-tested, supports many variants. Cons — adds 150KB, supply-chain risk, more API surface than we need.

**Use Apple Keychain TOTP API**: macOS exposes a Keychain-level TOTP. Cons — non-portable (Windows v3 SaaS no tendría); requires Keychain access prompts for each TOTP fetch (UX broken for 50 identities).

**Defer J-3 to v2**: skip auto-fill TOTP and require user to type code manually. Cons — defeats the whole "50 cuentas que se queden logueadas" use case; manual code typing × 50 × every-time-session-expires = unusable.

## Code location

- `browser/totp.js` (~120 LOC, pure)
- `tests/totp.smoketest.js` (17 asserts)
- `browser/account-handlers.js getTotpForSite` — consumer (generates code, returns to renderer)
- `browser/preload-content.js installTotpFill` — IPC consumer (fills `totpInput` selector)
- `browser/site-templates.js` — selectors per platform (IG/X/FB/Google totpUrlPatterns + totpInput)
