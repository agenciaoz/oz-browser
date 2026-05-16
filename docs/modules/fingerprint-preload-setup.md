# Módulo `fingerprint-preload-setup`

**Path:** `browser/fingerprint-preload-setup.js`
**Líneas:** ~60
**Bloque/Etapa:** 1.9b (extraído) + v1.4.4 (bundle path) + v1.4.5 (hook order fix)

## Qué hace

Wirea un session-init hook en `IdentityManager` que aplica el FingerprintEngine profile a cada session de identity en **dos capas defense-in-depth**:

| Capa        | Mecanismo                                                       | Para qué                                                                                                                                 |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Network | `session.setUserAgent(fp.ua, fp.language)`                      | Headers de fetch/XHR + Accept-Language. Aplica incluso si el renderer bypassa el preload.                                                |
| (b) Content | `session.registerPreloadScript({filePath: bundled FP preload})` | Overrides en webFrame: `navigator.userAgent/platform/languages/hardwareConcurrency`, canvas noise, audio context, WebGL vendor/renderer. |

Ambas capas deben **coincidir** — sino fingerprinting tools detectan el mismatch (clasico: `navigator.userAgent` reporta Chrome 135 pero el request UA dice Electron/42 → flagged como bot/spoofed).

## Historia

- **1.9b:** lógica original inline en `browser/main.js` `Browser.init()` post-`new FingerprintEngine()`.
- **v1.4.3:** extracted a este módulo para mantener `main.js` ≤500 LOC (ADR 0005). Cambio neto: 0 lógica, solo move.
- **v1.4.4 (sandbox-preload-fix):** `fpPreloadPath` ahora apunta a `browser/.bundled/preload-fingerprint.bundled.js` en lugar de `browser/preload-fingerprint.js`. El raw source falla silenciosamente en sandboxed mode por `require('./preload-fingerprint-script')`.
- **v1.4.5 (fp-hook-order-fix):** main.js reordered — `setupFingerprintPreload(this)` DEBE correr ANTES de `antiLogout.install()`. AntiLogout itera `identityManager.list()` y llama `getSession(id)` por identity, lo que cachea sessions y previene que hooks registered after fire.

## API

```js
const { setupFingerprintPreload } = require('./fingerprint-preload-setup')

setupFingerprintPreload(browser)
// → boolean (true si wireado, false si missing identityManager o fingerprintEngine)
```

Defensive: si `browser.identityManager` o `browser.fingerprintEngine` no existen, retorna `false` sin throw (permite testear main.js sin engines wired).

## Behavior

Por cada session-init hook fire (1 vez per identity, on first `getSession(id)`):

```js
browser.identityManager.addSessionInitHook((identityId, session) => {
  const ident = identityManager.get(identityId)
  if (!ident) return // identity deleted entre add y fire
  const fp = fingerprintEngine.getOrCreate(identityId, ident.fingerprintSeed)
  if (fp && fp.ua) {
    session.setUserAgent(fp.ua, fp.language || 'en-US') // capa (a)
    log.debug('fingerprint-preload-setup', 'session UA set from FP', {
      identityId,
      ua: fp.ua,
    })
  }
  if (typeof session.registerPreloadScript === 'function') {
    session.registerPreloadScript({
      // capa (b)
      type: 'frame',
      id: 'oz-fingerprint-preload',
      filePath: '<repoRoot>/browser/.bundled/preload-fingerprint.bundled.js',
    })
  }
})
```

`fp.ua` viene del blueprint del FingerprintEngine — Chrome 135 Linux pt-BR, Mac Chrome 135 ja-JP, Windows Edge 135 fr-FR, etc, generado deterministically per `fingerprintSeed`.

## Critical: hook order

**El orden de llamadas en `main.js` es load-bearing:**

```js
// Constructor (no side effects):
this.antiLogout = new AntiLogout({...})

// ... FP + HUD primero ...
require('./fingerprint-preload-setup').setupFingerprintPreload(this)
require('./hud-setup').setupHud(this)

// AntiLogout DESPUÉS (install() llama getSession() y cachea):
this.antiLogout.install()
```

**Si invertís el orden** → AntiLogout cachea sessions ANTES de que el FP hook esté registered → hooks no fire → UA default OZBrowser/Electron se queda → anti-detect engine roto silentemente.

Smoke visual evidence (v1.4.5 PASS):

```text
[fingerprint-preload-setup] session UA set from FP {identityId, ua: Chrome/135 Linux pt-BR}
[anti-logout] cookie hook installed {identityId, hostsCount: 32}
```

(Línea FP aparece ANTES que la línea AntiLogout per identity — confirma el orden correcto.)

## Tests

No tests dedicados — es ~30 LOC de wire-up que delega a `fingerprintEngine.getOrCreate()` (testeado en `fingerprint-engine.smoketest.js`) y `session.registerPreloadScript()` (Electron primitive). Validación:

1. **Boot log:** `[fingerprint-preload-setup] session UA set from FP` aparece N veces (1 per identity con AntiLogout install — 12 en setup de Jose).
2. **Smoke visual:** open IG tab con identity X → DevTools console → `navigator.userAgent` debe matchear `fp.ua` del blueprint, no default.
3. **Coherence check:** `navigator.languages[0]` debe matchear el header Accept-Language enviado al server (verificable porque Instagram sirve la página automáticamente en el idioma → if FP es pt-BR, IG sirve português).

## Gotchas

- **`fingerprintSeed` es per-identity y stable** — re-crear una identity con mismo seed regenera el mismo FP. Útil para replay/debug.
- **`getOrCreate`** lee `userData/fingerprints.json` (persisted). Primera invocación per identity genera + persiste, subsequent reads.
- **`session.setUserAgent` ANTES de `registerPreloadScript`** importa — algunas pages cachean UA en service workers en el primer fetch, y queremos que el primer fetch ya tenga el UA correcto.
- **`type: 'frame'`** en registerPreloadScript es **crítico** — `'service-worker'` no funciona para overrides de DOM. (Bug capturado en v1.9c, ya en blueprint.)
- **`browser.fingerprintEngine` debe existir** antes del call — `main.js` instancia `new FingerprintEngine()` ANTES de `setupFingerprintPreload(this)`.

## Consumers

- `browser/main.js` — único callsite, post-FP-engine-construction, pre-AntiLogout-install.

## Sub-bloque pendiente

- **Investigar sandbox sibling-require bug root cause** (compartido con `bundle-preloads.md`) — si fix upstream, podríamos eliminar el bundle step y apuntar al source directo.
- **Smoke visual test de cada FP override individualmente** (canvas / audio / webgl) — el UA está confirmed, los otros vectores no tienen smoke explícito todavía.
