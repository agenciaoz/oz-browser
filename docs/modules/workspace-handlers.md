# Módulo `workspace-handlers`

**Path:** `browser/workspace-handlers.js`
**Líneas:** ~165
**Bloque/Etapa:** 1.4-WS

## Qué hace

Factoriza la lógica de los handlers IPC del dominio Workspace en un mapa puro `{name → fn}` consumido por DOS layers:

1. `ipc-handlers.js` que los registra como `ipcMain.handle('oz:workspaces:X', fn)` (1.4a — listo).
2. `mcp-server.js` que los expone como tools MCP `oz.workspaces.X` via `mcp-tools.js` (1.4e — pendiente).

Misma implementación, dos transports. Mismo patrón que `identity-handlers.js`.

## Exports

| Símbolo                           | Tipo     | Descripción                                                   |
| --------------------------------- | -------- | ------------------------------------------------------------- |
| `buildWorkspaceHandlers(browser)` | function | Retorna el handler map. Llamado una vez en `ipc-handlers.js`. |

## Handlers

| Nombre                              | Args                              | Returns                  | Side effects                                                                                                                   |
| ----------------------------------- | --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `list()`                            | —                                 | array (todos)            | —                                                                                                                              |
| `listActive()`                      | —                                 | array (no-archivados)    | —                                                                                                                              |
| `get(id)`                           | `id`                              | workspace \| null        | —                                                                                                                              |
| `getActive(windowId?)`              | optional id de ventana            | workspaceId \| null      | Si no se pasa windowId, usa la focused window.                                                                                 |
| `setActive(workspaceId, windowId?)` | —                                 | `{ok, workspaceId, ...}` | broadcast `oz:workspaces:active-changed`. En 1.4a es STUB (solo setea `win.workspaceId`); en 1.4b llamará `switchToWorkspace`. |
| `create(opts)`                      | `{name?, color?, quickTabsMode?}` | workspace                | broadcast `oz:workspaces:changed`.                                                                                             |
| `update(id, patch)`                 | `id, patch`                       | workspace \| null        | broadcast. Frozen rechaza retornando `null`.                                                                                   |
| `rename(id, name)`                  | —                                 | workspace \| null        | broadcast.                                                                                                                     |
| `setColor(id, color)`               | —                                 | workspace \| null        | broadcast.                                                                                                                     |
| `duplicate(id)`                     | `id`                              | workspace \| null        | broadcast.                                                                                                                     |
| `archive(id)`                       | `id`                              | bool                     | broadcast. Default protegido.                                                                                                  |
| `restore(id)`                       | `id`                              | bool                     | broadcast.                                                                                                                     |
| `freeze(id)` / `unfreeze(id)`       | `id`                              | bool                     | broadcast.                                                                                                                     |
| `remove(id)`                        | `id`                              | bool                     | broadcast. Default protegido. Si era activo en alguna ventana, fallback automático a Default antes del remove.                 |

## Dependencias

- `browser.workspaceManager` — backend (`workspace-manager.js`).
- `browser.windows` — array de `TabbedBrowserWindow` para resolver `windowId`.
- `browser.getFocusedWindow()` — para handlers que no reciben `windowId` explícito.
- `browser.broadcastToWebUI(channel, ...args)` — fan-out a sidebar y SSE clientes del MCP.
- `./logger.js`.

## Convenciones

- Cada handler es **idempotente** y **stateless** respecto al map mismo.
- El nombre de cada handler coincide con el sufijo del IPC channel y del tool MCP futuro: `list` ↔ `oz:workspaces:list` ↔ `oz.workspaces.list`.
- `setActive` retorna `{ok, ...}` (no bool simple) porque queremos diferenciar entre `not-found`, `already-open` (lock conflict, 1.4b), `frozen-blocked`, etc. El IPC layer pasa el objeto sin transformar.
- `remove` con auto-fallback a Default: si el WS borrado era activo en alguna ventana, esa ventana hace switch a Default antes de borrar la entrada. Esto evita ventanas con `workspaceId` apuntando a un WS inexistente.

## IPC channels registrados (en `ipc-handlers.js`)

```
oz:workspaces:list           → list()
oz:workspaces:listActive     → listActive()
oz:workspaces:get            → get(id)
oz:workspaces:getActive      → getActive(windowId?)
oz:workspaces:setActive      → setActive(workspaceId, windowId?)
oz:workspaces:create         → create(opts)
oz:workspaces:update         → update(id, patch)
oz:workspaces:rename         → rename(id, name)
oz:workspaces:setColor       → setColor(id, color)
oz:workspaces:duplicate      → duplicate(id)
oz:workspaces:archive        → archive(id)
oz:workspaces:restore        → restore(id)
oz:workspaces:freeze         → freeze(id)
oz:workspaces:unfreeze       → unfreeze(id)
oz:workspaces:remove         → remove(id)
```

## Eventos broadcast

| Channel                        | Payload                   | Cuándo                                 |
| ------------------------------ | ------------------------- | -------------------------------------- |
| `oz:workspaces:changed`        | (none)                    | Cualquier mutación CRUD del modelo.    |
| `oz:workspaces:active-changed` | `{windowId, workspaceId}` | Cuando una ventana cambia su activeWS. |

## Tests

- `tests/workspace-manager.smoketest.js` — backend (`WorkspaceManager` directo).
- Contract test IPC↔MCP que valida `oz.workspaces.*` invocables ambos transports — pendiente para Bloque 1.4e.

## Referencias

- [`workspace-manager.md`](workspace-manager.md) — backend.
- [`identity-handlers.md`](identity-handlers.md) — patrón análogo.
- [`ipc-handlers.md`](ipc-handlers.md) — IPC adapter.
- [ADR 0015](../architecture/0015-workspace-model.md) — modelo y decisión de lock exclusivo.
- [ADR 0012](../architecture/0012-oz-mcp-server.md) — patrón handlers shared IPC↔MCP.
