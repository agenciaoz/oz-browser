# Bloque fp-hook-order-fix — CRITICAL anti-detect engine restored

**Status:** ✅ Cerrado 2026-05-15
**Commit:** `fa418f3`
**Version:** 1.4.5 (patch)
**Tiempo efectivo:** ~1h (incluyendo debug intensivo)
**Deps nuevas:** 0
**Tests nuevos:** 0 (~10-line reorder fix)

## Origen — FP UA seguía sin aplicarse post-bundle fix

Tras v1.4.4 (bundle fix) el preload-fingerprint.js cargaba sin error, pero el UA override seguía sin aplicarse. Page console mostraba `Mozilla/5.0 (Macintosh) ... OZBrowser/1.4.4 ... Electron/42.0.1` en lugar del FP-generated Chrome 135 Linux/Windows/etc.

## Investigación

Agregué INFO logging al FP session-init hook. Boot log reveló que **el hook NUNCA firaba** para las identities — visible como ausencia total de `[fingerprint-preload-setup] session UA set from FP` logs.

Pero `[identity-manager] session init hook appended {total:N}` SÍ aparecía — el hook estaba registrado.

Root cause: `AntiLogout.install()` corría DURANTE el init() **ANTES** de que `setupFingerprintPreload(this)` + `setupHud(this)` registraran sus `identityManager.addSessionInitHook()` callbacks. AntiLogout.install() itera `identityManager.list()` (12 identities en setup de Jose) y llama `getSession(id)` para cada una — eso CACHEA las sessions sin que los hooks de FP + HUD hayan fired.

Después de eso, cuando los tabs se materializan, las sessions vienen del cache (`getSession` returns early if `sessionCache.has(id)`) y los hooks NO se ejecutan.

## Fix

Defer `this.antiLogout.install()` a DESPUÉS de `setupFingerprintPreload(this)` + `setupHud(this)` en main.js. Constructor de AntiLogout queda donde estaba (no side effects). Cambio neto ~10 líneas movidas + comment explicativo.

```js
// ANTES:
this.antiLogout = new AntiLogout({...})
this.antiLogout.install() // ← fires getSession() too early
// ...later...
require('./fingerprint-preload-setup').setupFingerprintPreload(this)
require('./hud-setup').setupHud(this)

// DESPUÉS:
this.antiLogout = new AntiLogout({...})
// install() deferred
// ...
require('./fingerprint-preload-setup').setupFingerprintPreload(this)
require('./hud-setup').setupHud(this)
this.antiLogout.install() // ← now hooks fire correctly
```

## Smoke visual 2026-05-15 PASS end-to-end

IG 2 tab (identityId `8ffa1008da6a795f`, FP profile pt-BR Linux):

- `navigator.userAgent` → `Mozilla/5.0 (X11; Linux x86_64) ... Chrome/135.0.0.0 Safari/537.36` ✅
- `navigator.platform` → `Linux x86_64` ✅
- `navigator.languages` → `['pt-BR', 'pt', 'en']` ✅
- `navigator.hardwareConcurrency` → `12` ✅
- **Instagram automáticamente sirvió la página en portugués** — confirma que el Accept-Language header coherent con navigator.languages está siendo enviado.

Boot log evidence: `[fingerprint-preload-setup] session UA set from FP {identityId, ua, language}` aparece 12 veces (una per identity hooked por AntiLogout), seguidas inmediatamente por `[anti-logout] cookie hook installed {identityId, hostsCount:32}`.

## Impacto

**Anti-detect engine ahora opera por primera vez en este build.** Las 12 identidades generan fingerprints únicos consistentes per-identity:

- IG 2 → Linux Chrome 135 pt-BR
- 4c6c37aac35648ea → Windows Edge 135 fr-FR
- 1064b87a6d8b2263 → Windows Edge 135 fr-FR
- 08f29d3f97bc9a79 → Linux Chrome 135 de-DE
- 2e270e3b032df21f → Mac Chrome 135 ja-JP
- … (etc, total 12 con blueprints variados)

Cada identity tiene UA + platform + languages + timezone + screen + WebGL vendor/renderer + canvas noise + hardware coherentes.

## Why this was silently broken for so long

El FP nunca tuvo smoke visual real (changelog v1.1.4 menciona "Smoke visual REAL pendiente con app corriendo"). El bundle fix v1.4.4 también surface'd este bug porque sin el bundle fix los preloads no cargaban en absoluto, lo que oscurecía el reorder issue.
