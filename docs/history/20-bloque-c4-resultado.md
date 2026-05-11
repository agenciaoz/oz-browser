# Bloque E2-C-4 — Bulk multi-account opener

**Cerrado:** 2026-05-10
**Tiempo efectivo:** ~2h vs ~2-3h estimadas
**Branch:** `feature/c4-bulk-open` (desde `main` post-merge de C-1)
**Tests:** +40 propios del bloque
**Deps npm nuevas:** cero
**ADR nueva:** ninguna (orquestación sobre primitivas existentes)

---

## Objetivo

Resolver el use case real de Jose: abrir N cuentas (existentes o nuevas) en un workspace con una tab por identity, sin clickear N veces. El use case explícito: "30 cuentas IG, todas en instagram.com, workspace dedicado."

## Decisiones tomadas vía AskUserQuestion antes de codear

1. **Trigger** — Tres entradas (sidebar button + Cmd+K palette entry + ⌥⇧O accelerator). Cubre no-coders, power users y muscle memory simultáneamente.
2. **Modos** — Dos: `fromExisting` (multi-select de identities ya creadas) + `createNew` (count + name pattern). El modo "mix" lo cortamos a un futuro C-4.5 — la lógica de "qué nombres a las nuevas vs cuáles existing" complicaba el UI sin valor inmediato.
3. **Workspace target** — Dropdown elegible con default "+ New workspace…" (auto-named `Bulk Open — timestamp`). Cubre el use case típico sin ensuciar workspaces curados; permite reusar uno existente cuando hace falta.

## Entregables

### `browser/bulk-opener.js` (~270 LOC, módulo puro)

- `resolveUrlPattern(template, n)` / `resolveNamePattern(template, n)` — tokens `{n}` (1-indexed) y `{i}` (0-indexed). Mismo convenio que `tab-handlers.bulkCreateLazy` para consistencia.
- `validateInput(input)` — pre-flight checks: `invalid-mode` / `no-identities-selected` / `too-many-identities` (>200) / `invalid-count` (0/>200) / `name-pattern-required`. UI llama esto antes de mutar para feedback inmediato.
- `resolveTargetWorkspace({kind, ...}, deps)` — resuelve a `{ok, workspaceId, created}`. Rechaza archived workspace. Crea WS nuevo si `kind: 'new'` con name auto-generado si falta.
- `bulkOpenFromExisting({identityIds, urlPattern, target}, deps)` — itera identities, mueve al target si necesario (skip si locked/default), abre una tab cada una. Returns `{ok, opened, errors, workspaceId, workspaceCreated}`.
- `bulkCreateNew({count, namePattern, color, urlPattern, target}, deps)` — crea N identities con naming pattern + abre tab cada una. Returns shape consistente con `created` en lugar de `opened`.

**Managers inyectados** (no requires de Electron). Tests usan FakeIdentityManager / FakeWorkspaceManager / FakeTabsHandlers.

### `browser/bulk-opener-handlers.js` (~80 LOC)

- `fromExisting(input)` / `createNew(input)` — wrappers que broadcastean `oz:identities:changed` + `oz:workspaces:changed` post-success.
- `previewNames({namePattern, count})` / `previewUrls({urlPattern, count})` — pure helpers cap 50 que la UI llama por keystroke para mostrar preview rows. No side effects.
- `validate(input)` — form-level validation pre-mutate.

### `browser/ui/bulk-opener.js` (~390 LOC, IIFE class)

Modal full-screen estilo `am-window` (620px width). Estructura:
- **Header** "🎯 Bulk Open" con close button
- **Segmented control** `From existing identities` / `Create N new`
- **Mode "existing"**: search box + select-visible checkbox + scrollable list de identities con swatch color + 🔒 si locked (disabled). URL pattern input opcional.
- **Mode "create"**: count number input + color picker + name pattern + URL pattern + preview list (cap 50 rows con name + url).
- **Target workspace**: dropdown poblado con `Current — {name}` + cualquier WS no-archivado + opción final `+ New workspace…`. Cuando es new, muestra fila con name input editable (default auto-generado timestamp).
- **Result panel** post-submit: count de opened/created, errors list (cap 10 + "and N more"), highlight si workspace fue auto-creado.

Listener `oz.bulkOpen.onOpen` + click en `#oz-bo-button` sidebar + Esc para cerrar. `setContentVisible(false/true)` para que el modal cubra los WebContentsView nativos.

### Wire

- **`browser/ipc-handlers-extra.js`** — registra 5 channels bajo `oz:bulkOpen:*`.
- **`browser/ipc-handlers.js`** — agrega `bulkOpen: buildBulkOpenerHandlers(browser)` a `browser.handlers`.
- **`preload.js`** — expone `oz.bulkOpen.{fromExisting, createNew, previewNames, previewUrls, validate, onOpen}`.
- **`browser/menu.js`** — menú "Go" extendido con "Bulk Open Identities… ⌥⇧O" que envía `oz:bulk-open:open` SOLO al focused window's webContents.
- **`browser/command-palette.js`** — nueva action "Bulk Open Identities…" con keywords `multi account batch many open mass`, payload `{action: 'open-modal', modal: 'bulkOpener'}`.
- **`browser/ui/command-palette.js`** — modalMap extendido con `bulkOpener: window.ozBulkOpenerUI`.
- **`browser/ui/webui.html`** — markup `#oz-bo-modal` (~110 líneas) + ~200 LOC CSS + botón sidebar "🎯 Bulk Open" + script tag `<script src="./bulk-opener.js">`.
- **`browser/ui/webui.js`** — instancia + expone como `window.ozBulkOpenerUI`.

## Tests — `tests/bulk-opener.smoketest.js` (40/40)

- **Template resolution** (5): `{n}` 1-indexed, `{i}` 0-indexed, no-token unchanged, mixed tokens.
- **validateInput** (7): invalid mode, empty selection, valid existing, count=0, count=201, missing namePattern, valid createNew.
- **resolveTargetWorkspace** (5): current valid, current archived rejected, new auto-created, new name passed through, new without name.
- **bulkOpenFromExisting** (12): happy path, opened 2 tabs, no errors, URL resolution per-counter, no move when same WS, move call when WS differs, locked identity skip, error reported for locked, missing identity → identity-not-found, new WS target end-to-end, exactly 1 WS created, empty identities → validation error.
- **bulkCreateNew** (11): happy path 3, naming 1-indexed, URL resolution, identityManager populated, with new WS target, color propagated, all in same new WS, count=0 rejected.

## Stub honesto / followups documentados

- **No partial-failure rollback.** Si después de crear 5 identities + abrir 5 tabs, la 6ta falla, no rollback. Reportamos en `errors[]` y dejamos las primeras 5. Aceptable v1 — Time Machine cubre rollback total si Jose lo necesita.
- **No randomización de color.** El color en createNew se aplica igual a todas las identities. Followup C-4.5: random color per identity, o range/palette picker.
- **No URL prefijo "abrir todas también en /direct/inbox" después del primary URL.** v1 = una tab por identity. Si Jose quiere 2 tabs (instagram.com + /direct/inbox) por identity, sub-bloque C-4.5.

## Métricas

- **Lint:** clean.
- **check:loc:** max 495/500 sin cambios.
- **Cero deps npm nuevas.**
- **CI:** verde 41s (pre-merge runs after push).

## Validación visual pendiente

1. `npm start` desde source.
2. Click "🎯 Bulk Open" en sidebar → modal aparece.
3. Modo "Create new", count 5, name pattern `IG {n}`, URL `https://instagram.com/`, target "+ New workspace…" → 5 identities + 5 tabs en workspace nuevo.
4. Cmd+K → tipear "bulk" → encuentra entry → Enter abre modal.
5. ⌥⇧O abre modal directo.
6. Modo "From existing" con 3 identities seleccionadas, una de ellas lockeada → result panel muestra "2 opened · 1 skipped" + "Account X — identity-locked".

## Estado del bloque E2-C

- ✅ **C-1 Cmd+K command palette**
- ✅ **C-4 Bulk multi-account opener** (este bloque)
- ⏳ C-2 crash recovery con state restore (~3h)
- ⏳ C-3 identity templates / clone (~2h)
- ⏳ C-5 notification panel + alert log (~2h)
- ⏳ C-6 anti-detect health dashboard (~3h)
- ⏳ C-7 extension per-identity validation + fixes (~3h)

Total restante del bloque E2-C: ~13h.
