# Módulo `mcp-server`

**Path:** `browser/mcp-server.js`
**Líneas:** ~250
**Bloque/Etapa:** 1.3-MCP

## Qué hace

Server MCP embebido en el main process de Electron. Expone los handler maps de `browser.handlers.{identities,tabs}` como tools MCP estándar (JSON-RPC 2.0 over HTTP localhost). Off por default; se activa con `OZ_MCP_ENABLED=1` env.

Es **hand-rolled** (no usa @modelcontextprotocol/sdk) — ver [ADR 0012 update bis](../architecture/0012-oz-mcp-server.md). Wire protocol idéntico al estándar MCP, compatible con Claude Code/Cursor vía `tools/mcp-stdio-bridge.js`.

## Exports

| Símbolo     | Tipo  | Descripción                                                                                                                                                                |
| ----------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCPServer` | class | Server MCP. Se instancia con `(browser, options)` donde options puede tener `port` (default 9223) y `token` (default null = sin auth). Métodos `start()` / `stop()` async. |

## Endpoints HTTP

| Método    | Path          | Descripción                                                                                                                                |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`     | `/health`     | Snapshot de métricas del runtime ({status, uptime, tabs, identities, memory})                                                              |
| `POST`    | `/mcp`        | JSON-RPC 2.0 — soporta `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`. Batch de requests también soportado. |
| `GET`     | `/mcp/events` | Server-Sent Events stream — `event: <channel>\\ndata: {...}\\n\\n`. Filtro opcional `?channels=tabs.*,identities.*`.                       |
| `OPTIONS` | \*            | CORS preflight (allow loopback only).                                                                                                      |

## Auth

- Default: localhost-only (binds `127.0.0.1`, nunca `0.0.0.0`).
- Opcional: `OZ_MCP_TOKEN=<secret>` → cada request requiere `Authorization: Bearer <secret>`. 401 si falta o difiere.
- No CORS para origins remotos.

## Tools v1 (13)

Ver [`mcp-tools.md`](mcp-tools.md) para la lista detallada con schemas.

- `oz.identities.list/get/getActive/setActive/create/update/remove` (7)
- `oz.tabs.list/openInIdentity/select/close` (4)
- `oz.system.getMetrics` (1)
- `oz.events.subscribe` (1) — special: redirige al endpoint SSE.

## Configuración

Variables de entorno reconocidas:

| Var              | Default          | Descripción                                                                   |
| ---------------- | ---------------- | ----------------------------------------------------------------------------- |
| `OZ_MCP_ENABLED` | unset (off)      | `1` o `true` para activar. Si está off, `MCPServer` ni siquiera se instancia. |
| `OZ_MCP_PORT`    | `9223`           | Puerto TCP. Si choca con otro proceso, `start()` rejecta.                     |
| `OZ_MCP_TOKEN`   | unset (sin auth) | Bearer token. Setear en producción.                                           |

## Lifecycle

`Browser.init()` instancia + `start()` después de cargar IdentityManager y crear la primera ventana. `Browser.destroy()` y `before-quit` llaman a `stop()`. Stop cierra todas las conexiones SSE abiertas y desinscribe el monkey-patch a `broadcastToWebUI`.

## SSE wiring (importante)

Para emitir eventos al stream SSE, monkey-patcheamos `browser.broadcastToWebUI` durante `_wireBrowserEvents()`. Cada call a `broadcastToWebUI('oz:tabs:updated', payload)` se duplica:

1. Sigue invocando el broadcast original (renderers de WebUI siguen recibiendo via IPC).
2. Re-mapea el channel a dot-form (`oz:tabs:updated` → `tabs.updated`) y lo emite por SSE a todos los clientes conectados.

Al `stop()` se restaura el método original.

## Gotchas

- **`process.stdin/stdout` ocupados por Electron** — por eso no se hace stdio embebido. El `tools/mcp-stdio-bridge.js` standalone hace el bridge stdio→HTTP.
- **GCM authTag manual** — no aplica aquí pero en el Vault sí ([ADR 0008](../architecture/0008-account-vault-encryption.md)).
- **No persiste estado** — el server vive solo mientras OZ Browser corre. Reinicio de OZ = reinicio del server.
- **Notificaciones JSON-RPC sin id** — `_dispatchRpc` retorna `null` para que la response no se serialize; el HTTP layer escribe `null` como body.

## Ejemplos de uso

### Cliente curl

```bash
# Ping
curl -X POST http://localhost:9223/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

# List identities
curl -X POST http://localhost:9223/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oz.identities.list","arguments":{}}}'

# SSE stream
curl -N http://localhost:9223/mcp/events
```

### Desde Claude Code

`~/.config/claude-code/mcp.json` (o donde guarde la config tu versión):

```json
{
  "mcpServers": {
    "oz-browser": {
      "command": "node",
      "args": [
        "/Users/joserodrigo/Documents/Claude/Projects/Ghost Browser Clone/oz-browser/tools/mcp-stdio-bridge.js"
      ],
      "env": { "OZ_MCP_URL": "http://localhost:9223" }
    }
  }
}
```

## Tests

`tests/mcp-server.smoketest.js` — 57 assertions cubriendo: server boot, health, initialize, tools/list, tools/call (varios tools), unknown tool/method, parse errors, bearer token, SSE, contract IPC↔MCP.

## Referencias

- [ADR 0012](../architecture/0012-oz-mcp-server.md) — diseño, scope v1, pivot SDK→hand-rolled.
- Especificación MCP: https://spec.modelcontextprotocol.io/
- [`mcp-tools.md`](mcp-tools.md) — catálogo de tools.
- [`identity-handlers.md`](identity-handlers.md) y [`tab-handlers.md`](tab-handlers.md) — handler maps consumidos.
- [`../guides/mcp-automation.md`](../guides/mcp-automation.md) — quickstart de uso.
