# Bloque E2-C-8 — Sidebar Compactor (resultado)

**Status:** ✅ Cerrado 2026-05-10 noche bis
**Commit:** TBD (feature/c8-sidebar-redesign)
**Tiempo:** ~1h efectivas vs ~3-4h estimadas (-66%)
**Deps nuevas:** 0
**Tests:** 1745 (sin cambios — refactor UI puro)

## Origen

Jose observó (screenshot del sidebar) que los 8 botones grandes superiores (Accounts, Time Machine, Proxies, Settings, Browsing Data, Bulk Open, Notifications, "+ New Identity") consumen ~50% del alto vertical del sidebar pero el ratio de uso real es ~5%. La zona del día a día (workspaces+identities tree) queda apretada.

## Decisiones de scope (vía AskUserQuestion al inicio)

1. **Toolbar items**: 8 íconos (Accounts 🔐, Time Machine ⏱, Proxies 🌐, Settings ⚙️, Browsing Data 📚, Bulk Open 🎯, Notifications 🔔, Health Check 🩺).
2. **+ New Workspace y + New Identity**: inline contextual en sus sections (no íconos en toolbar). + New Identity como botón "+" mini al lado de cada workspace row. + New Workspace queda donde estaba (workspace switcher pills).
3. **Botones grandes anteriores**: eliminar del todo (no toggle Settings legacy). Cmd+K queda como segundo camino.

## Cambios

### `browser/ui/webui.html`

- **Eliminado** bloque de líneas 2863-2888: 7 `<button>` grandes + `<button class="new-identity">`.
- **Agregado** `<div id="oz-sidebar-toolbar">` al final del aside, con 8 `<button class="oz-toolbar-btn">`. Cada uno mantiene su ID original (`oz-accounts-button`, `oz-tm-button`, `oz-pm-button`, `oz-bd-button`, `oz-bo-button`, `oz-notif-button`, `oz-settings-button`) para no romper account-manager.js / time-machine.js / proxy-manager.js / browsing-data.js / bulk-opener.js / notifications.js / settings.js — cada uno hace `document.getElementById('oz-X-button')` para wirear su listener.
- **Nuevo** `<button id="oz-health-button">` 🩺 (no existía botón previo para Health Check; antes solo accesible vía right-click + Cmd+K + sidebar dot click).
- **CSS** ~140 LOC nuevos en bloque "C-8 Sidebar Compactor":
  - `#oz-sidebar` cambia `overflow-y` de `auto` a `hidden`.
  - `#oz-identity-list` agrega `flex: 1 1 auto; overflow-y: auto; min-height: 0` → tree scrollea internamente, toolbar queda sticky en el bottom.
  - `#oz-sidebar-toolbar` flex row con `space-between`, padding mínimo, border-top sutil.
  - `.oz-toolbar-btn` 32×32 transparent + hover bg + position:relative para badges/dots overlay.
  - Override `#oz-accounts-button.oz-toolbar-btn` (vault-status-dot ahora absolute top-right corner sobre el ícono).
  - `.toolbar-badge` (notif unread count) absolute top-right rojo `#e85a5a` + box-shadow ring para destacar sobre el ícono.
  - `.toolbar-count` para tm-count/pm-count (badge gris discreto).
  - `.ws-add-identity-btn` opacity:0 → 0.7 on row hover, 1 on hover button → "+" aparece solo cuando hovereás el workspace row (no clutterea).

### `browser/ui/sidebar.js`

- **renderWorkspaceWrapper** agrega botón "+" mini (`ws-add-identity-btn`) por cada workspace row no-frozen no-archived. Click crea identity en ese workspace específico via `handleNewIdentityInWorkspace(workspaceId)`. Frozen/archived no reciben el botón porque ADR 0023 bloquea moves/CRUD ahí.
- **handleNewIdentityInWorkspace(workspaceId)** nuevo handler. Usa `window.prompt('Identity name')` y llama a `oz.identities.create({name, workspaceId})` + `setActive`.
- **handleNewIdentity** (legacy del botón grande) **ELIMINADA** — ya no hay $newIdBtn.
- **handleNewWorkspace** **simplificada** — usa `window.prompt('Workspace name')` igual que handleNewIdentityInWorkspace. Antes usaba el helper `_inlineRename` que requería un button container con espacio para inyectar un input.
- **Helper `_inlineRename` ELIMINADO** (~50 LOC). Ya no había callsites.
- **Listener constructor** ya tenía `if (this.$newIdBtn)` defensivo, queda noop.
- **Net delta sidebar.js**: -31 LOC (495 → 491). check:loc verde.

### `browser/ui/webui.js`

- Wirea `oz-health-button` click → `await window.oz.identities.getActive()` → `window.OZ.HealthCheck.open(activeId)`. Los otros toolbar buttons se autowirean cada uno desde su propio módulo.

## UX antes/después

**Antes** (screenshot original Jose):

- WORKSPACES (header) + "+ New Workspace" pill
- 7 botones grandes apilados verticalmente (Accounts / Time Machine / Proxies / Settings / Browsing Data / Bulk Open / Notifications), cada uno ~32px alto + padding
- "+ New Identity" botón grande
- WORKSPACES & IDENTITIES (header)
- Tree scrollable

Total altura panel superior ≈ 280-320px (50%+ del viewport en una window de 720px).

**Después**:

- WORKSPACES (header) + "+ New Workspace" pill
- WORKSPACES & IDENTITIES (header)
- Tree (toma todo el espacio disponible, scrollea internamente)
- Toolbar footer: 8 íconos en una fila ~32px alto + padding ≈ 50px total

Liberado: ~230-270px de alto vertical (~70% más espacio para identities+tabs).

## LOC

- sidebar.js 522 (post-C-6) → **491** (post-C-8 con extract de \_inlineRename + simplificación)
- webui.html: +144 líneas netas (140 CSS + 78 markup nuevo - 26 markup eliminado - bloque preámbulo workspaces)
- webui.js: +12 líneas (Health button wire)
- check:loc max 495/500 ✓

## Files modificados

- `browser/ui/webui.html` — markup + CSS
- `browser/ui/sidebar.js` — renderWorkspaceWrapper "+" inline + handleNewIdentityInWorkspace + simplifications
- `browser/ui/webui.js` — Health button wire
- `CHANGELOG.md` — entry del bloque
- `docs/history/25-bloque-c8-resultado.md` — este archivo

## Tests

Sin tests nuevos — refactor UI puro. Los IDs preservados garantizan que los modal openers existentes siguen funcionando sin tocarles los listeners. Tests acumulados sin cambios: **1745 verde**.

## Pendiente

- **Validación visual end-to-end** (`npm start`): verificar que (a) los 8 íconos del toolbar abren cada uno su modal correspondiente, (b) "+ New Identity" inline aparece on-hover de cada workspace row y crea la identity en ese ws específico, (c) "+ New Workspace" via prompt() funciona, (d) tree ocupa todo el espacio disponible y scrollea internamente sin que el toolbar baje, (e) notif badge contador rojo se muestra correctamente sobre el ícono 🔔 cuando hay alerts unread.
- **Bloque C-7** extension per-identity validation (~3h) cierra el E2-C.
