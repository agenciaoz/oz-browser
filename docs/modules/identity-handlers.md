# Módulo `identity-handlers`

**Path:** `browser/identity-handlers.js`
**Líneas:** ~95
**Bloque/Etapa:** 1.3-MCP

## Qué hace

Factoriza la lógica de los handlers IPC del dominio Identity en un mapa puro `{name → fn}` consumido por DOS layers:

1. `ipc-handlers.js` que los registra como `ipcMain.handle('oz:identities:X', fn)`.
2. `mcp-server.js` que los expone como tools MCP `oz.identities.X` via `mcp-tools.js`.

Misma implementación, dos transports. Sin duplicación.

## Exports

| Símbolo                          | Tipo     | Descripción                                                                                                                                    |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildIdentityHandlers(browser)` | function | Retorna `{list, get, getActive, setActive, create, rename, setColor, update, remove}`. Cada función toma argumentos posicionales (no `event`). |

## Handlers

| Nombre                | Args                                    | Returns                 | Side effects                                                                  |
| --------------------- | --------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `list()`              | —                                       | array                   | —                                                                             |
| `get(id)`             | `id: string`                            | identity \| null        | —                                                                             |
| `getActive()`         | —                                       | activeIdentityId        | —                                                                             |
| `setActive(id)`       | `id`                                    | bool                    | broadcast `oz:identities:active-changed`                                      |
| `create(opts)`        | `{name?, color?, userAgent?}`           | identity \| `{__error}` | broadcast `oz:identities:changed`. Free-tier cap 3 (bypass `OZ_TIER=paid`).   |
| `rename(id, name)`    | —                                       | identity \| null        | broadcast                                                                     |
| `setColor(id, color)` | —                                       | identity \| null        | broadcast                                                                     |
| `update(id, patch)`   | `id, patch:{name?, color?, userAgent?}` | identity \| null        | broadcast. Default rejects userAgent (ADR 0010).                              |
| `remove(id)`          | `id`                                    | bool                    | broadcast. Default no se puede remover. Si activeId === id, switch a Default. |

## Dependencias

- `browser.identityManager` — backend (`identity-manager.js`).
- `browser.activeIdentityId` — pointer al active.
- `browser.broadcastToWebUI(channel, ...args)` — fan-out al WebUI (sidebar/tabstrip) y a SSE clientes del MCP.
- `./logger.js` — info/warn structured logging.

## Convenciones

- Cada handler es **idempotente** y **stateless** respecto al map mismo (toda mutación va a `browser.*`).
- El nombre de cada handler (key del map) coincide con el sufijo del IPC channel y del tool MCP. P. ej. `list` ↔ `oz:identities:list` ↔ `oz.identities.list`.
- Errores estructurados se devuelven como `{__error: {code, message, ...}}` (no throw) cuando son recuperables (cap reached). Errores fatales se dejan throwear.
- Logging: handlers críticos (create/setActive/remove) loggean al final. Lectura puro (list/get/getActive) no loggea para evitar ruido.

## Tests

- `tests/identity-manager.smoketest.js` cubre el backend (IdentityManager).
- `tests/mcp-server.smoketest.js` cubre los handlers a través del transport MCP (create, list, getMetrics validan que el map se invoca correctamente).

## Referencias

- [`ipc-handlers.md`](ipc-handlers.md) — IPC adapter.
- [`mcp-server.md`](mcp-server.md) — MCP transport.
- [`identity-manager.md`](identity-manager.md) — backend que estos handlers invocan.
- [ADR 0012](../architecture/0012-oz-mcp-server.md) — el refactor que extrajo este módulo.
