# Bloque E2-C-5 — Notification panel + alert log

**Cerrado:** 2026-05-10 (sesión continua post-C-3)
**Tiempo efectivo:** ~1.5h vs ~2h estimadas
**Branch:** `main` directo
**Tests acumulados:** 1649 → 1702 (+53 propios del bloque)
**Deps npm nuevas:** cero
**ADR nueva:** ninguna (orquestación sobre JSON file + broadcast channel)

---

## Objetivo

Historial in-app persistente de alertas que el user querría revisar después (account needs relogin, proxy auto-disabled, snapshot creado, crash recovery). Hasta ahora cada producer mostraba una OS notification efímera; sin un panel central no había forma de ver qué pasó la noche anterior si OZ se quedó corriendo.

## Decisiones tomadas vía AskUserQuestion antes de codear

1. **Persistencia — JSON cap 500 FIFO (recomendado).** Sobrevive restarts. Costo trivial (~50KB). Scoped global (no per-identity — diferido).
2. **OS notifications — conviven con el panel (recomendado).** Panel registra TODO; OS notifications siguen para urgentes (controlables con `settings.notifications.showOSAlert`, default ON).
3. **Inline actions — sí, contextual cuando aplique (recomendado).** "Account needs relogin" → [Open Accounts] · "Proxy disabled" → [Open Proxies] · "Snapshot created" → [Open Time Machine]. UX accionable.

## Entregables

### `browser/alert-manager.js` (~240 LOC)

Clase `AlertManager` con persistencia `userData/alerts.json` (cap 500 FIFO, throttled save 1s).

- Schema v1: `{ version: 1, alerts: [Alert...] }`.
- Alert v1: `{ id: 'a-<hex>', ts, type, severity: 'urgent'|'info'|'success', title, message, identityId?, action?, read }`.
- API: `add` · `list({limit?, type?, unreadOnly?, since?})` · `markRead(id)` · `markAllRead()` · `remove(id)` · `clear()` · `unreadCount()` · `flush()`.
- Eviction inteligente: cuando supera 500, evicta primero los oldest **non-urgent**. Si TODOS son urgent unread, fallback a FIFO clásico para no crashear.
- Schema mismatch + corrupt JSON → starts fresh con warn log.
- Cada mutación broadcastea `oz:alerts:changed` (UI refresca badge contador + panel content live).
- Defensive: `add()` skipea si type missing; severity inválida → default 'info'.

### `browser/alert-handlers.js` + IPC + MCP + preload

- `buildAlertHandlers(browser)` handler map puro consumido por IPC + MCP.
- 7 IPC channels `oz:alerts:*`: list, add, markRead, markAllRead, remove, clear, unreadCount.
- Preload bridge `oz.alerts.{list, add, markRead, markAllRead, remove, clear, unreadCount, onChanged, onOpen}`.
- 7 MCP tools `oz.alerts.*` (split a `mcp-tools-alerts.js` per ADR 0005).

### Wire en producers existentes

- **`browser/anti-logout.js`**: cuando flagea account `needs_relogin` → `alertManager.add({type:'anti-logout', severity:'urgent', identityId, action:'open-modal accountManager'})`. OS notif sigue mostrándose si `settings.notifications.showOSAlert` (default ON).
- **`browser/proxy-health.js`** (vía `proxy-health-notify.js`): cuando auto-disable después de 3 fails → alert urgent + open-modal proxyManager.
- **`browser/main.js`** backup cron tick: snapshot daily 3am → alert success + open-modal timeMachine.
- **`browser/crash-recovery-setup.js`**: post-restore → alert info "Restored N window(s)".

### UI — `browser/ui/notifications.js` (~245 LOC)

IIFE singleton `window.OZ.Notifications`:

- Botón sidebar 🔔 con badge contador unread (rojo `#e85a5a`, "99+" cap).
- Modal panel con lista cronológica reverse (newest first).
- Filas con severity dot (urgent rojo / success verde / info azul), title bold, message muted, meta (type · time-ago), inline action button cuando aplica (Open Accounts / Open Time Machine / etc.), dismiss button (×).
- Toolbar: "Mark all read" · "Clear all" (con confirm) · contador "N total · M unread".
- Auto-mark-all-read 800ms después de abrir (UX típica notification UIs).
- Esc para cerrar. Click backdrop para cerrar. Auto-hide WebContentsView (ADR 0011).
- Empty state amigable con copy explicativo.

### `browser/command-palette.js` + modal map

- Entry `action:open-notifications` con label "Notifications", emoji 🔔, keywords "alerts log history bell warnings".
- modalMap extendido con `notifications: window.OZ && window.OZ.Notifications`.

### `browser/settings-manager.js` + Settings UI

- Nueva sección `notifications` con `showOSAlert: true` (default).
- `validateKey` extendido para aceptar `showOSAlert` boolean.
- Sidebar nav extendido con button "Notifications".
- Settings UI section con toggle "Show OS notifications" + copy explicativa.
- Binding declarativo agregado a `settings.js`.

### Refactor incidental — `browser/proxy-health-notify.js` (~50 LOC)

main.js creció a 526 LOC al wirear C-5 (límite 500 per ADR 0005). Extracción del notify factory (con dual surface alert + OS) a módulo separado. Patrón consistente con `crash-recovery-setup.js`. Bonus: eliminé el `getNotification` lazy helper de main.js (era único consumer). main.js final: 495 LOC.

## Tests

Total **53 tests propios del bloque** (1702/1702 verde end-to-end).

`tests/alert-manager.smoketest.js` — 53 cases:

- exports + constants (4)
- constructor validation (1)
- `add()` basic + identifiers + broadcast (10)
- `add()` severity defaults + defensive skips (8)
- `list()` filters: newest-first, limit, type string, type array, unreadOnly, since (8)
- lifecycle ops: markRead idempotent + broadcast gating, markAllRead, clear, remove, unreadCount (15)
- persistence round-trip (2)
- cap eviction non-urgent first (2)
- cap eviction all-urgent FIFO fallback (3)
- schema mismatch → fresh (1)
- corrupt JSON → fresh + subsequent add still works (2)

Plus +N tools en mcp-server contract test (auto-detected vía regex).

## Métricas

- Lint clean (ESLint + Prettier).
- check:loc max 495 (post-refactor del proxy-health notify).
- 4 archivos browser/ nuevos: `alert-manager.js` (~240 LOC), `alert-handlers.js` (~40 LOC), `mcp-tools-alerts.js` (~90 LOC), `proxy-health-notify.js` (~50 LOC), `ui/notifications.js` (~245 LOC).
- Modificados: `main.js` (alert + late-bind + cron alert + flush), `anti-logout.js` (+ alertManager + settingsManager wiring), `crash-recovery-setup.js` (+ post-restore alert), `ipc-handlers.js` (+ alerts handler register), `ipc-handlers-extra.js` (+ 7 IPC channels), `preload.js` (+ alerts bridge), `mcp-tools.js` (+ import + spread), `command-palette.js` (+ entry), `ui/command-palette.js` (+ modal map), `settings-manager.js` (+ notifications section + validation), `ui/settings.js` (+ binding), `ui/webui.html` (+ sidebar button + badge + modal markup + CSS + script tag + settings section + nav button).
- Cero deps npm nuevas.

## Validación visual ✅ PASADA 2026-05-10 noche bis

Validación end-to-end vía Desktop Commander + computer-use sobre `.app` empaquetada (`/Applications/OZ Browser.app` reemplazada con commit `7e34d11`):

1. **Boot normal:** sidebar muestra botón `🔔 Notifications` sin badge (unreadCount=0 al inicio).
2. **Trigger artificial vía MCP:** `oz.alerts.add({type:'test', severity:'urgent', title:'Hello from Claude', message:'This is a test alert triggered via MCP', action:{kind:'open-modal', payload:{modal:'timeMachine'}}})` → returns alert con id `a-ebdfd515c3ba`, ts populated, read:false. `oz.alerts.unreadCount` → `1`.
3. **Badge aparece** rojo `#e85a5a` con texto "1" en el botón `🔔 Notifications` (visible en screenshot del sidebar).
4. **Click 🔔** → modal abre con:
   - Header `🔔 Notifications` + close ×
   - Toolbar: `Mark all read` + `Clear all` + stats `1 total · 0 unread` (auto-mark-read 800ms post-open ya disparó)
   - Row con severity dot rojo (urgent), title bold "Hello from Claude", message muted, meta `TEST · JUST NOW`, **inline action button "Open Time Machine"** renderizado correctamente desde `action.payload.modal`, dismiss × per row.
5. **Persistencia confirmada:** `cat alerts.json` post-modal-close muestra `read:true`, schema v1 intacto.
6. **Click ESC** + reopen → modal arranca sin badge (todas marcadas leídas), conserva la alert en el log.
7. **Bonus integration C-2 ↔ C-5:** después del crash recovery flow (validación C-2), apareció auto en el panel una alert `"Session restored" (crash-recovery / info)` con message `"Restored 1 window(s) from the last session before the crash."`. El wire de `crash-recovery-setup.js` que agregué funciona end-to-end.

**Resultado:** Cero bugs runtime. El feature funciona en .app empaquetada exactamente como en los unit tests. La integration con producers existentes (anti-logout, proxy-health, backup cron, crash-recovery) está validada — al menos crash-recovery fue probado live.

## Próximo

E2-C-6 anti-detect health dashboard (~3h) — per-identity IP/timezone match + fingerprint coherence + cookie health (red/yellow/green dot panel). O E2-C-7 extension per-identity validation (~3h). ~6h restantes en el Bloque E2-C.
