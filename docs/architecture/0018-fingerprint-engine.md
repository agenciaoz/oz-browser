# ADR 0018 — FingerprintEngine "Ghost+" (1.9)

**Date:** 2026-05-10
**Status:** Accepted
**Related blocks:** 1.9a / 1.9b / 1.9c / 1.9d / 1.9e

## Context

Ghost Browser ofrece per-identity fingerprint spoofing pero falla varios checks
de Pixelscan/iphey por inconsistencias internas (UA dice Mac pero WebGL renderer
dice Intel UHD, etc). El plan original de 1.9 listaba 14 vectores spoofeados.

Antes de implementar tomamos 3 decisiones de scope (preguntadas a Jose):

1. **Vectores:** Top-9 + canvas + WebGL = 11 total. Excluimos AudioContext
   (perf overhead complicado), WebRTC disable (rompe video calls), fonts subset
   (alta complejidad + UX risk). Esos 3 quedan como mejoras post-1.10.
2. **Coherencia GeoIP:** Implementada en 1.9 vía tabla pura (no GeoIP fetch
   real). Razón: free tier de ipapi.co se llena rápido (50 proxies × 48
   tests/day = 2400 req), y GeoIP-via-proxy requiere routing complicado
   (chicken-and-egg con sessions o dep externa `https-proxy-agent`). La tabla
   `country-locale.js` cubre 80% del caso real (Oxylabs templates + manual
   con country known).
3. **CI suite (Pixelscan/CreepJS/browserleaks):** Diferida a sub-bloque 1.9.5
   dedicado (~3-4h). 1.9 implementa los vectores + tests unitarios (consistency
   - diversity per seed). El test real contra fingerprint sites llega después.

## Decision

**1. Determinismo por seed.**

Cada Identity ya tiene un `fingerprintSeed` UUID (existe desde 1.2). El
FingerprintEngine es una función pura del seed:

```
buildProfile(seed) → { ua, platform, screen, hardwareConcurrency, ... }
```

Mismo seed → mismo perfil ALWAYS (consistency per-identity). Diferentes seeds
→ perfiles coherentemente variados (diversity cross-identity). El RNG es un
SHA256 stream del seed, sin Date.now() ni Math.random() involucrados.

**Por qué importa:** los fingerprint sites detectan inconsistencias entre
páginas como flag de bot. Si la identity X carga Pixelscan dos veces y
reporta dos UAs distintos, está cocida. La consistency garantiza que el FP
NO cambia ni con regenerate sin acción explícita del user.

**2. Tabla de blueprints coherentes** (vs randomización campo-por-campo).

Cada blueprint es un perfil REAL (Mac M2 + Apple GPU + 1512x982 + Chrome
135). El RNG selecciona UN blueprint y luego escoge campos ortogonales
(languages, timezone) de pools independientes. Esto previene la inconsistencia
clásica "Mac UA + Windows WebGL" que mata Ghost en Pixelscan.

5 blueprints v1: mac-arm64-chrome, mac-x64-chrome, win-x64-chrome,
win-x64-edge, linux-x64-chrome. UAs Chrome 135 (recientes — UAs viejos son
flag de bot). Cada blueprint tiene pools de WebGL renderers compatibles con
el CPU/GPU implícito (Apple Silicon → Apple M1/M2/M3 renderers; Win NVIDIA →
RTX/GTX renderers; Linux → Mesa Intel/NVIDIA).

**3. 11 vectores en v1 (de 14 del plan original).**

Incluidos:

- (1) UA + platform + appVersion + appName + vendor — `navigator.*`
- (2) hardwareConcurrency
- (3) deviceMemory
- (4) languages + language (locale-derived)
- (5) screen + devicePixelRatio
- (6) timezone (Intl.DateTimeFormat + Date.getTimezoneOffset)
- (7) plugins + mimeTypes (PDF viewer subset, Chrome convention)
- (8) battery API (deprecated pero detectado)
- (9) speech voices (filtered list per locale)
- (10) canvas noise (toDataURL/toBlob/getImageData con perturbación
  determinística — 1 pixel de cada 1000)
- (11) WebGL vendor/renderer (getParameter override)

Excluidos:

- AudioContext noise — perf overhead complicado de balancear sin breaking
  audio playback
- WebRTC disable — rompe video calls (Discord, Meet, Zoom). Si se hace
  deshabilitar, se pierde funcionalidad real
- Fonts subset (Canvas measureText filter) — sites que requieren fuentes
  específicas (Google Docs, etc) fallan al no encontrarlas

Estos 3 quedan documentados como "exclusión consciente v1" — si un cliente
los pide explícitamente, se agregan como sub-bloque dedicado.

**4. Two-layer override: setUserAgent + preload.**

Capa de defensa en profundidad:

- `session.setUserAgent(fp.ua, fp.language)` — Chrome's network stack usa este
  UA para los headers HTTP. Defensa contra fingerprinting que compara
  `navigator.userAgent` vs el `User-Agent` request header (mismatch detection).
- `webFrame.executeJavaScript(buildOverridesScript(fp))` — el preload inyecta
  script en el page world ANTES del primer JS de la página. Aplica
  `Object.defineProperty(navigator, ...)` en el world correcto (con
  contextIsolation, el preload world y el page world están separados —
  `webFrame.executeJavaScript` cruza el límite).

Ambas capas DEBEN coincidir o un fingerprint site detecta el mismatch y nos
clasifica como bot.

**5. IPC sync para FP fetch.**

`preload-fingerprint.js` hace `ipcRenderer.sendSync('oz:fingerprint:request')`
al inicio. Sync porque el override DEBE aplicarse antes del primer JS de la
página. Local IPC < 1ms, no perf concern.

`sendSync` está deprecated en favor de `MessagePortMain` pero sigue funcionando
y la simplicidad gana en v1. Migración a MessagePort queda como mejora si
hay reportes de slow page loads (improbable).

El handler en main resuelve identityId via `event.sender.session` —
**mismo anti-spoof pattern del 1.5c**: un renderer comprometido NO puede
pedir el FP de OTRA identity.

**6. GeoIP coherence vía tabla (sin fetch real).**

`country-locale.js` con 47 países (las geos comerciales más comunes) →
`{timezone, languages, locale}`. Cuando proxy.country está conocido (Oxylabs
template lo setea, manual también), `assignToIdentity` devuelve
`geoSuggestion` en el return. UI surface "Apply locale to identity X?"
dialog. User confirma → `fingerprint.applyGeoSuggestion(id, suggestion)`
muta SOLO timezone/languages/locale. UA/screen/blueprint se preservan
(porque cambiar todo el blueprint cuando cambias proxy haría el FP
"fluctuante" — flag de bot).

**7. setProxyResolutionHook → addSessionInitHook.**

Refactor del 1.8b: en vez de UN hook único, ahora hay una lista de
`_sessionInitHooks` que se ejecutan en orden de registro. 1.8b registra el
proxy-apply hook; 1.9b registra el FP-apply hook. Hooks fail-safe (un throw
en uno NO bloquea los siguientes). `setProxyResolutionHook` queda como
single-hook legacy compat.

## Architecture

```
Identity (fingerprintSeed UUID — desde 1.2)
   │
   ▼
FingerprintEngine.getOrCreate(identityId, seed)
   │ deterministic build from seed → cached profile
   ▼
fingerprints.json (per-identity persistence)
   │
   ▼
addSessionInitHook (registered from main.js)
   │ runs on every IdentityManager.getSession() call
   │
   ├─ session.setUserAgent(fp.ua, fp.language)         ← network layer
   └─ session.registerPreloadScript(preload-fingerprint.js)
                  │
                  ▼
              preload world (every renderer):
                  │ ipcRenderer.sendSync('oz:fingerprint:request')
                  │ → main resolves via event.sender.session
                  │ → returns full FP object
                  ▼
              webFrame.executeJavaScript(buildOverridesScript(fp))
                  │ runs IIFE in PAGE WORLD before first page JS
                  ▼
              navigator.* + screen.* + Intl.* + canvas + WebGL all spoofed
```

GeoIP coherence flow:

```
Proxy with country='AR' assigned to identity-X
   │ proxy-handlers.assignToIdentity returns
   │   { ok, geoSuggestion: {country:'AR', timezone, languages, locale} }
   ▼
UI / agent shows "Apply locale to identity-X?"
   │ user confirms
   ▼
fingerprint-handlers.applyGeoSuggestion(identity-X, suggestion)
   │ mutates ONLY timezone+languages+locale on cached profile
   │ broadcasts oz:fingerprint:changed
   ▼
Next page load picks up new locale (preload re-fetches FP via sendSync)
```

## Consequences

**Positive:**

- Pixelscan/CreepJS deberían pasar (validación real en 1.9.5).
- Determinismo: la identity siempre se ve igual desde el lado del fingerprint
  site (consistency).
- Coherencia: blueprint pre-armado evita "Mac UA + Win WebGL" inconsistencias.
- 23 MCP tools `oz.proxies.*` + `oz.fingerprint.*` exponen todo para
  automation (un agente puede `assignToIdentity` y luego
  `applyGeoSuggestion(id, suggestion)` en el mismo flow).
- GeoIP coherence sin deps + sin rate-limit — la tabla cubre 47 países.
- FingerprintEngine 100% testeable sin Electron (pure functions).
- Defense in depth: setUserAgent + preload coinciden, no detection mismatch.

**Negative:**

- AudioContext / WebRTC / fonts NO spoofeadas — algunos sitios que checan
  esos vectores nos detectarán como inconsistente. Mitigación: agregamos en
  v2 si reporte real lo justifica.
- Determinism puro significa que si el seed leak (ej via vault export sin
  encryption), un atacante puede recrear el FP exacto. Mitigación: el seed
  vive en identities.json (no en vault) pero el riesgo es bajo.
- GeoIP via tabla NO detecta cambios de IP del proxy (rotación). Si Oxylabs
  rota a un IP de UK pero el proxy.country sigue en US, suggestion stale.
  Mitigación: futuro auto-refresh tras N requests.
- Preload sync IPC bloquea el page load por <1ms. Si main process está
  saturado por race conditions, podría notarse. Mitigación: getOrCreate
  es 100% sync (memoria + un disk write si first-time).

**Métricas de cierre:**

- 5 sub-fases (1.9a / 1.9b / 1.9c [combinado en 1.9b por simplicidad] / 1.9d
  / 1.9e) en una sesión, ~5h efectivas vs ~10h estimadas (-50% por scope
  ajustado en 3 preguntas).
- 6 archivos source nuevos: fingerprint-engine.js, preload-fingerprint.js,
  fingerprint-handlers.js, mcp-tools-fingerprint.js, country-locale.js + el
  refactor de identity-manager (addSessionInitHook).
- 2 tests nuevos: fingerprint-engine (96), country-locale (39) = 135 nuevos.
- mcp-server: 127 → 132 (+5 fingerprint tools).
- Total proyecto: 930 → 1070 (+140).
- 0 deps npm nuevas.

## Alternatives considered

- **Fork Chromium para hardcodear FP:** descartado desde Etapa 0 — alto
  costo de maintenance + UI lift. El approach de preload + setUserAgent es
  el "Ghost+" que prometimos sin fork.
- **Randomización campo-por-campo (vs blueprint):** descartado por la
  inconsistencia interna que produce (Mac UA + NVIDIA renderer = bot
  detection). Blueprint coherente es la fix obvia.
- **GeoIP fetch real con ipapi.co:** descartado v1 por rate limit (1000
  req/day) + complejidad de routing through proxy + dep `https-proxy-agent`.
  Tabla pura cubre 80%. Re-evaluar en 1.10.
- **AudioContext / WebRTC / fonts en v1:** descartados por trade-off costo
  / UX risk. Documentados explícitamente para no perder track.
- **MessagePortMain en vez de sendSync:** descartado por complejidad — la
  API es nueva (Electron 30+) y requiere un setup de port manual. sendSync
  funciona, es simple, y el deprecation warning es manejable.
