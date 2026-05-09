# Módulo `tab-handlers`

**Path:** `browser/tab-handlers.js`
**Líneas:** ~85
**Bloque/Etapa:** 1.3-MCP

## Qué hace

Factoriza la lógica de los handlers IPC del dominio Tabs en un mapa puro `{name → fn}` consumido por DOS layers (ipc-handlers.js y mcp-server.js). Mismo patrón que `identity-handlers.js`.

## Exports

| Símbolo                     | Tipo     | Descripción                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------- |
| `buildTabHandlers(browser)` | function | Retorna `{list, getIdentity, openInIdentity, select, close, bulkCreateLazy}`. |

## Handlers

| Nombre                                            | Args    | Returns                                | Side effects                                                                    |
| ------------------------------------------------- | ------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `list()`                                          | —       | array of `{...tabSerialize, windowId}` | —                                                                               |
| `getIdentity(tabId)`                              | `tabId` | identityId \| null                     | —                                                                               |
| `openInIdentity(identityId, url?)`                | —       | tabId \| null                          | crea tab lazy en focused window. Broadcast `oz:tabs:updated kind=created`.      |
| `select(tabId)`                                   | —       | bool                                   | materializa si lazy. Broadcast tab-selected.                                    |
| `close(tabId)`                                    | —       | bool                                   | destroy + broadcast `oz:tabs:updated kind=removed`.                             |
| `bulkCreateLazy(count, identityId, urlTemplate?)` | —       | count                                  | crea N tabs lazy en focused window. URL template puede tener `{i}` placeholder. |

## Dependencias

- `browser.windows` — array de TabbedBrowserWindow para iterar.
- `browser.getFocusedWindow()` — para `openInIdentity` y `bulkCreateLazy`.
- `browser.broadcastToWebUI` — fan-out IPC + SSE.

## Tools NO expuestos a MCP v1 (deferred)

| IPC channel              | Razón                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `oz:tabs:getIdentity`    | Info disponible vía `oz.tabs.list` (cada item incluye `identityId`).                  |
| `oz:tabs:bulkCreateLazy` | Power-user feature, reduce v1 surface. Se puede invocar via N `openInIdentity` calls. |

Documentado en `tests/mcp-server.smoketest.js` (sección "Contract test IPC↔MCP") como exempt explícito.

## Tools que entran en bloques siguientes

Cuando se necesiten (Bloque 1.5 Vault → flows de auto-fill):

- `oz.tabs.navigate(tabId, url)` — programmatic nav
- `oz.tabs.getURL/getTitle/getCookies(tabId)` — read state
- `oz.tabs.executeJS(tabId, script)` — `Runtime.evaluate` equivalent
- `oz.tabs.getDOMSnapshot(tabId)` — HTML serializado
- `oz.tabs.screenshot(tabId)` — PNG bytes
- `oz.tabs.waitForSelector(tabId, selector, timeout)` — bloqueante

Estas requieren acceso a `tab.webContents` que está disponible solo si el tab está materializado. La implementación incluye lazy materialization on-demand.

## Tests

`tests/mcp-server.smoketest.js` cubre `list` y `openInIdentity` indirectamente (via mock browser sin windows reales). Tests más profundos requieren una sesión real de Electron — diferidos al smoke test visual del 1.4-WS.

## Referencias

- [`ipc-handlers.md`](ipc-handlers.md), [`mcp-server.md`](mcp-server.md).
- [`tabs.md`](tabs.md) — backend Tab + Tabs class.
- [ADR 0002](../architecture/0002-lazy-tabs.md) — lazy tabs.
- [ADR 0012](../architecture/0012-oz-mcp-server.md) — MCP design.
