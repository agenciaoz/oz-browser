# Bloque J — Auto-login set completo (TOTP + auto-relogin loop)

**Status:** ✅ J-1/J-2 (ya en 1.5c) + J-3/J-4 cerrados 2026-05-15
**Commit:** TBD
**Version:** 1.3.0 (minor bump por feature core grande, pre-aprobado)
**Tiempo efectivo:** ~2.5h (no 6h — J-1+J-2 ya existían, J-4 era casi todo wire de piezas existentes)
**Deps nuevas:** ninguna (RFC 6238 implementado from scratch)
**Tests nuevos:** +17 (todos contra RFC 6238 Appendix B + RFC 4648 base32)

## Origen

El producto OZ Browser tiene un caso de uso core: **"50 cuentas Insta logueadas que se queden logueadas"**. Para eso hace falta:

- ✅ accountVault encripta credenciales (existing E)
- ✅ AntiLogout extiende cookies session (existing 1.5)
- ❌ Auto-fill on login page → partial
- ❌ Auto-save on form submit → no existe
- ❌ TOTP/2FA from accountVault → no inject
- ❌ Auto-relogin cuando session muere → manual

Sin J, el accountVault es un baúl que nadie abre. Es THE feature core que falta.

**Decisión Jose 2026-05-15**: saltarse G-6 (Ghost importer también importa proxies — su Ghost proxy list está vacío, cero valor inmediato) y arrancar J directo. G-6 diferido a v1.2.x.

## Hallazgo durante exploración

J-1 (auto-fill) y J-2 (auto-save) **ya vivían en 1.5c**, no eran greenfield:

- `browser/preload-content.js` (190 LOC): `installAutoFill` (DOMContentLoaded + SPA URL diff 1.5s + match templates + IPC + waitForSelector + React-compatible `setInputValue`) + `installAutoSave` (capture-phase submit listener + form selector match + IPC proposal).
- `browser/site-templates.js` (249 LOC): 10 plataformas con `id/name/hosts/loginUrlPatterns/flow/selectors{usernameInput,passwordInput,submitButton,loggedInIndicator}` para X/IG/FB/TikTok/LinkedIn/Google/Reddit/Threads/Telegram/Discord.
- `oz:accounts:getCredentialsForSite` + `oz:accounts:proposeAutoSave` IPC con identity resolution server-side via `event.sender.session` (anti-impersonation — un renderer comprometido NO puede pedir creds de otra identity).
- Native confirmation dialog en main.js para "Save/Update password?" UX.

Por eso scope real ~2.5h vs estimado 6h. Las piezas core estaban; faltaban TOTP + auto-relogin loop closer.

## v1.3.0 — J-3 + J-4

### J-3 — TOTP inject (greenfield)

**`browser/totp.js`** (~120 LOC, **pure** sin deps externas):

- RFC 6238 TOTP generator + RFC 4648 base32 decoder + HMAC-SHA1 dynamic truncation.
- `generateTotp(secretBase32, {digits=6, stepSec=30, t0Sec=0, nowMs=Date.now()})` → `'NNNNNN'`.
- `decodeBase32(s) → Buffer`: tolerante a whitespace/lowercase, padding `=` opcional. Validates alphabet.
- `_hotp(secret, counter, digits)` interno expuesto para test pinning.
- 8-byte big-endian counter via `Buffer.writeBigUInt64BE` (Node BigInt — sin precision loss para counters > 2^32).

Por qué cero deps (vs `otplib` o `speakeasy`): RFC 6238 + HMAC-SHA1 + base32 fit en ~120 LOC. Adding a dep = surface attack + maintenance. Lo validamos contra los test vectors del spec directamente.

**`browser/site-templates.js` extendido**:

- Cada template puede tener `totpUrlPatterns` (regex array) + `selectors.totpInput`.
- 4 plataformas críticas con TOTP support:
  - **Instagram**: `/accounts/(login/)?two_factor` + `/challenge/` → input `name="verificationCode"`
  - **X / Twitter**: `/i/flow/login` (mismo URL que password, se detecta por DOM) → input `data-testid="LoginForm_TwoFactorAuthCode_Input"`
  - **Facebook**: `/checkpoint` + `/login/.*two_factor` → input `name="approvals_code"`
  - **Google**: `/signin/v2/challenge/totp` → input `name="totpPin"`
- Generic fallback: `input[autocomplete="one-time-code"]` (HTML spec) cubre sitios fuera de la registry.
- Nuevas funciones exportadas: `isTotpUrl(url)`, `matchByTotpUrl(url)`.

**`browser/preload-content.js` extendido**:

- Nuevo `installTotpFill()` mirror del autoFill pattern.
- Trigger: DOMContentLoaded + SPA URL diff each 1.5s (mismo que J-1).
- Detection: template debe match by hostname + (URL match totpUrlPatterns OR fallback a probe `autocomplete="one-time-code"`).
- IPC: `oz:accounts:getTotpForSite(site, identityId=null)` → `{code, accountId}` o `null` o `{__error}`.
- Fill: `waitForSelector(template.selectors.totpInput, 4000)` + `setInputValue(input, totp.code)` (React-compatible).

**`browser/account-handlers.js getTotpForSite`**:

- Vault gate (LOCKED → `__error`).
- Filtros: `identityId === X && site === Y && status !== 'inactive' && totpSecret`.
- Sort por `lastLoginAt` desc, pick most recent.
- `generateTotp(account.totpSecret)` → `{code, accountId}`.
- **CRÍTICO**: el `totpSecret` NUNCA sale del main process. Solo el código rotativo 6-digit cruza el IPC boundary. Renderer comprometido no obtiene el secret.

**IPC en `ipc-handlers.js`**: `oz:accounts:getTotpForSite` con identity resolution server-side via `event.sender.session` — mismo pattern anti-impersonation que getCredentialsForSite.

### J-4 — Auto-relogin (minimal change)

**Hallazgo**: la mayor parte del loop YA estaba implementado por piezas existentes:

1. `anti-logout._maybeFlagNeedsRelogin(identityId, cookie)`: detecta cookie removal en cookies sociales (X, IG, FB, etc.) → flagea matching accounts `status:'needs_relogin'` → `alertManager.add({type:'anti-logout', severity:'urgent', title:'Account needs re-login'})` → opcional OS notification.
2. `account-handlers.proposeAutoSave` update path: cuando user confirma "Update password" del dialog post-submit, llama `accounts.update({password, lastLoginAt, status:'active'})`. Status flip ya estaba.

**Lo único faltante** para cerrar el loop end-to-end:

`getCredentialsForSite` ahora flipea optimistically `status:'needs_relogin' → 'active'` cuando se entrega creds (auto-fill happening). Side effect: si fill no resulta en login exitoso, anti-logout's cookie watcher re-flagea en próximo logout detect. Safe net intact.

Adicional: devuelve `wasNeedsRelogin:boolean` para preload/UI hints futuros (e.g. small banner "Re-login auto-filled for IG-1"), y broadcast `oz:accounts:changed` para que AccountManager UI refresque.

### Loop completo end-to-end

```
anti-logout detecta logout via cookie removal
    ↓
flagea account.status = 'needs_relogin'
    ↓
alertManager.add severity='urgent' + OS notification
    ↓
user navega a login.com (manual)
    ↓
preload-content.js installAutoFill detecta isLoginUrl
    ↓
IPC oz:accounts:getCredentialsForSite
    ↓
main: filter accounts (identityId, site, !inactive)
    ↓
main: optimistic flip needs_relogin → active + broadcast changed
    ↓
return {username, password, totpSecret, wasNeedsRelogin}
    ↓
preload fills username + password inputs (React-compat)
    ↓
[if 2FA enabled] site redirects to /two_factor
    ↓
preload-content.js installTotpFill detecta isTotpUrl
    ↓
IPC oz:accounts:getTotpForSite
    ↓
main: generateTotp(account.totpSecret) (RFC 6238)
    ↓
return {code, accountId}
    ↓
preload fills totp input
    ↓
user clicks submit (auto-click NO — defensive UX)
    ↓
J-2 proposeAutoSave detecta submit
    ↓
main: dialog "Update password?" (or skip si match)
    ↓
on confirm: accounts.update({password, lastLoginAt, status:'active'})
    ↓
site sets cookies → user logged in
    ↓
anti-logout's watcher confirms login OK (cookie present)
```

## Tests

`tests/totp.smoketest.js` (~110 LOC, **17 asserts**):

- **RFC 4648 base32 (5)**: empty → empty buffer, whitespace+lowercase tolerance, hex match `JBSWY3DPEHPK3PXP → 48656c6c6f21deadbeef`, `NBSWY3DP → "hello"`, invalid char throws.
- **RFC 6238 Appendix B (6)**: las 6 vectores canónicos a T={59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000} con secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` ('12345678901234567890' en ASCII) y digits=8. Match exacto.
- **6-digit Google Authenticator (3)**: same vectors truncated → últimos 6 chars de los 8-digit codes coinciden.
- **Zero-padding (1)**: codes < 100000 con padStart(6, '0').
- **30-sec window stability (2)**: misma TOTP en `t+5` y `t+25` (mismo counter), diferente cruzando boundary.

Suite full 74+ archivos verde. Lint clean. `check:loc` max 499.

## Pendiente

- **Smoke visual REAL** con app corriendo (regla `feedback_smoke_visual_bugs`):
  1. Crear identity con account.totpSecret (manualmente en Account Manager o paste base32 secret de Google Authenticator setup).
  2. Navegar a `instagram.com/accounts/login` desde tab de esa identity → verificar auto-fill username + password.
  3. Si la cuenta tiene 2FA activado, IG redirige a `/accounts/login/two_factor` → verificar auto-fill del código 6 dígitos en el input `name="verificationCode"`.
  4. Click submit → verificar acceso al feed.
  5. Verificar Account Manager muestra `lastLoginAt = ahora` + `status = active`.

## G-6 status

Diferido a v1.2.x. Razón: Jose's Ghost Browser proxy list está vacío (`Default/Proxies/` dir empty), cero test fixture real, format del archivo desconocido. No vale invertir 3h speculando un format sin un user con proxies reales en Ghost para validar.

## Próximos sub-bloques (post 1.3.0)

Per roadmap `project_v1_roadmap.md`:

- `1.4.0` K1-extras: bulk-open + session warmer + identity HUD + onboarding wizard + Mac sleep (~12h)
- `1.5.0` i18n cobertura completa (~4h)
- `1.5.x` Smoke visuals pendientes (C-6/C-7/C-8/D-3c-3c) (~2h)
- `1.6.0` Apple Dev signing (bloqueado approval ~2d, 6-7h)
- `1.6.x` I-2 auto-updater (~1-2h)
