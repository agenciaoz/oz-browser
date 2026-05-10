# ADR 0019 — Settings + Browsing Data + Tab Discard (1.10)

**Date:** 2026-05-10
**Status:** Accepted
**Related blocks:** 1.10a / 1.10b / 1.10c / 1.10d
**Closes:** Sub-Etapa 1A CORE

## Context

El Bloque 1.10 cubría 5 grupos de features que el plan original juntaba en
"Settings UI + Polish + Bookmarks/Downloads/History + Extensions
multi-identity + M-series perf" (~16h estimadas):

1. UI completa de Settings (varias secciones).
2. Páginas Bookmarks / Downloads / History (las dos últimas requerían
   tracking propio).
3. First-run onboarding.
4. Extensions multi-identity (cada identity con sus extensiones).
5. Apple Silicon perf pass (tab discard, memory pressure, perf modes).

Antes de implementar tomamos 3 decisiones de scope (preguntadas a Jose):

1. **Sesión continua** (1.10a → b → c → d) sin parar entre sub-bloques.
2. **Extensions multi-identity DIFERIDA a v2 post-launch** — Default sigue
   con Chrome Web Store (como ya estaba); las demás identities sin
   extensions. Razón: `electron-chrome-extensions` tiene quirks con
   multi-instance que pueden romper Web Store install si lo apuramos.
3. **History MVP propio** — la API de Electron NO incluye history; hicimos
   un `HistoryManager` custom que hookea did-navigate events.

## Decision

**1. SettingsManager con schema versionado (1.10a).**

`settings.json` con `version` field + 6 sections (general, privacy,
automation, backup, onboarding, performance). Migration hook listo para
schema bumps futuros. Validation per-key con whitelist (logLevel ∈
{DEBUG/INFO/WARN/ERROR}, mcpPort ∈ 1-65535, etc). `mergeWithDefaults`
asegura forward-compat: cargar un settings.json viejo (sin nuevas
secciones) NO falla — las secciones missing aparecen con defaults.

UI Settings con sidebar nav de 6 secciones + bindings declarativos
(`{id, section, key, type}`) que poblan/escriben automáticamente.
Save debounced 250ms para no thrashear con typing en number/text inputs.

**2. Browsing data con 3 managers separados (1.10b).**

- `bookmark-manager.js` (existía desde 1.7b — sin cambios).
- `download-manager.js` — hookea `session.on('will-download')` por cada
  identity session via `addSessionInitHook`. Persiste lifecycle completo
  (will-download → updated → done con state final). Cap 1000 records.
- `history-manager.js` — hookea `tab-updated` events de cada Tabs
  instance. Persiste {url, title, faviconUrl, identityId, visitedAt}.
  Dedup por (identityId, url) con ventana 60s para evitar spam de SPAs
  que disparan did-navigate-in-page. Cap 10K total. Throttled save 2s
  para coalescer bursts. Skip about: y chrome-extension: URLs.

UI Browsing Data: diferida a sub-bloque 1.10.5 (post-launch). Los
managers exponen IPC + MCP completo, así que cualquier client puede
listar/buscar/exportar; la UI es solo conveniencia. Decisión consciente
para mantener 1.10 cerrable.

**3. First-run onboarding 3-pantallas con flag persistente (1.10c).**

Modal full-screen con 3 pantallas (Identities → Workspaces+Vault →
Proxies+Fingerprint+MCP). Navigation next/back/skip + dot pagination.
Trigger automático en `webui.js` al boot via `OnboardingUI.maybeOpen()`
que chequea `settings.onboarding.completed === false`. User puede Skip
(setea `completed=true` + `skippedAt` timestamp) o completar (solo
`completed=true`). Re-mostrar requires `resetSection('onboarding')`
desde Settings.

**4. Tab Discard Daemon Apple Silicon (1.10d).**

`TabDiscardDaemon` con setInterval 5 min. Cada scan revisa tabs
materializadas + non-pinned + non-selected + lastSelectedAt < now -
discardIdleMin\*60s y llama `tab.discard()` que destruye el
WebContentsView pero conserva el record en tabList. Re-seleccionar
re-materializa from pendingUrl (snapshot del current URL antes de
destroy).

Toggle desde `settings.performance.autoTabDiscard` — el daemon respeta
el setting en cada scan (no requiere restart). Default ON, default
discardIdleMin=30.

`Tab.discard()` nuevo método; `Tabs.select()` actualiza `lastSelectedAt`
para tracking. Hooks fail-safe.

**5. Per-tab proxy NO se hace (mantener decisión 1.8).**

Documentado en ADR 0017 — no se reabre v2.

**6. Memory pressure handler + cache caps NO se hacen v1.**

Mencionados en plan original pero diferidos: el discard daemon ya
maneja el 80% del problema de RAM. Memory pressure handler (alertar al
user si OZ usa >2GB) + cache caps requieren observación real de uso —
implementar en v1.5 cuando tengamos métricas reales.

**7. ipc-handlers.js split (refactor incidental).**

El bloque 1.10 hizo crecer `ipc-handlers.js` de 466 a 518 LOC,
violando ADR 0005 (max 500). Solución: extraer las 4 funciones más
recientes (proxies + fingerprint + settings + browsing-data) a
`ipc-handlers-extra.js`. ipc-handlers.js queda en ~395 LOC.
ipc-handlers-extra.js en ~140 LOC.

## Architecture

```
SettingsManager (settings.json)
   │ schema v1, 6 sections, migration hook
   │
   ├── UI Settings modal (6 sections, debounced save)
   ├── OnboardingUI (reads onboarding.completed at boot)
   ├── TabDiscardDaemon (reads performance.autoTabDiscard each scan)
   └── future: McpServer toggle, dailySnapshot toggle, etc.

DownloadManager (downloads.json, cap 1000)
   │ hookSession via addSessionInitHook (per-identity)
   ▼
session.on('will-download') → record lifecycle

HistoryManager (history.json, cap 10K, throttled save 2s)
   │ hookTabs via createWindow path (per-window)
   ▼
tabs.on('tab-updated') → addVisit (dedup 60s window)

TabDiscardDaemon (5 min interval)
   │ respects settings.performance.autoTabDiscard at each scan
   │
   ▼
For each window:
  For each tab where materialized && !pinned && !selected && idle > Xmin:
    tab.discard() → destroys WebContentsView, keeps tabList entry
                  → next select() re-materializes from pendingUrl
```

## Consequences

**Positive:**

- Settings persistentes con UI completa — el user ya no necesita env vars
  para toggles comunes (MCP, free tier, log level).
- Per-identity downloads + history — diferenciador real vs Chrome
  estándar (que mezcla todo en el mismo store).
- Onboarding 3-pantallas explica los conceptos clave (Identity ≠ Profile,
  Workspaces, Vault, Proxies+Fingerprint, MCP) que los users nuevos
  necesitan para no quedar perdidos al primer boot.
- Tab discard daemon libera RAM en sesiones largas con muchas tabs —
  vital para Apple Silicon donde el ratio identidades:RAM importa.
- `ipc-handlers.js` se mantiene bajo 500 LOC vía split limpio (ADR 0005
  honor mantenido).
- Schema versionado abre la puerta a migrations futuras sin breaking
  changes para users con instalaciones viejas.

**Negative:**

- UI Browsing Data (Bookmarks page + Downloads page + History page) NO
  llega en 1.10 — solo el backend. Acceso via MCP, no via UI conveniente.
  Sub-bloque 1.10.5 dedicado lo implementa.
- Extensions multi-identity NO en v1 — Default identity tiene Web Store,
  las demás no.
- Memory pressure handler diferido — si un user reporta OZ >2GB sin
  warning, lo agregamos.
- TabDiscardDaemon cada 5 min: si user muy activo abre + cambia tabs
  rápido, el discard puede sentirse "agresivo". Mitigación: toggle off
  desde Settings, o aumentar discardIdleMin.

**Métricas de cierre:**

- 4 sub-fases (1.10a / 1.10b / 1.10c / 1.10d) en sesión continua,
  ~3-4h efectivas vs ~16h estimadas (-75% por scope ajustado).
- 6 archivos source nuevos: settings-manager, settings-handlers,
  download-manager, history-manager, browsing-data-handlers,
  tab-discard-daemon, ipc-handlers-extra (refactor split). + 2 UI:
  settings.js, onboarding.js.
- 3 tests nuevos: settings-manager (48), browsing-data (47),
  tab-discard-daemon (26) = 121 nuevos.
- Total proyecto: 1121 → 1242 (+121).
- 0 deps npm nuevas.
- ipc-handlers.js: 518 → 395 LOC (split exitoso).

## Closes Sub-Etapa 1A CORE

Con 1.10 cerrado, la **Sub-Etapa 1A CORE** está completa:

- ✅ 1.1 Foundation
- ✅ 1.2 Identity Manager + Lazy Tabs
- ✅ 1.3-MCP MCP server
- ✅ 1.3.5-CI GitHub Actions
- ✅ 1.3.6-DX Lint + pre-commit
- ✅ 1.4-WS Workspace Manager
- ✅ 1.5 ⭐ Vault + auto-fill + anti-logout + Excel I/O
- ✅ 1.6 Time Machine
- ✅ 1.7 Tab Context Menu (16 opciones Ghost)
- ✅ 1.8 Proxy Manager (Oxylabs + auto-disable + assignment hierarchy)
- ✅ 1.9 FingerprintEngine "Ghost+" (11 vectors + GeoIP coherence)
- ✅ 1.9.5 Fingerprint injection validation
- ✅ 1.10 Settings + Browsing data + Onboarding + Tab discard

**El producto OZ Browser está functionalmente completo a nivel CORE.**
Sub-Etapa 1B (distribución, billing, Apple notarization, public launch)
es el siguiente milestone.

## Alternatives considered

- **UI Browsing Data en 1.10**: descartado para mantener tiempo. Backend
  está listo, UI llega en 1.10.5 (~2-3h dedicated).
- **Extensions multi-identity en v1**: descartado por compat risk con
  electron-chrome-extensions. Solo cuando un cliente real lo pida.
- **Tab discard agresivo (cada 1 min)**: descartado — 5 min es balance
  razonable. User puede ajustar discardIdleMin si quiere más/menos.
- **Memory pressure handler en v1**: diferido — sin métricas reales de
  uso es imposible calibrar el threshold. v1.5 con telemetry opt-in.
- **ADRs separados (0019 Settings, 0020 Browsing, 0021 Perf)**:
  descartado para no fragmentar. Un solo ADR cubre el bloque entero.
