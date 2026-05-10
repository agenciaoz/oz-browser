# Bloque 1.9 — FingerprintEngine "Ghost+" (cierre)

**Fecha:** 2026-05-10
**Tiempo efectivo:** ~5h vs ~10h estimadas (-50% por scope ajustado en 3 preguntas)
**Sub-fases:** 1.9a / 1.9b / 1.9c (combinado en 1.9b) / 1.9d / 1.9e
**Total tests proyecto:** 930 → **1070** (+140)
**Deps nuevas:** 0
**ADR:** 0018 — FingerprintEngine "Ghost+"
**CHANGELOG:** entrada agregada
**Próximo:** sub-bloque 1.9.5 (Pixelscan/CreepJS CI suite, ~3-4h)

## Decisiones de scope (preguntadas a Jose antes de codear)

1. **Vectores:** 11 total (Top-9 + canvas + WebGL). Excluidos AudioContext,
   WebRTC disable, fonts subset (alto bug risk + UX risk).
2. **Coherencia GeoIP:** En 1.9 vía tabla pura (no GeoIP fetch real). Cubre
   80% del caso real con cero deps nuevas.
3. **CI suite Pixelscan/CreepJS:** Diferida a sub-bloque 1.9.5 dedicado.

## Qué se entregó

### 1.9a — FingerprintEngine core + persistence

**Archivos nuevos:**

- `browser/fingerprint-engine.js` (~390 LOC): clase `FingerprintEngine` +
  función pura `buildProfile(seed)`. SHA256-stream RNG determinístico.
  5 blueprints coherentes (mac-arm64-chrome, mac-x64-chrome, win-x64-chrome,
  win-x64-edge, linux-x64-chrome) con UAs Chrome 135 reales + WebGL
  renderers compatibles per blueprint. 11 LOCALE_PROFILES + speech voices
  per locale + 5 plugins PDF estándar. API: `getOrCreate`, `regenerate`,
  `applyGeoSuggestion` (muta solo locale fields, preserva UA/screen),
  `get`, `remove`. Persistencia en `fingerprints.json` (NO regenera per
  session — consistency).

**Tests:** `tests/fingerprint-engine.smoketest.js` con 96/96 verde. Cubre
determinismo (mismo seed = mismo perfil), diversidad (20 seeds → ≥3 UAs +
blueprints + screens + locales distintos), coherencia (Mac NUNCA tiene UA
Windows, WebGL renderer del blueprint pool), 11 vectores presentes,
validación, persistence round-trip, regenerate creates new + mints seed,
applyGeoSuggestion muta solo locale, remove cleans cache.

### 1.9b — Preload script content + apply 11 vectores + setUserAgent

**Archivos nuevos:**

- `browser/preload-fingerprint.js` (~290 LOC): content script per-identity
  que aplica los overrides en page world via `webFrame.executeJavaScript`
  ANTES del primer JS de la página. Pattern: `ipcRenderer.sendSync(
'oz:fingerprint:request')` (local, <1ms) + `buildOverridesScript(fp)`
  IIFE con todos los hooks (navigator.{userAgent, appVersion, appName,
  vendor, platform, hardwareConcurrency, deviceMemory, language,
  languages, plugins, mimeTypes, getBattery}, window.screen.\* +
  devicePixelRatio, Intl.DateTimeFormat.resolvedOptions + Date.prototype.
  getTimezoneOffset, speechSynthesis.getVoices, canvas hooks, WebGL hooks).

**Refactor identity-manager.js:** `setProxyResolutionHook` queda como
single-hook legacy + nuevo `addSessionInitHook(fn)` que permite múltiples
hooks ordenados. 1.8b registra el proxy hook, 1.9b registra el FP hook.
Hooks fail-safe (un throw NO bloquea los siguientes).

**Wiring en main.js:**

- Instancia FingerprintEngine post-Vault.
- Sync IPC handler `oz:fingerprint:request` resuelve via
  `event.sender.session` (mismo anti-spoof que 1.5c — renderer NO puede
  pedir FP de otra identity).
- `addSessionInitHook` aplica `session.setUserAgent(fp.ua, fp.language)` +
  `registerPreloadScript({type:'frame', filePath: preload-fingerprint.js})`
  por cada identity session.

### 1.9c — Canvas noise + WebGL spoofing (combinado en 1.9b)

Implementado en el mismo `buildOverridesScript` del 1.9b — split conceptual
no warrant code split:

- **Canvas:** `HTMLCanvasElement.prototype.toDataURL/toBlob` +
  `CanvasRenderingContext2D.prototype.getImageData` con noise
  determinístico via mulberry32 RNG sembrado por `fp.canvasNoiseSeed`
  (1 pixel de cada 1000 perturbado ±1 — no perceptible visualmente, pero
  cambia el hash).
- **WebGL:** `WebGLRenderingContext.prototype.getParameter` +
  `WebGL2RenderingContext.prototype.getParameter` override para parámetros
  37445 (UNMASKED_VENDOR_WEBGL), 37446 (UNMASKED_RENDERER_WEBGL), 7936
  (VENDOR), 7937 (RENDERER).

### 1.9d — GeoIP coherence vía tabla (sin fetch real)

**Archivos nuevos:**

- `browser/country-locale.js` (~80 LOC): tabla puro de 47 países (US, AR,
  BR, ES, JP, etc) → `{timezone, languages, locale}`. `resolveCountry(cc)`
  case-insensitive. `listCountries()` sorted.
- `browser/fingerprint-handlers.js` (~90 LOC): handler map con `get`,
  `regenerate`, `applyGeoSuggestion` (acepta {country:'JP'} resolved via
  tabla, o {timezone, languages, locale} verbatim), `resolveCountry`,
  `remove`.

**Refactor proxy-handlers.js:**

- `assignToIdentity` y `assignToWorkspace` cambiaron return type de
  `boolean` a `{ok, geoSuggestion?}`. Cuando el proxy resolved tiene
  `country` known, geoSuggestion contiene el locale profile. UI/agent
  surface "Apply locale to identity X?" dialog.

**Tests:** `tests/country-locale.smoketest.js` con 39/39 verde. Cubre
resolveCountry (válidos US/AR/JP, case-insensitive, unknown null,
empty/null/non-string handling), listCountries (sorted, dedupe, no
mutación), fingerprint-handlers.applyGeoSuggestion via country code +
explicit + UNKNOWN_COUNTRY error + IDENTITY_NOT_FOUND error,
proxy-handlers.assignToIdentity returns geoSuggestion para AR/US +
no suggestion para proxy sin country + clear assignment + workspace.

### 1.9e — MCP tools + ADR + cierre

**Archivos nuevos:**

- `browser/mcp-tools-fingerprint.js` (~110 LOC): 6 tools `oz.fingerprint.*`
  (get, regenerate, applyGeoSuggestion, resolveCountry, listCountries,
  remove). Spread'eados en mcp-tools.js (split por ADR 0005).

**Contract test IPC↔MCP** extendido en `tests/mcp-server.smoketest.js`:

- Regex actualizado para incluir `fingerprint`.
- mcp-server: 127 → 132 (+5 fingerprint tools detectados auto).

## Lo que está funcionando

- Cada identity tiene un FP determinístico generado al primer uso de su
  session.
- Override aplicado en 2 capas: setUserAgent (network) + preload
  (page world).
- 11 vectores spoofeados consistentemente: navigator.\*, screen, dpr,
  timezone, plugins, battery, speech, canvas hash, WebGL.
- Determinismo: mismo identity = mismo FP siempre.
- Diversidad: identities distintas = perfiles coherentemente variados.
- GeoIP coherence: cuando asignas un proxy con country → suggestion
  surface en UI/MCP → user confirma → locale aplicado.
- 6 MCP tools `oz.fingerprint.*` para automation flows.

## Issues resueltos

- **setProxyResolutionHook → addSessionInitHook**: el approach del 1.8b
  no escalaba a múltiples sistemas (1.9 también necesita hook). Refactor a
  lista de hooks con orden de registro garantizado. Backward-compat:
  setProxyResolutionHook sigue existiendo.
- **assignToIdentity return type**: cambió de `boolean` a `{ok,
geoSuggestion?}` para surfacear la suggestion. Breaking change documentado.
- **WebGL hook test crítico**: vendor en parámetro 37445 (debug ext) +
  7936 (standard). Si solo hookeas uno, fingerprint sites detectan
  inconsistencia ("getParameter(37445) returns spoofed pero getParameter
  (7936) returns native").

## Decisiones honestas (excluidas de v1)

- **AudioContext noise**: perf overhead complicado de balancear. Algunos
  sites (CreepJS) checkean — los detectaremos como inconsistente hasta v2.
- **WebRTC disable**: rompe video calls reales (Discord, Meet, Zoom). No
  se hace.
- **Fonts subset**: rompe Google Docs y otros que requieren fuentes
  específicas. No se hace.
- **GeoIP fetch real (vs tabla)**: free tier de ipapi.co se llena rápido
  - routing through proxy es complicado. Tabla cubre 80%. Auto-detect
    llega en 1.10 si demand real.

## Tests

- 1070/1070 totales verde (vs 930 al cierre del 1.8).
- Suite per archivo:
  - account-handlers: 51, account-vault: 30, anti-logout: 38
  - backup-manager: 40, bookmark-manager: 50, cookies-io: 72
  - **country-locale: 39 (NUEVO)**
  - excel-io: 25
  - **fingerprint-engine: 96 (NUEVO)**
  - identity-manager: 29
  - mcp-server: 132 (+5 fingerprint tools vs 127)
  - move-to-workspace: 29, site-templates: 125, tab-context-handlers: 64
  - window-workspace: 36, workspace-manager: 56
  - proxy-manager: 58, proxy-assignment: 30, proxy-health: 25,
    proxy-csv: 45

## Costos

- **Tiempo:** ~5h vs ~10h estimadas (-50% por scope ajustado en preguntas).
- **Deps npm nuevas:** 0.
- **LOC source:** ~1100.
- **LOC tests:** ~700.

## Archivos modificados

**Nuevos (8):**

- `browser/fingerprint-engine.js`, `browser/preload-fingerprint.js`,
  `browser/fingerprint-handlers.js`, `browser/mcp-tools-fingerprint.js`,
  `browser/country-locale.js`
- `tests/fingerprint-engine.smoketest.js`,
  `tests/country-locale.smoketest.js`
- `docs/architecture/0018-fingerprint-engine.md`
- `docs/history/15-bloque-1.9-resultado.md` (este file)

**Modificados:**

- `browser/main.js` — instancia FingerprintEngine + ipcMain.on sync
  handler + addSessionInitHook wiring (UA + preload registration)
- `browser/identity-manager.js` — addSessionInitHook nuevo método +
  invocación post session creation
- `browser/ipc-handlers.js` — wire fingerprint handlers + 5 IPC channels
- `browser/mcp-tools.js` — spread buildFingerprintTools
- `browser/proxy-handlers.js` — assignToIdentity/Workspace return
  geoSuggestion derivada de proxy.country
- `preload.js` — `window.oz.fingerprint.*` (5 métodos + onChanged)
- `tests/mcp-server.smoketest.js` — extender regex para fingerprint
- `CHANGELOG.md` — entrada del bloque
- `docs/PLAN-MAESTRO.md` — 1.9 ✅
- `docs/architecture/README.md` — ADR 0018

## Próximo paso

**Sub-bloque 1.9.5 — Pixelscan/CreepJS/iphey/browserleaks CI suite (~3-4h):**
Test runner con Electron headless + script puppeteer-like que abre N
identities distintas en cada uno de los 4 fingerprint sites. Parsea el JSON/
HTML de la respuesta y valida:

1. **Per-identity consistency**: cada identity reporta el mismo perfil en
   todos los sites (UA en Pixelscan === UA en CreepJS === UA en iphey).
2. **Cross-identity diversity**: las N identities reportan perfiles
   coherentemente variados (no todas el mismo).
3. **Threshold pass**: Pixelscan score > X, CreepJS detection score < Y.

Si el threshold baja, el CI bloquea el release. Las fallas detectadas
informan el roadmap (ej: "AudioContext detection sigue red en CreepJS"
→ implementar en 1.9.6).

Después de 1.9.5: **Bloque 1.10 Settings UI + Bookmarks/Downloads/History
pages + Polish + Extensions multi-identity + M-series perf** (~16h). Es el
último bloque grande de la Sub-Etapa 1A CORE. Después arranca Sub-Etapa 1B
(distribución, billing).

## Validación visual

Pendiente al cierre del 1.9.5 — abrir https://pixelscan.net y https://
abrahamjuliot.github.io/creepjs/ con 3 identities distintas, validar que
reportan UAs/screens/timezones distintos pero internamente consistentes.
