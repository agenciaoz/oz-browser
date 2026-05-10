# Bloque 1.8 — Proxy Manager (cierre)

**Fecha:** 2026-05-10
**Tiempo efectivo:** ~6h vs ~12h estimadas (-50% por scope ajustado en 3 preguntas a Jose)
**Sub-fases:** 1.8a / 1.8b / 1.8c / 1.8d / 1.8e
**Total tests proyecto:** 750 → **908** (+158)
**Deps nuevas:** 0 (csv-parse ya pre-instalada)
**ADR:** 0017 — Proxy model + assignment hierarchy + auto-disable
**CHANGELOG:** entrada agregada

## Decisiones de scope (preguntadas a Jose antes de codear)

1. **Provider templates:** Solo Oxylabs real, los 3 otros (Bright Data /
   Smartproxy / IPRoyal) stubs marcados "Coming soon".
2. **Bandwidth meter:** Placeholder en 1.8 (`bandwidthBytesUsed: 0`,
   columna UI "—"). Real instrumentación en 1.10.
3. **Health daemon:** Manual + Daemon liviano (cada 30 min, auto-disable
   después de 3 fallas).

## Qué se entregó

### 1.8a — ProxyManager + Auto-Assign + persistence

**Archivos nuevos:**

- `browser/proxy-manager.js` (~280 LOC) — clase `ProxyManager` con CRUD +
  persistence `proxies.json` + `autoAssign(strategy)` random/round-robin +
  health helpers (`recordHealthSuccess`, `recordHealthFailure` con
  auto-disable después de 3 fails) + `bulkAdd()`. Modelo Proxy con 12
  campos. Validación de protocolo (http/https/socks5) y port (1-65535).
  `isActive` (user) vs `isDisabled` (daemon) — separadas para que setActive
  manual recupere de auto-disable.
- `browser/proxy-handlers.js` (~280 LOC) — handler map IPC↔MCP.

**IPC channels:** `oz:proxies:list`, `listAssignable`, `get`, `create`,
`update`, `remove`, `setActive`, `autoAssign`, `bulkAdd`.

**Tests:** `tests/proxy-manager.smoketest.js` con 58/58 verde. Cubre
validación, CRUD, listAssignable filtra disabled+inactive, autoAssign random

- round-robin con cursor que cicla y wrappea, persistence round-trip,
  recordHealthSuccess/Failure, auto-disable después de 3 fails y
  auto-re-enable on success, handlers wrappers + broadcasts.

### 1.8b — Asignación per-identity + per-workspace + jerarquía + auth

**Archivos nuevos:**

- `browser/proxy-assignment.js` (~210 LOC) — clase `ProxyAssignment` con
  storage `proxy-assignments.json`. API: `assignToIdentity(id, value)`,
  `assignToWorkspace(id, value)`, `setDefaultStrategy(strategy)`,
  `clearByProxyId(id)` (cascade-clean cuando se borra un proxy),
  `resolve({identityId, workspaceId})` con jerarquía Identity > Workspace
  > defaultStrategy. value puede ser proxyId, 'auto-random',
  > 'auto-round-robin', o null (clear). `toProxyRulesString(proxy)` para
  > Electron's `session.setProxy({proxyRules})`.

**Per-tab proxy NO supported v1** (limitación honesta documentada en ADR 0017
— `session.setProxy` es per-session, las tabs comparten session por
identity. Workaround: Duplicate→New Identity y assignToIdentity).

**Wiring en main.js:**

- `IdentityManager.setProxyResolutionHook(fn)` nuevo método; main.js wirea
  hook que aplica `session.setProxy({proxyRules})` post-creation.
- `app.on('login')` handler para HTTPS proxy auth (ADR 0004) — resuelve
  proxy desde event.webContents.session, devuelve username/password.

**IPC channels:** `oz:proxies:assignToIdentity`, `assignToWorkspace`,
`setDefaultStrategy`, `listAssignments`, `resolveForIdentity`.

**Tests:** `tests/proxy-assignment.smoketest.js` con 30/30 verde. Cubre
jerarquía Identity > Workspace > default, auto-\* materialization,
disabled/inactive proxies → null, clearByProxyId cascada, persistence
round-trip, validación setDefaultStrategy, toProxyRulesString por protocol.

### 1.8c — Health daemon + test conectividad + auto-disable

**Archivos nuevos:**

- `browser/proxy-health.js` (~210 LOC) — clase `ProxyHealth` con
  `testOne(proxyId)` (TCP+CONNECT handshake parse, status 200/407 → ok),
  `testAll({parallel})` (Promise.all sobre listAssignable),
  `startDaemon({intervalMs})` setInterval (default 30 min),
  `stopDaemon()`. Notification dispatch on auto-disable. Hooks
  inyectables (`tcpConnect`, `connectViaProxy`) para tests sin red real.

**Wiring en main.js:**

- Instancia `ProxyHealth` post-ProxyManager con notify dispatcher
  (`Notification` lazy import).
- Daemon arranca en init() (30 min interval).
- Daemon stop en before-quit hook.

**IPC channels:** `oz:proxies:testConnectivity`, `testAll`.

**Tests:** `tests/proxy-health.smoketest.js` con 25/25 verde. Cubre
success path + record latency, failure path + auto-disable después de 3
fails, notification dispatched, broadcast después de cada test, testAll
parallel, empty pool, daemon start/stop idempotent + tick fires testAll.

### 1.8d — CSV import + Oxylabs template + UI dedicada

**Archivos nuevos:**

- `browser/proxy-csv.js` (~110 LOC) — `parseCsv(content)` + `encodeCsv()`
  con csv-parse/sync. Headers tolerant (case-insensitive + alias
  user/pass/ip). Tags split por `|` o `;`. Filas sin host/port skipeadas.
  RFC4180-ish escape para encode.
- `browser/proxy-providers.js` (~150 LOC) — registry de 4 providers.
  `expandOxylabs({endpoint, customer, password, count, country, sesstimeMin,
startSessId})` real con username pattern
  `customer-{user}-cc-{country}-sessid-NNNNNN-sesstime-{min}`. 3 stubs
  retornan `{__error:{code:'COMING_SOON'}}`.
- `browser/ui/proxy-manager.js` (~410 LOC) — modal dedicada con 3 vistas
  conmutables (list / editor / providers). Tabla con status badges, botones
  Test/Edit/Disable/Delete por row, toolbar con Add/Import/Export/Providers/
  Test all. Editor form 7 fields. Providers grid con cards + Oxylabs form
  expandible.

**Markup HTML/CSS** en `webui.html`: botón "🌐 Proxies" en sidebar (azul,
estilo igual a 🔐 Accounts y ⏱ Time Machine), modal full-screen + ~150 LOC
de CSS para tabla, badges, formularios, cards de providers.

**IPC channels:** `oz:proxies:importCsvContent`, `importCsvFromFile`,
`exportCsvContent`, `exportCsvToFile`, `listProviders`, `expandProvider`,
`pickCsvImportPath` (UI-only), `pickCsvExportPath` (UI-only).

**Tests:** `tests/proxy-csv.smoketest.js` con 45/45 verde. Cubre parseCsv
basic + header tolerance + alias + skip bad rows + malformed → error,
encodeCsv lossless con escapes RFC4180, expandOxylabs sequential sessids

- validación, listProviders shape, COMING_SOON stubs, unknown provider
  error.

### 1.8e — MCP tools + ADR + cierre

**Archivos nuevos:**

- `browser/mcp-tools-proxies.js` (~250 LOC) — 22 tools `oz.proxies.*`
  spread'eados en mcp-tools.js. Cubre todos los handlers (list/CRUD,
  setActive, autoAssign, bulkAdd, assign* con jerarquía, listAssignments,
  resolveForIdentity, testConnectivity, testAll, importCsv*, exportCsv\*,
  listProviders, expandProvider).

**Contract test IPC↔MCP** extendido en `tests/mcp-server.smoketest.js`:

- Regex actualizado para incluir `proxies` además de los previos.
- Exempt set agregado: `oz:proxies:pickCsvImportPath`,
  `oz:proxies:pickCsvExportPath` (UI-only file dialogs).
- Test mcp-server: 105 → 127 (+22 tools detectados automáticamente).

## Lo que está funcionando

- Botón 🌐 Proxies en sidebar abre modal dedicada.
- Add proxy via form (host, port, protocol, auth).
- Import CSV via file dialog (formato Ghost-compat).
- Export CSV de todos los proxies.
- Provider templates: Oxylabs real (genera N proxies con sessid sequential).
- Provider stubs visibles con badge "Coming soon".
- Test individual + Test all (paralelo con loading state).
- Auto-disable después de 3 fallas + notification del OS.
- Daemon cada 30 min en background sobre proxies activos.
- Asignación per-identity + per-workspace via API/MCP (UI completa de
  asignación llega en 1.10 — por ahora via MCP `oz.proxies.assignToIdentity`).
- HTTPS proxy auth automática en navegación real (app.on('login') handler).

## Issues resueltos

- **Per-tab proxy:** decisión arquitectónica honesta — Electron `session.setProxy`
  es per-session, no per-tab. Documentado en ADR 0017 como limitación v1
  con workaround (Duplicate→New Identity).
- **csv-parse exports issue:** `require('csv-parse/package.json')` falla por
  exports map; usamos `require('csv-parse/sync').parse` que sí funciona.

## Tests

- 908/908 totales verde (vs 750 al cierre del 1.7).
- Suite per archivo:
  - account-handlers: 51, account-vault: 30, anti-logout: 38
  - backup-manager: 40, bookmark-manager: 50, cookies-io: 72
  - excel-io: 25, identity-manager: 29
  - mcp-server: 127 (+22 vs 105 — proxies tools)
  - move-to-workspace: 29, site-templates: 125, tab-context-handlers: 64
  - window-workspace: 36, workspace-manager: 56
  - **proxy-manager: 58 (NUEVO)**
  - **proxy-assignment: 30 (NUEVO)**
  - **proxy-health: 25 (NUEVO)**
  - **proxy-csv: 45 (NUEVO)**

## Costos

- **Tiempo:** ~6h efectivas vs ~12h estimadas (-50% por scope ajustado).
- **Deps npm nuevas:** 0 (csv-parse ya estaba).
- **LOC source agregadas:** ~1900 (handlers + UI + MCP tools + ADR).
- **LOC tests:** ~1100.
- **Costo monetario:** $0.

## Archivos modificados

**Nuevos (12):**

- `browser/proxy-manager.js`, `browser/proxy-handlers.js`,
  `browser/proxy-assignment.js`, `browser/proxy-health.js`,
  `browser/proxy-csv.js`, `browser/proxy-providers.js`,
  `browser/mcp-tools-proxies.js`, `browser/ui/proxy-manager.js`
- `tests/proxy-manager.smoketest.js`, `tests/proxy-assignment.smoketest.js`,
  `tests/proxy-health.smoketest.js`, `tests/proxy-csv.smoketest.js`
- `docs/architecture/0017-proxy-model.md`
- `docs/history/14-bloque-1.8-resultado.md` (este file)

**Modificados:**

- `browser/main.js` — instancia ProxyManager + ProxyAssignment + ProxyHealth +
  app.on('login') handler + setProxyResolutionHook wiring + daemon stop on quit.
- `browser/identity-manager.js` — `setProxyResolutionHook(fn)` + invocación
  post session creation.
- `browser/ipc-handlers.js` — wire proxies + 18 IPC channels nuevos + native
  file dialogs.
- `browser/mcp-tools.js` — spread buildProxyTools.
- `browser/ui/webui.js` — instancia ProxyManagerUI singleton.
- `browser/ui/webui.html` — botón sidebar + modal markup + ~150 LOC CSS.
- `preload.js` — `window.oz.proxies.*` (24 métodos + onChanged).
- `tests/mcp-server.smoketest.js` — extender contract test (regex + exempt).
- `CHANGELOG.md` — entrada del bloque.

## Próximo paso

Bloque 1.9 FingerprintEngine "Ghost+" (~14h) — pasar Pixelscan/CreepJS por
default. Por cada Identity, generar y persistir un fingerprint coherente
derivado de un seed UUID. 14 vectores spoofeados via preload script en cada
partition session: User-Agent + platform + appVersion, hardwareConcurrency,
deviceMemory, languages, screen/dpr, timezone, WebGL vendor/renderer, canvas
noise, audioContext noise, fonts subset, plugins/mimeTypes, WebRTC,
battery, speech voices.

**Coherencia automática vía proxy GeoIP** (mejor que Ghost): cuando asignas
un proxy, OZ propone (con confirmación) timezone + languages + locale
derivados del país.

**Suite de tests CI:** abre Pixelscan / iphey / browserleaks / CreepJS con
N identities distintas, valida consistencia per-identity y diversidad
cross-identity. Bloquea release si baja del threshold.

Es el último bloque grande de la Sub-Etapa 1A (CORE). Después viene 1.10
Settings UI + Polish + extensiones multi-identity.

## Validación visual

Pendiente al final del commit — `npm start` con `OZ_MCP_ENABLED=1`, abrir
modal Proxies, agregar un proxy de Oxylabs (manual o template), Test
Connectivity, asignar a una Identity via MCP `oz.proxies.assignToIdentity`,
abrir tab, verificar IP outbound (whatismyipaddress.com).
