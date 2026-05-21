# Guía: OZ MCP server — automation

> Server MCP embebido en OZ Browser. Habilita Claude Code, Cursor, scripts curl y SDKs Python/JS para controlar OZ programáticamente. Off por default.

## TL;DR

```bash
# Activá MCP al arrancar OZ
OZ_MCP_ENABLED=1 npm start

# Hablale por curl
curl -X POST http://localhost:9223/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Variables de entorno

| Var              | Default     | Descripción                                                                                     |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `OZ_MCP_ENABLED` | unset (off) | `1` o `true` para activar el server.                                                            |
| `OZ_MCP_PORT`    | `9223`      | Puerto TCP. Cambialo si choca con otro proceso.                                                 |
| `OZ_MCP_TOKEN`   | unset       | Bearer token para auth. **Setear si vas a exponerlo más allá de localhost por SSH tunnel etc.** |

## Endpoints

| Método | Path          | Para qué                                                                 |
| ------ | ------------- | ------------------------------------------------------------------------ |
| GET    | `/health`     | Sanity check + métricas. No requiere auth si no hay token.               |
| POST   | `/mcp`        | JSON-RPC 2.0. Métodos: `initialize`, `tools/list`, `tools/call`, `ping`. |
| GET    | `/mcp/events` | Server-Sent Events. Filtro `?channels=tabs.*,identities.*`.              |

## Nombres de tools — underscore-as-separator

Desde **v1.9.3** el server expone los nombres de tools con `_` en lugar de `.` como separador, para cumplir con el regex `^[a-zA-Z0-9_-]{1,64}$` que Anthropic frontend (Claude.ai chat, Claude Desktop) enforce-a. Ejemplos:

```
oz_identities_list       (forma canónica)
oz_tabs_openInIdentity
oz_system_getMetrics
```

La forma legacy con puntos (`oz.identities.list`) **sigue funcionando en `tools/call`** como backwards-compat para Cowork, scripts internos y el contract test. Pero **`tools/list` solo devuelve la forma sanitizada**, y cualquier cliente nuevo debería usar underscore form.

Ver ADR 0012 "Update 2026-05-20" para el detalle.

## Tools v1 (13)

```
oz_identities_list
oz_identities_get(id)
oz_identities_getActive
oz_identities_setActive(id)
oz_identities_create({name?, color?, userAgent?})
oz_identities_update(id, patch)
oz_identities_remove(id)

oz_tabs_list
oz_tabs_openInIdentity(identityId, url?)
oz_tabs_select(tabId)
oz_tabs_close(tabId)

oz_system_getMetrics
oz_events_subscribe (redirige a GET /mcp/events)
```

Para detalle completo de schemas: `tools/list` o ver [`../modules/mcp-tools.md`](../modules/mcp-tools.md).

## Setup en Claude Code

`~/Library/Application Support/Claude/claude-code-config.json` (o donde guarde tu versión):

```json
{
  "mcpServers": {
    "oz-browser": {
      "command": "node",
      "args": [
        "/Users/joserodrigo/Documents/Claude/Projects/Ghost Browser Clone/oz-browser/tools/mcp-stdio-bridge.js"
      ],
      "env": {
        "OZ_MCP_URL": "http://localhost:9223"
      }
    }
  }
}
```

Si setteás `OZ_MCP_TOKEN`, sumalo al `env`:

```json
"env": { "OZ_MCP_URL": "http://localhost:9223", "OZ_MCP_TOKEN": "tu-secret" }
```

Reiniciá Claude Code → veras `oz-browser` en la lista de servers MCP. Las tools aparecen con prefijo `oz_*` (underscore form — ver sección "Nombres de tools" arriba).

## Setup en Cursor

`~/.cursor/mcp.json` con el mismo formato. Reinicio.

## Setup en Python (cliente directo HTTP)

```python
import httpx, json
URL = "http://localhost:9223/mcp"
TOKEN = None  # o "tu-secret"

def call_tool(name, args=None):
    headers = {"Content-Type": "application/json"}
    if TOKEN: headers["Authorization"] = f"Bearer {TOKEN}"
    r = httpx.post(URL, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": args or {}}
    }, headers=headers)
    r.raise_for_status()
    response = r.json()
    if "error" in response: raise Exception(response["error"])
    return response["result"]["_meta"]["value"]

# Uso
print(call_tool("oz_identities_list"))
new_ident = call_tool("oz_identities_create", {"name": "Bot 1", "color": "#5b8def"})
print(new_ident["id"])
```

## Setup en Node (cliente directo HTTP)

```js
const URL = 'http://localhost:9223/mcp'
const TOKEN = process.env.OZ_MCP_TOKEN || null

async function callTool(name, args = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`
  const r = await fetch(URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result._meta.value
}

console.log(await callTool('oz_identities_list'))
```

## Suscribirse a eventos en vivo (SSE)

```bash
curl -N http://localhost:9223/mcp/events
# Output continuo:
# event: hello
# data: {"channel":"hello","payload":{"protocolVersion":"2024-11-05",...},"ts":...}
#
# event: tabs.updated
# data: {"channel":"tabs.updated","payload":{"kind":"created","tab":{...}},"ts":...}
```

```bash
# Solo eventos de tabs:
curl -N "http://localhost:9223/mcp/events?channels=tabs.*"

# Solo identities:
curl -N "http://localhost:9223/mcp/events?channels=identities.*"
```

## Eventos disponibles

| Channel                     | Cuándo se emite                               | Payload típico                  |
| --------------------------- | --------------------------------------------- | ------------------------------- |
| `hello`                     | al conectarse                                 | `{protocolVersion, serverTime}` |
| `tabs.updated`              | tab creado/actualizado/seleccionado/destruido | `{kind, tab?, tabId?}`          |
| `identities.changed`        | crear/rename/update/remove de identity        | (sin payload extra)             |
| `identities.active-changed` | cambio de active identity                     | `<newId>`                       |

## Patrones útiles

### Crear N identities desde Excel

```python
import pandas as pd
df = pd.read_excel("clientes.xlsx")
for _, row in df.iterrows():
    call_tool("oz_identities_create", {
        "name": row["nombre"],
        "color": row.get("color", None),
    })
```

### Smoke test: validar que crear → listar → eliminar funciona

```python
created = call_tool("oz_identities_create", {"name": "smoke"})
assert created["id"], "no id"
listed = call_tool("oz_identities_list")
assert any(i["id"] == created["id"] for i in listed)
ok = call_tool("oz_identities_remove", {"id": created["id"]})
assert ok is True
```

### Monitorear memoria de OZ

```bash
watch -n 2 'curl -s http://localhost:9223/health | jq'
```

## Seguridad

- **Never bind 0.0.0.0.** El server está hardcoded a `127.0.0.1`. Si necesitás acceso desde otra máquina, usá SSH tunnel, no bind público.
- **Setear `OZ_MCP_TOKEN`** si dejás OZ corriendo con MCP enabled en una máquina compartida.
- **No expongas tokens en commits ni en logs.** Loggeamos `tokenRequired: true/false`, nunca el token.
- **Las tools del Vault van a requerir auth adicional** cuando se agreguen en Bloque 1.5. Master password o session token, no solo el bearer.

## Troubleshooting

| Síntoma                                    | Causa                                                  | Fix                                                                     |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `ECONNREFUSED localhost:9223`              | OZ no corriendo o `OZ_MCP_ENABLED` unset               | `OZ_MCP_ENABLED=1 npm start`                                            |
| `EADDRINUSE :9223`                         | otro proceso ocupa el puerto                           | `lsof -i :9223 -t \| xargs kill -9` o `OZ_MCP_PORT=9224`                |
| `401 unauthorized`                         | falta `OZ_MCP_TOKEN` o difiere                         | exportá el token correcto en el cliente                                 |
| Bridge errors en Claude Code               | path al bridge.js incorrecto                           | edita `args[0]` del JSON config                                         |
| `tools/list` devuelve []                   | server no terminó de arrancar                          | retry con backoff de 500ms                                              |
| Claude.ai chat se rompe al conectar OZ     | regresión del sanitizer del server (v1.9.2 o anterior) | actualizar a v1.9.3+ — el server ahora sanitiza nombres en `tools/list` |
| `Unknown tool: oz.X.Y` desde cliente nuevo | cliente usa dot form contra server muy viejo           | usar underscore form (`oz_X_Y`) o actualizar OZ a v1.9.3+               |

## Referencias

- [ADR 0012](../architecture/0012-oz-mcp-server.md)
- [`../modules/mcp-server.md`](../modules/mcp-server.md)
- [`../modules/mcp-tools.md`](../modules/mcp-tools.md)
- Especificación MCP oficial: https://spec.modelcontextprotocol.io/
