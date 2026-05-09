# Módulo `ipc-handlers`

**Path:** `browser/ipc-handlers.js`
**Líneas:** ~140
**Bloque:** 1.2 ✅ · **refactor en 1.3-MCP** (extrajo identity-handlers.js + tab-handlers.js)

## Qué hace

Adapter delgado que registra `ipcMain.handle('oz:X:Y', fn)` consumiendo los handler maps que exportan [`identity-handlers.js`](identity-handlers.md) y [`tab-handlers.js`](tab-handlers.md). Mismos handlers que consume el [`mcp-server.js`](mcp-server.md) — un solo lugar implementa la lógica, dos transports la exponen.

Además registra los handlers que NO van a MCP por ahora: log/error reporting, navigation (back/forward/reload), UI overlay control (`oz:ui:setContentVisible`).

## Exports

| Símbolo                        | Tipo     | Descripción                                                                                                                    |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `registerIpcHandlers(browser)` | function | Registra TODOS los IPC channels. Side effect: pone `browser.handlers = {identities, tabs}` para que mcp-server.js los consuma. |

## IPC channels registrados

### Identities (delegan a `browser.handlers.identities`)

| Channel                   | Args      | Returns                 | Tool MCP equivalente                                  |
| ------------------------- | --------- | ----------------------- | ----------------------------------------------------- |
| `oz:identities:list`      | —         | Identity[]              | `oz.identities.list`                                  |
| `oz:identities:get`       | id        | Identity\|null          | `oz.identities.get`                                   |
| `oz:identities:getActive` | —         | string                  | `oz.identities.getActive`                             |
| `oz:identities:setActive` | id        | bool                    | `oz.identities.setActive`                             |
| `oz:identities:create`    | opts      | Identity \| `{__error}` | `oz.identities.create`                                |
| `oz:identities:rename`    | id, name  | Identity\|null          | (wrapper de oz.identities.update — no expuesto a MCP) |
| `oz:identities:setColor`  | id, color | Identity\|null          | (wrapper de oz.identities.update — no expuesto a MCP) |
| `oz:identities:update`    | id, patch | Identity\|null          | `oz.identities.update`                                |
| `oz:identities:remove`    | id        | bool                    | `oz.identities.remove`                                |

### Tabs (delegan a `browser.handlers.tabs`)

| Channel                  | Args            | Returns      | Tool MCP equivalente               |
| ------------------------ | --------------- | ------------ | ---------------------------------- |
| `oz:tabs:list`           | —               | Tab[]        | `oz.tabs.list`                     |
| `oz:tabs:getIdentity`    | tabId           | string\|null | (info via list, no expuesto a MCP) |
| `oz:tabs:openInIdentity` | identityId, url | tabId        | `oz.tabs.openInIdentity`           |
| `oz:tabs:select`         | tabId           | bool         | `oz.tabs.select`                   |
| `oz:tabs:close`          | tabId           | bool         | `oz.tabs.close`                    |
| `oz:tabs:bulkCreateLazy` | count, id, tpl  | count        | (no expuesto a MCP v1)             |

### Logging / errors (no MCP)

| Channel           | Args                           | Returns | Descripción                                      |
| ----------------- | ------------------------------ | ------- | ------------------------------------------------ |
| `oz:log`          | level, source, message, args[] | true    | Forward de log desde renderer al logger central. |
| `oz:report-error` | detail                         | true    | Loggea + showErrorDialog.                        |

### Navigation (no MCP por ahora)

Operan sobre el tab focused. Diferidos a Bloque 1.5 cuando el Vault necesite manejar login flows programáticamente — ahí entra `oz.tabs.navigate` como tool MCP.

| Channel          | Returns | Descripción                           |
| ---------------- | ------- | ------------------------------------- |
| `oz:nav:back`    | bool    | navigationHistory.goBack si canGoBack |
| `oz:nav:forward` | bool    | idem forward                          |
| `oz:nav:reload`  | bool    | tab.reload()                          |
| `oz:nav:loadURL` | bool    | tab.loadURL(url)                      |

### UI overlay (no MCP — específico del WebUI)

| Channel                   | Args | Returns | Descripción                                                                                                                                     |
| ------------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `oz:ui:setContentVisible` | bool | bool    | Hide/show del WebContentsView del tab focused. ADR 0011 (modales tapan content view). Resolve via `event.sender` para multi-window correctness. |

## Patrón de organización

```
browser.handlers.identities ← buildIdentityHandlers(browser) [identity-handlers.js]
browser.handlers.tabs       ← buildTabHandlers(browser)      [tab-handlers.js]
                                ↓                                ↓
                       ipcMain.handle('oz:X:Y', fn)     mcp-tools.js  → MCPServer
                       (este archivo)                    (mcp-server.js)
```

Cada dominio nuevo del producto agrega `<domain>-handlers.js` con su `build*Handlers(browser)` y se enchufa en `registerIpcHandlers` + `mcp-tools.js` simultáneamente. Convención del refactor del 1.3-MCP — antes había duplicación entre IPC layer y futuro MCP layer.

## Gotchas

- Si reasignas `browser.identityManager`, los handler maps cacheados en `browser.handlers` siguen apuntando al viejo (closures). En flow normal el manager se setea una vez en `Browser.init()`, no es un issue. En testing usar mock browsers.
- `ipcMain.handle` es promise-returning. Si throws, el caller (renderer) recibe error. Errores recuperables (cap reached) van como `{__error}` no throw — UX cleaner.
- `broadcastToWebUI` se monkey-patcha por `mcp-server.js` para fan-out a SSE clients. La función original se restaura en `mcp-server.stop()`. Si `mcp-server` crashea sin stop, el patch queda — leak menor en main process.

## Referencias

- [`identity-handlers.md`](identity-handlers.md), [`tab-handlers.md`](tab-handlers.md) — los maps que se consumen.
- [`mcp-server.md`](mcp-server.md), [`mcp-tools.md`](mcp-tools.md) — el segundo consumidor.
- [ADR 0009](../architecture/0009-logging-everything.md), [ADR 0011](../architecture/0011-modals-hide-content-view.md), [ADR 0012](../architecture/0012-oz-mcp-server.md).
