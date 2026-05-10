# Bloque 1.10 — Settings + Browsing Data + Onboarding + Perf pass (cierre)

**Fecha:** 2026-05-10
**Tiempo efectivo:** ~3-4h vs ~16h estimadas (-75% por scope ajustado)
**Sub-fases:** 1.10a / 1.10b / 1.10c / 1.10d
**Total tests proyecto:** 1121 → **1242** (+121)
**Deps nuevas:** 0
**ADR:** 0019 — Settings + Browsing Data + Tab Discard
**CHANGELOG:** entrada agregada
**CIERRE:** Sub-Etapa 1A CORE COMPLETO

## Decisiones de scope (preguntadas a Jose antes de codear)

1. **Sesión continua** (1.10a → b → c → d) sin parar entre sub-bloques.
2. **Extensions multi-identity DIFERIDA a v2 post-launch** — Default
   identity sigue con Chrome Web Store (como ya estaba); las demás sin
   extensions. Razón: electron-chrome-extensions tiene quirks con
   multi-instance que pueden romper Web Store install.
3. **History MVP propio** — la API de Electron NO incluye history;
   implementamos `HistoryManager` custom que hookea did-navigate events.

## Qué se entregó

### 1.10a — Settings UI

**Archivos nuevos:**

- `browser/settings-manager.js`: clase con persistencia `settings.json`,
  schema versionado (v1), 6 secciones (general, privacy, automation,
  backup, onboarding, performance), validation per-key, mergeWithDefaults
  para forward-compat, `markOnboarded()` + `markOnboardingSkipped()`.
- `browser/settings-handlers.js`: handler map IPC↔MCP (getAll, get, set,
  resetSection, resetAll).
- `browser/ui/settings.js`: modal full-screen con sidebar nav + 6 secciones
  - bindings declarativos `{id, section, key, type}` que poblan/escriben
    automáticamente. Save debounced 250ms.

**Tests:** `tests/settings-manager.smoketest.js` 48/48 verde. Cubre
defaults, set + persist, validation (invalid logLevel/port/non-boolean),
unknown keys ignored (forward-compat), reset section/all, migration de
file viejo, corrupted JSON → defaults silently, onboarding helpers,
handlers wrappers + broadcasts.

### 1.10b — Browsing data backend (Bookmarks/Downloads/History)

**Archivos nuevos:**

- `browser/download-manager.js`: clase con `hookSession(identityId, session)`
  que instala `session.on('will-download')` listener. Persiste lifecycle
  completo (will-download → updated → done). Cap 1000. Filter list
  por identityId/state.
- `browser/history-manager.js`: clase con `hookTabs(tabs)` que escucha
  tab-updated events. Persiste {url, title, faviconUrl, identityId,
  visitedAt}. Dedup 60s window per (identityId,url). Cap 10K. Throttled
  save 2s. Skip about:/chrome-extension:.
- `browser/browsing-data-handlers.js`: handler maps download + history
  para IPC↔MCP.
- `browser/ipc-handlers-extra.js`: refactor split de ipc-handlers.js para
  mantenerlo bajo 500 LOC (ADR 0005). Mueve register\* de proxies +
  fingerprint + settings + browsing-data a este file.

**main.js wiring:**

- DownloadManager hookea cada session via `addSessionInitHook`.
- HistoryManager hookea cada `Tabs` instance via createWindow path.

**Bookmarks**: ya existían desde 1.7b — solo agregamos handlers IPC
para list/get/add/remove que ya estaban (no nuevo trabajo).

**Tests:** `tests/browsing-data.smoketest.js` 47/47 verde. Cubre download
hookSession + lifecycle completo + filter + remove + clear; history
addVisit + dedup + about: skip + filter search + persistence + hookTabs.

**Deferido a 1.10.5:** UI completa Browsing Data (modal con 3 tabs
Bookmarks/Downloads/History). El backend está listo y MCP-accesible.

### 1.10c — First-run onboarding

**Archivos nuevos:**

- `browser/ui/onboarding.js`: 3 pantallas (Identities → Workspaces+Vault →
  Proxies+Fingerprint+MCP). Navigation next/back/skip con dot pagination.
  `maybeOpen()` triggered en webui.js boot — solo si `settings.onboarding
.completed === false`.

**HTML/CSS:** modal markup + ~80 LOC CSS con emoji headers + cards de
features.

**Wiring:** `webui.js` instancia + llama `maybeOpen()` después del init
del sidebar.

### 1.10d — Apple Silicon perf pass + cierre Sub-Etapa 1A

**Archivos nuevos:**

- `browser/tab-discard-daemon.js`: scan cada 5 min sobre tabs
  materializadas + non-pinned + non-selected + idle > N min. Llama
  `tab.discard()`. Respeta settings.performance.autoTabDiscard en cada
  scan (toggle no requiere restart).

**Tab class extendido:**

- `Tab.discard()`: snapshot URL → pendingUrl, hide + destroy
  WebContentsView, mark materialized=false. La tab sigue en tabList
  visible en sidebar; re-seleccionar la re-materializa.
- `Tab.lastSelectedAt` + `createdAt` timestamps.
- `Tabs.select()` actualiza lastSelectedAt al seleccionar.

**main.js:** instancia daemon + start en init, stop en before-quit.
También flush historyManager en before-quit (throttled save).

**Tests:** `tests/tab-discard-daemon.smoketest.js` 26/26 verde. Cubre
honors autoTabDiscard=false, idle discard correcto (skipea selected/
pinned/lazy/recent), discardIdleMin honrado, multi-window, daemon
start/stop idempotent, Tab.discard() preserva pendingUrl + emite event.

**No incluido v1** (ver ADR 0019 para razonamiento):

- Memory pressure handler (alertar si OZ >2GB)
- Cache caps per partition
- Performance modes auto-detect

## Tests

- 1242/1242 totales verde (vs 1121 al cierre 1.9.5).
- Suite per archivo:
  - account-handlers: 51, account-vault: 30, anti-logout: 38
  - backup-manager: 40, bookmark-manager: 50
  - **browsing-data: 47 (NUEVO)**
  - cookies-io: 72, country-locale: 39
  - excel-io: 25, fingerprint-engine: 96, identity-manager: 29
  - mcp-server: 132 (sin cambios — settings es UI-only no MCP)
  - move-to-workspace: 29, preload-fingerprint-injection: 51
  - proxy-assignment: 30, proxy-csv: 45, proxy-health: 25, proxy-manager: 58
  - **settings-manager: 48 (NUEVO)**
  - site-templates: 125, tab-context-handlers: 64
  - **tab-discard-daemon: 26 (NUEVO)**
  - window-workspace: 36, workspace-manager: 56

## Refactor incidental

`browser/ipc-handlers.js` creció a 518 LOC durante 1.10b, violando ADR
0005 (max 500 LOC). Solución: extraer las 4 funciones más recientes
(proxies + fingerprint + settings + browsing-data) a
`browser/ipc-handlers-extra.js`. ipc-handlers.js queda en ~395 LOC,
ipc-handlers-extra.js en ~140 LOC. Lint clean post-refactor.

## Costos

- **Tiempo:** ~3-4h efectivas vs ~16h originales (-75% por scope ajustado).
- **Deps npm nuevas:** 0.
- **LOC source:** ~1500.
- **LOC tests:** ~600.

## Archivos modificados

**Nuevos (10):**

- `browser/settings-manager.js`, `browser/settings-handlers.js`,
  `browser/download-manager.js`, `browser/history-manager.js`,
  `browser/browsing-data-handlers.js`, `browser/tab-discard-daemon.js`,
  `browser/ipc-handlers-extra.js`
- `browser/ui/settings.js`, `browser/ui/onboarding.js`
- `tests/settings-manager.smoketest.js`,
  `tests/browsing-data.smoketest.js`,
  `tests/tab-discard-daemon.smoketest.js`
- `docs/architecture/0019-settings-browsing-data-perf.md`
- `docs/history/16-bloque-1.10-resultado.md` (este file)

**Modificados:**

- `browser/main.js`: instancia 4 nuevos managers + daemon + 2 wirings
  (DownloadManager via session-init-hook + HistoryManager via createWindow
  - TabDiscardDaemon start/stop)
- `browser/ipc-handlers.js`: split (4 funciones movidas a -extra.js)
- `browser/window-manager.js`: pasa historyManager a Tabs.hookTabs
- `browser/tabs.js`: agrega Tab.discard() + lastSelectedAt + createdAt
- `browser/ui/webui.html`: sidebar button ⚙️ Settings + 2 modal markups
  - ~250 LOC CSS
- `browser/ui/webui.js`: instancia SettingsUI + OnboardingUI + maybeOpen
  trigger en boot
- `preload.js`: window.oz.settings._ + window.oz.downloads._ +
  window.oz.history.\*
- `tests/mcp-server.smoketest.js`: comment para skipped settings
- `CHANGELOG.md`, `docs/PLAN-MAESTRO.md`, `docs/architecture/README.md`

## Cierre Sub-Etapa 1A CORE

Con 1.10 cerrado, **toda la Sub-Etapa 1A CORE está completa**:

| Bloque                                           | Tests del bloque     | Status |
| ------------------------------------------------ | -------------------- | ------ |
| 1.1 Foundation                                   | —                    | ✅     |
| 1.2 Identity Manager + Lazy Tabs                 | 28                   | ✅     |
| 1.3-MCP MCP server (HTTP + SSE + 13 tools v1)    | 57                   | ✅     |
| 1.3.5-CI GitHub Actions                          | —                    | ✅     |
| 1.3.6-DX ESLint + Prettier + Husky               | —                    | ✅     |
| 1.4-WS Workspace Manager (lock 1-1)              | 56+36+29             | ✅     |
| 1.5 ⭐ Vault + auto-fill + anti-logout + Excel   | 30+51+125+38+25+1.5f | ✅     |
| 1.6 Time Machine                                 | 40                   | ✅     |
| 1.7 Tab Context Menu (16 opciones Ghost)         | 64+50+72             | ✅     |
| 1.8 Proxy Manager (+ Oxylabs + auto-disable)     | 58+30+25+45          | ✅     |
| 1.9 FingerprintEngine "Ghost+" (11 vectores)     | 96+39+5              | ✅     |
| 1.9.5 FP injection validation                    | 51                   | ✅     |
| **1.10 Settings + Browsing + Onboarding + Perf** | 48+47+26             | ✅     |

**Total proyecto: 1242 tests verde, 0 deps nuevas, ~$0 invertido.**

## Próximo paso

**Sub-Etapa 1B — Distribución, Billing, Public Launch:**

1. **Etapa 3 — Empaquetar + auto-update**: electron-forge package +
   notarización Apple ($99 dev account) + GitHub Releases + `update-electron-app`.
2. **Etapa 4 — Auth via Supabase**: signup/login + protocol handler
   `oz://auth/callback`.
3. **Etapa 5 — Stripe billing**: Free + Basic + Pro tiers, checkout
   externa via shell.openExternal.
4. **Etapa 6 — Marketing site + dominio** ($12/año).
5. **Etapa 7-OFFICE — Dropbox sync** (PKCE) para vault portability +
   cloud backup premium.
6. **Etapa 8 — Windows build** (universal-binary).

**Antes de Etapa 3, recomendable:**

- Sub-bloque 1.10.5 — UI Browsing Data (modal con 3 tabs) — ~2-3h.
- Validación visual end-to-end del CORE entero.
- Bench performance (BENCHMARKS.md update).
