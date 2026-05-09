# Módulo `window-workspace`

**Path:** `browser/window-workspace.js`
**Líneas:** ~210
**Bloque/Etapa:** 1.4-WS (Fase 1.4b)

## Qué hace

Implementa el switch atómico de workspace en una ventana, con lock exclusivo (1 ventana = 1 WS, 1 WS = max 1 ventana). Lógica extraída en módulo puro para testearla sin Electron real (recibe `tabs` como dependency vía `window.tabs`).

Usado por `TabbedBrowserWindow.switchToWorkspace()` y `TabbedBrowserWindow.destroy()` en `window-manager.js`.

Modelo y rationale completos en [ADR 0015](../architecture/0015-workspace-model.md).

## Exports

| Símbolo                                                           | Tipo     | Descripción                                                                         |
| ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `switchWorkspace({window, browser, targetWorkspaceId, options?})` | function | Switch atómico con lock check. Retorna `{ok, ...}`.                                 |
| `hydrateWorkspace({window, browser, options?})`                   | function | Recrea tabs lazy desde tabSpecs del workspace activo. Crea newtab si vacío.         |
| `snapshotWindowToWorkspace(window, browser, workspaceId)`         | function | Persiste tabs vivas → tabSpecs (sync save). Llamado por switchWorkspace y release.  |
| `releaseOnDestroy(window, browser)`                               | function | Snapshot final + libera el lock (`workspaceId = null`). Llamar en destroy/close.    |
| `findWindowOwning(browser, workspaceId)`                          | function | Devuelve la ventana que tiene un workspaceId activo, o null. Para enforce del lock. |

## switchWorkspace — pasos atómicos

1. Validar workspace existe → si no, `{ok:false, reason:'not-found'}`.
2. Si target === current → `{ok:true, noop:true}`.
3. **Lock check:** si target ya está activo en otra ventana → `{ok:false, reason:'already-open', ownerWindowId}`.
4. Snapshot de las tabs vivas del WS actual → `tabSpecs` (sync save vía `flush()`).
5. Destruir todas las tabs vivas (libera WebContentsViews).
6. Asignar `window.workspaceId = targetWorkspaceId` (antes de hidratar — para que futuros locks lo vean).
7. `hydrateWorkspace`: recrea lazy tabs desde tabSpecs del nuevo WS, selecciona `activeTabId` persistido (o tab[0], o crea newtab si vacío).

Retorna `{ok:true, workspaceId, from:fromWorkspaceId}`.

## hydrateWorkspace — comportamiento

- **Sin tabSpecs** (workspace recién creado / first arrival): crea 1 newtab eager con `browser.urls.newtab`.
- **Con tabSpecs**: recrea cada uno como Tab lazy preservando `id`, `identityId`, `url`, `title`, `favicon`, `pinned`. Selecciona `ws.activeTabId` si existe (materializa al hacer select); si stale, fallback a `tabList[0]`.

## releaseOnDestroy

Llamar antes de cerrar la ventana (idempotente — chequea `workspaceId`):

1. `snapshotWindowToWorkspace` (sync save).
2. `window.workspaceId = null` — libera el lock para que otra ventana pueda tomar el WS.

Wireado en `TabbedBrowserWindow`:

- En `this.window.on('close', ...)` (cierre por user)
- En `destroy()` (cierre programático)

## Persistencia

`snapshotWindowToWorkspace` llama `wm.flush()` después de `setTabSpecs` para forzar sync save. Esto es crítico: un crash entre snapshot y destroy NO debe perder tabs (la copia ya está en disk antes de destruir las vivas).

## Dependencias

- `browser.workspaceManager` — backend.
- `browser.windows` — para `findWindowOwning`.
- `window.tabs` — debe tener `tabList`, `selected`, `create()`, `remove()`, `select()`, `get()`, `toSpecs()`. El test mockea esto con `FakeTabs` para correr sin Electron.
- `./logger.js`.

## Tests

- `tests/window-workspace.smoketest.js` — 36 tests cubriendo:
  - Switch sin tabSpecs → newtab fresh
  - Lock exclusivo → reason='already-open' + ownerWindowId
  - Switch al mismo WS → noop
  - Switch a WS inexistente → reason='not-found'
  - Switch a WS con tabSpecs → recrea + activeTabId
  - activeTabId stale → fallback a tab[0]
  - releaseOnDestroy snapshot + libera + nueva ventana puede tomar el WS
  - findWindowOwning correctness
  - Snapshot al switch sobrescribe tabSpecs viejas

## Referencias

- [`window-manager.md`](window-manager.md) — el caller que orquesta esto.
- [`workspace-manager.md`](workspace-manager.md) — backend de persistencia.
- [`tabs.md`](tabs.md) — `Tab.toSpec()` y `Tabs.toSpecs()` agregados en 1.4b para serialización.
- [ADR 0015](../architecture/0015-workspace-model.md) — modelo + lock + lazy tabSpecs.
- [ADR 0002](../architecture/0002-lazy-tabs.md) — lazy materialization base reusada.
