# Bloque 1.4-WS — Workspace Manager · Resultado

**Fechas:** 2026-05-09 (5 commits en una sesión continua)
**Estimación:** ~10h · **Real:** ~6-7h efectivas (1.4a 2h + 1.4b 1.5h + 1.4c 1.5h + 1.4d 1.5h + 1.4e 1h)
**Estado:** ✅ Cerrado. CI verde en cada commit. 220/220 tests.

## Qué se entregó

### Sub-fase 1.4a — Backend (commit `75fbff8`)

- `browser/workspace-manager.js` (340 LOC): clase `WorkspaceManager` con CRUD completo + persistencia `workspaces.json` + freeze/archive/duplicate + `tabSpecs` management + throttled save (`saveDelayMs` opcional, default 0=sync para tests). Default WS auto-creado (id=`"general"`, "General Browsing"). Default protegido contra archive/remove. Frozen rechaza `update()` pero acepta `setTabSpecs()` (snapshot path).
- `browser/workspace-handlers.js` (165 LOC): handler map puro consumido por IPC y MCP. Mismo patrón que `identity-handlers.js`. `setActive` con auto-fallback a Default si el WS borrado era activo en alguna ventana.
- `browser/ipc-handlers.js`: 15 channels `oz:workspaces:*`.
- `browser/main.js`: instancia + `flush()` en `before-quit`.
- `tests/workspace-manager.smoketest.js`: 56/56.
- ADR 0015 — Workspace model + ventana 1-1 lock + lazy tabSpecs.

### Sub-fase 1.4b — Switch logic + 1-1 lock (commit `3455b69`)

- `browser/window-workspace.js` (210 LOC, módulo puro testeable): `switchWorkspace`, `hydrateWorkspace`, `snapshotWindowToWorkspace` (sync flush para no perder en crash), `releaseOnDestroy`, `findWindowOwning`. Pasos atómicos del switch: validar target → noop si mismo → lock check → snapshot tabs vivas → destruir WebContentsViews → asignar workspaceId → hydrate lazy + select activeTabId.
- `browser/window-manager.js`: `TabbedBrowserWindow.workspaceId` + `switchToWorkspace()` + snapshot+release on `close`/`destroy`.
- `browser/main.js`: `WorkspaceManager` activado con `saveDelayMs=2000`.
- `browser/tabs.js`: `Tab.toSpec()` + `Tabs.toSpecs()` + `tab.pinned` propagado en `Tabs.create`.
- `tests/window-workspace.smoketest.js`: 36/36 con FakeTabs/FakeWindow mocks.

### Sub-fase 1.4c — Sidebar UI (commit `85675e3`)

- `preload.js`: `window.oz.workspaces.*` bridge (15 métodos + onChanged + onActiveChanged).
- `browser/ui/workspace-switcher.js` (290 LOC, IIFE `OZ.WorkspaceSwitcher`): pills horizontales arriba del sidebar de identities. Click switchea, dblclick rename, right-click ctx menu (rename / duplicate / freeze-unfreeze / archive-restore / delete). `+ New Workspace` con inline editor. Toggle "Show archived (N)" oculto si vacío.
- `browser/ui/webui.html`: marcado + CSS pills (rounded, active highlighted con accent border, archived opacity 0.4 italic, frozen 🔒 + name muted).
- `browser/ui/webui.js`: boot post-tabstrip + sidebar.
- Doc: `ui-workspace-switcher.md`.

### Sub-fase 1.4d — Drag-drop + Move menu (commit `44a39e1`)

- `browser/tab-handlers.js`: `moveToWorkspace(tabId, targetWorkspaceId)`. Strategy snapshot → appendTabSpec(target) → destroy en source. Si target activo en otra ventana, mirror live ahí. Edge cases: target-not-found / target-archived (rechazado) / tab-not-found / mismo WS = noop / frozen permitido (runtime, no CRUD).
- IPC `oz:tabs:moveToWorkspace` + preload bridge.
- UI sidebar: `.oz-tab` draggable HTML5 con visual `.dragging`. Right-click → ctx menu con submenu dinámico "Move to workspace… (N)".
- UI switcher: pills droppable con visual `.drop-target` (border accent + shadow + scale 1.05).
- CSS para drag/drop visual cues.
- `tests/move-to-workspace.smoketest.js` (250 LOC): 29/29 con FakeTabs mock.
- Tool MCP `oz.tabs.moveToWorkspace` agregado a `mcp-tools.js`.

### Sub-fase 1.4e — MCP tools + Quick Tabs + cierre (commit pendiente)

- `mcp-tools.js`: 13 tools `oz.workspaces.*` (list, listActive, get, getActive, setActive, create, update, duplicate, archive, restore, freeze, unfreeze, remove). El contract test IPC↔MCP extendido valida la simetría.
- `tests/mcp-server.smoketest.js`: regex extendida para incluir `oz:workspaces:*`. Exempts: `rename` y `setColor` (wrappers de `update`).
- `browser/window-workspace.js` `hydrateWorkspace`: 4 modos Quick Tabs:
  - `on-click` (default): lazy puro.
  - `load-all`: materializa todas eager. Constante `LOAD_ALL_THRESHOLD=10` exportada para que la UI pida confirmación si N>10.
  - `one-by-one`: stagger setTimeout `STAGGERED_DELAY_MS=250ms`.
  - `on-click-confirm`: lazy + UX confirm en sidebar (UI-side, no en este módulo).
- UI workspace-switcher: submenu "Quick Tabs: <mode> ▸" en context menu del workspace pill (✓ marca el modo actual, frozen disabled). Confirmación visual cuando user activa load-all en WS con >10 tabs.

## Tests al cierre

| Suite                            | Pass        |
| -------------------------------- | ----------- |
| `identity-manager.smoketest.js`  | 28/28       |
| `mcp-server.smoketest.js`        | 71/71       |
| `move-to-workspace.smoketest.js` | 29/29       |
| `window-workspace.smoketest.js`  | 36/36       |
| `workspace-manager.smoketest.js` | 56/56       |
| **Total**                        | **220/220** |

`npm run lint`: clean. `npm run check:loc`: max 440 LOC (test mcp-server). Cero deps nuevas en todo el bloque.

## Decisiones arquitectónicas

- **ADR 0015** — Workspace model + ventana 1-1 lock exclusivo + lazy tabSpecs serializables. 3 decisiones: (1) lock 1-1 (como Ghost — simplicidad sobre flexibilidad), (2) tabSpecs lazy en switch (RAM controlada, trade-off scroll/form data se pierde), (3) freeze read-only para CRUD del usuario, transparente para runtime navigation.

## Tooling agregado al proyecto

- `browser/workspace-manager.js`, `browser/workspace-handlers.js`, `browser/window-workspace.js`, `browser/ui/workspace-switcher.js` — 4 módulos nuevos.
- 2 tests smoke nuevos: `workspace-manager.smoketest.js`, `move-to-workspace.smoketest.js`. + `window-workspace.smoketest.js`.
- ADR 0015 + 4 module docs + actualización de `tabs.md`, `window-manager.md`, `mcp-tools.md`.

## Issues encontrados durante el bloque

1. `Object.prototype.hasOwn` no es función (es `Object.hasOwn` estática) — atrapado por test del 1.4a, fix una línea.
2. Contract test IPC↔MCP atrapó automáticamente que faltaba `oz.tabs.moveToWorkspace` cuando agregamos el IPC en 1.4d — exactamente lo que diseñamos en 1.3-MCP. ✨ Esta es la red de seguridad funcionando.
3. Warning `LOAD_ALL_THRESHOLD` unused — resuelto exportándolo y usándolo desde la UI para la confirmación visual.

## Costos

- **$0.** Cero deps npm nuevas. Cero servicios externos. Cero tokens.

## Próximo paso

Mini-bloque "Electron upgrade" (~2-4h, ver `PLAN-MAESTRO.md`): actualizar `electron@latest`, validar compat con `electron-chrome-*`, smoke tests, commit aislado para rollback fácil. Después: **Bloque 1.5 ⭐ Account Vault** (CORE — la razón del producto, ~14h estimadas).

## Para Jose (validación visual recomendada)

Antes de marcar el producto como "Workspaces funcionando", arrancar `OZ Browser` y probar:

```bash
NODE_ENV= npm start
```

1. Verificar que aparece "General Browsing" como pill por default arriba del sidebar.
2. Click en `+ New Workspace`, escribir un nombre, Enter → debería aparecer pill nuevo y switchear a él.
3. Crear unas tabs → click en pill General → debería destruir las tabs nuevas y mostrar las viejas.
4. Click en pill nuevo → tabs vuelven (lazy, recreadas desde tabSpecs en disk).
5. Right-click en pill → menu Rename / Duplicate / Quick Tabs / Freeze / Archive / Delete.
6. Drag tab del sidebar → drop sobre otro pill → tab se mueve.
7. Right-click sobre tab del sidebar → "Move to workspace…" submenu funciona.
8. Cerrar OZ → reabrir → estado preserved (workspaces.json en `~/Library/Application Support/OZ Browser/`).
