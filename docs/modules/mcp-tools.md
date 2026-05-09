# Módulo `mcp-tools`

**Path:** `browser/mcp-tools.js`
**Líneas:** ~184
**Bloque/Etapa:** 1.3-MCP

## Qué hace

Catálogo de tools que expone el MCP server (`mcp-server.js`). Cada tool tiene `name`, `description`, `inputSchema` (JSON Schema 2020-12 inline) y `call(args)` que invoca el handler correspondiente en `browser.handlers`.

## Exports

| Símbolo                     | Tipo     | Descripción                                                                                                                                                                          |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildToolCatalog(browser)` | function | Construye el array de tools v1. Llamado por `MCPServer.start()`.                                                                                                                     |
| `buildMetrics(browser)`     | function | Snapshot de runtime: memoryMB, heapMB, cpuPercentCumulative, identitiesCount, tabsLazy, tabsMaterialized, windowsCount, uptimeSec. Usado por `oz.system.getMetrics` y por `/health`. |

## Tools v1

| Tool                      | Args (resumen)                            | Returns                          | Handler                                          |
| ------------------------- | ----------------------------------------- | -------------------------------- | ------------------------------------------------ |
| `oz.identities.list`      | `{}`                                      | array de identities              | `identities.list()`                              |
| `oz.identities.get`       | `{id}`                                    | identity \| null                 | `identities.get(id)`                             |
| `oz.identities.getActive` | `{}`                                      | id string                        | `identities.getActive()`                         |
| `oz.identities.setActive` | `{id}`                                    | bool                             | `identities.setActive(id)`                       |
| `oz.identities.create`    | `{name?, color?, userAgent?}`             | identity \| `{__error}`          | `identities.create()`                            |
| `oz.identities.update`    | `{id, patch:{name?, color?, userAgent?}}` | identity \| null                 | `identities.update()`                            |
| `oz.identities.remove`    | `{id}`                                    | bool                             | `identities.remove()`                            |
| `oz.tabs.list`            | `{}`                                      | array de tabs                    | `tabs.list()`                                    |
| `oz.tabs.openInIdentity`  | `{identityId, url?}`                      | tabId \| null                    | `tabs.openInIdentity()`                          |
| `oz.tabs.select`          | `{tabId}`                                 | bool                             | `tabs.select()`                                  |
| `oz.tabs.close`           | `{tabId}`                                 | bool                             | `tabs.close()`                                   |
| `oz.system.getMetrics`    | `{}`                                      | metrics object                   | (inline)                                         |
| `oz.events.subscribe`     | `{channels?:[]}`                          | `{streaming, sseEndpoint, note}` | (inline — el stream real es por GET /mcp/events) |

## Cómo agregar una tool nueva

```js
{
  name: 'oz.<domain>.<action>',
  description: 'Frase clara para que un humano/LLM entienda qué hace.',
  inputSchema: {
    type: 'object',
    properties: { /* ... */ },
    required: [ /* ... */ ],
    additionalProperties: false,
  },
  call: (args) => browser.handlers.<domain>.<method>(args.x, args.y),
}
```

Reglas:

- `name` siempre comienza con `oz.<domain>.` para namespace.
- `description` debe explicar también side effects y edge cases (cap free, errores estructurados, etc.).
- `inputSchema` con `additionalProperties: false` (rechaza args desconocidos).
- `call()` retorna lo que sea — el server lo serializa a `result.content[0].text` (JSON.stringify) y `result._meta.value` (raw).

Cuando agregues una tool, **el contract test** (`tests/mcp-server.smoketest.js`) valida que para cada `ipcMain.handle('oz:X:Y')` whitelisted hay un tool `oz.X.Y`. Si no, agregalo a `exempt` con razón documentada o creá la tool.

## Decisiones no obvias

- **JSON Schema inline en vez de zod:** decisión del pivot del ADR 0012 (no agregar deps). `additionalProperties: false` es la máxima validación que aplicamos hoy. Para validation profunda, en el futuro podemos enchufar `ajv` opcional.
- **`oz.events.subscribe` no es un `tool/call` real:** retorna metadata indicando que el stream va por GET `/mcp/events`. Es así porque MCP estándar no tiene streaming primitive; SSE es nuestro adapter.
- **`oz.system.getMetrics` no usa handlers map:** es self-contained en `buildMetrics()`. Puede leer directamente `process.memoryUsage` y `browser.windows[].tabs.tabList`.
- **Identity cap:** `oz.identities.create` retorna `{__error: {code: "IDENTITY_CAP_REACHED", ...}}` (no throw). El cliente decide qué mostrar.

## Referencias

- [`mcp-server.md`](mcp-server.md) — el server que consume este catálogo.
- [`identity-handlers.md`](identity-handlers.md), [`tab-handlers.md`](tab-handlers.md) — los maps que las tools invocan.
- [ADR 0012](../architecture/0012-oz-mcp-server.md).
