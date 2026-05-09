# ADR 0012 — OZ MCP server (automation + validation API)

**Estado:** Aceptado (2026-05-09 — Jose subió la prioridad a "primera cosa post-1.2"; **scope v1 expandido 2026-05-09 noche** con `events.subscribe`, `system.getMetrics`, contract test IPC↔MCP)
**Fecha:** 2026-05-09
**Pedido por:** Jose (durante smoke test visual del Bloque 1.2)
**Bloque target:** 1.3-MCP (entra ANTES del Workspace Manager) — re-priorizado tras los bugs encontrados en el smoke test visual del 1.2 que un MCP habría detectado en minutos en lugar de horas

## Update 2026-05-09 noche bis — pivote SDK → hand-rolled

Durante la implementación inicial el sandbox de Cowork agotó disco intentando instalar `@modelcontextprotocol/sdk` (ENOSPC: trae `hono` + `zod` + transitive ≈ 200 MB). Pivot decidido por Jose: **hand-rolled JSON-RPC 2.0 dentro de `browser/mcp-server.js` (~150 LOC).** Cero deps nuevas, cero peso extra en el bundle de Electron, mismo wire protocol que cualquier cliente MCP estándar.

**Consecuencia práctica:**

- El server expone los métodos MCP estándar (`initialize`, `tools/list`, `tools/call`, `notifications/initialized`) sobre HTTP localhost (POST `/mcp` con JSON-RPC en body).
- SSE se implementa con `Content-Type: text/event-stream` directo, sin transport del SDK.
- Schemas JSON inline en `mcp-tools.js` (en vez de zod). Más feo pero suficiente para tools sencillos.
- Migración a SDK queda como **sub-bloque opcional** si en el futuro necesitamos features avanzadas (batching, structured logging del SDK, validation con zod). No bloquea nada.

**Lo que NO cambia:**

- El catálogo de tools v1 sigue igual.
- `tools/mcp-stdio-bridge.js` sigue igual (es un proxy genérico, no depende del SDK).
- La compatibilidad con Claude Code / Cursor / clientes MCP est siegue idéntica — usan el wire protocol, no el SDK específico.

## Update 2026-05-09 noche — scope v1 expandido

Durante la pasada estructural pre-implementación, agregamos al scope v1 tres items que el ADR original difería pero que son casi gratis encima del MCP server y desbloquean valor en bloques siguientes:

- **`oz.events.subscribe`** — Server-Sent Events para tab-created/identity-changed/etc. Permite **smoke tests reactivos** en bloques siguientes (en vez de poll loops). +1-2h, ahorra ~30 min en cada bloque.
- **`oz.system.getMetrics`** — devuelve `{ memoryMB, cpuPercent, identitiesCount, tabsLazy, tabsMaterialized, uptimeSec }`. Es el **embrión de `BENCHMARKS.md`** (regla viva del plan): cada release medimos vía este tool y archivamos. +30 min.
- **Contract test IPC↔MCP** — un test que valida que para cada `ipcMain.handle('oz:X')` whitelisted hay un tool MCP `oz.X` correspondiente (o explicitly exempt). Previene que agreguemos features y nos olvidemos del MCP. +1h.

Decisión también de **transports v1**: HTTP localhost (StreamableHTTPServerTransport) primario, con `tools/mcp-stdio-bridge.js` standalone Node script para clientes que esperan stdio (Claude Code/Cursor). Stdio puro embebido en Electron no es viable (process.stdin/stdout de Electron está ocupado por el binary). El bridge hace stdio → HTTP forward.

## Contexto

Durante el smoke test visual del Bloque 1.2, Claude tuvo que controlar OZ Browser via macOS computer-use (clicks de pixel, screenshots, OCR). Eso funciona pero es lento, frágil (window focus se pierde, clicks caen fuera, coordenadas cambian si la ventana se mueve), y consume mucho contexto.

Más allá de testing por Claude: el plan ya tiene como diferenciador #9 **CDP automation API para Puppeteer/Playwright** (ver `OVERVIEW.md` "moat real vs Ghost"). Ghost no expone automation API; nosotros sí queremos.

Un servidor MCP propio en OZ Browser cumple dos propósitos a la vez:

1. **Reemplaza computer-use para validación programática.** Claude/agentes pueden hablar directamente con el main process: crear identities, navegar tabs, leer cookies, leer DOM, ejecutar JS en cualquier tab, sin tocar el cursor.
2. **Es la automation API user-facing** que diferencia OZ de Ghost. SDK público para que clientes integren OZ con sus pipelines (scraping, login automatizado, multi-cuenta, etc.).

## Decisión

**Implementar un servidor MCP embebido en el main process de OZ Browser** que expone las primitivas core como tools MCP. Discoverable via:

- Settings → Automation → Enable MCP server (off por default).
- Configurable: localhost-only / unix socket / TCP, opcional bearer token.

### Tools v1 (esta sesión, Bloque 1.3-MCP — scope final post-update)

| Tool                                                                                      | Descripción                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oz.identities.list` / `get` / `getActive` / `setActive` / `create` / `update` / `remove` | CRUD de identities. Mismo shape que el preload bridge actual.                                                                                                                                 |
| `oz.tabs.list` / `openInIdentity` / `select` / `close`                                    | Tab management básico.                                                                                                                                                                        |
| `oz.events.subscribe(channelGlob)`                                                        | **Server-Sent Events** del main (tab-created/updated/removed/selected, identity-changed). Cliente abre una sola connection y recibe eventos hasta que cierra. Habilita smoke tests reactivos. |
| `oz.system.getMetrics`                                                                    | `{ memoryMB, cpuPercent, identitiesCount, tabsLazy, tabsMaterialized, uptimeSec, ozVersion }`. Para `BENCHMARKS.md` automatizado.                                                             |

### Tools v2 (entran en bloques siguientes con su feature)

| Tool                                                        | Bloque                                   |
| ----------------------------------------------------------- | ---------------------------------------- |
| `oz.workspaces.*`                                           | 1.4-WS                                   |
| `oz.proxies.*`                                              | 1.8                                      |
| `oz.vault.*` (con auth) y `oz.accounts.*`                   | 1.5                                      |
| `oz.tabs.navigate` / `getURL` / `getTitle` / `getCookies`   | 1.5 (necesario para anti-logout testing) |
| `oz.tabs.executeJS(tabId, script)`                          | 1.5 (necesario para auto-fill testing)   |
| `oz.tabs.getDOMSnapshot` / `screenshot` / `waitForSelector` | 1.7 (tab context menu validation)        |
| `oz.fingerprint.*`                                          | 1.9                                      |

### Transport

Decisión final v1:

- **HTTP localhost** primario (StreamableHTTPServerTransport del SDK oficial), default port 9223. Embebido en main process.
- **stdio bridge** (`tools/mcp-stdio-bridge.js`) standalone Node script que Claude Code/Cursor pueden spawnear. Lee stdin, forwardea a localhost:9223, escribe respuestas a stdout. Permite que clientes MCP estándar conecten al OZ Browser corriendo sin tener que abrir HTTP.
- **SSE** (Server-Sent Events) sobre el mismo HTTP server para `oz.events.subscribe` — un endpoint adicional, no requiere transport separado.
- **WebSocket** difetrido a v2 si hace falta.

**Por qué no stdio puro embebido:** Electron's main process tiene `process.stdin/stdout` ocupados por el runtime del binary; no se puede usar como MCP transport sin romper IPC interno. El bridge resuelve esto sin esfuerzo.

### Auth

- Default: localhost-only, sin auth (igual que CDP de Chrome devtools).
- Opcional: bearer token con setting habilitable, requerido para conexiones non-loopback.
- Por seguridad: jamás expuesto a `0.0.0.0` por default. Settings warning si el usuario lo intenta.

## Alternativas consideradas

- **Solo CDP:** Chrome DevTools Protocol exposed via `--remote-debugging-port`. Funciona, pero es genérico de Chromium y NO conoce nuestras primitivas (Identity, Workspace, Vault). El usuario tendría que orquestar a mano. MCP propio + CDP debajo es mejor.
- **Selenium / WebDriver:** estándar pero más pesado, otro daemon, peor DX que MCP/CDP.
- **REST plano sin MCP:** funcional pero no aprovecha el ecosistema MCP de Claude Desktop, Cursor, etc. MCP es estrictamente más útil dado el target de usuarios (heavy Claude users).
- **Puppeteer/Playwright direct:** son consumers, no providers. Nosotros somos el provider.

## Consecuencias

- ✅ Validación programática — Claude reemplaza smoke tests visuales por tool calls. Bloque 1.2 hubiera sido testable en 5 min (vs ~30 min con computer-use).
- ✅ Diferenciador real vs Ghost (que no tiene automation API).
- ✅ Habilita SDKs en Python/JS para clientes empresariales (Bloque 1.10+).
- ✅ Reusa preload bridge — mismas IPC handlers, solo nueva capa transport.
- ⚠️ Surface de seguridad nueva: cualquier proceso local podría hablar con el server si no hay auth. Mitigación: off por default, auth opcional, localhost only.
- ⚠️ Effort estimado: ~12-16 horas (server transport + tool catalog completo + tests + docs). Ubicar en Etapa 2 después de MVP usable.
- ⚠️ Mantener feature parity con preload bridge: cada nuevo IPC channel debe exponerse también via MCP. Convención: handler de IPC y tool de MCP comparten implementación común en `browser/<domain>-handlers.js`.

## Plan de implementación (cuando se ejecute)

1. Crear `browser/mcp-server.js` (server transport + dispatch).
2. Refactor: extraer cada `register*Handlers` (en `ipc-handlers.js`) para que devuelvan un mapa `name → fn`. El IPC y el MCP layers consumen ese mapa.
3. Tool catalog inicial: `identities.*` y `tabs.*` (suficiente para automation básica + smoke tests).
4. Settings UI toggle "Enable MCP server (advanced)" en Bloque 1.7.
5. Doc usuario: `docs/guides/mcp-automation.md` con quickstart Python + Node.
6. Marketing: feature highlighted en `oz-marketing/` landing (Etapa 6).

## Beneficio inmediato para desarrollo

Una vez implementado, las **futuras validaciones de bloque** las hace Claude vía MCP en lugar de computer-use:

- Crear N identities, validar shape JSON.
- Navegar tab a URL X, leer cookies, validar persistencia.
- Ejecutar `Object.keys(localStorage)` en tab para validar storage isolation.
- Capturar screenshot de un tab específico, comparar con snapshot esperado.

Eso convierte el smoke test del Bloque 1.X en un script reproducible, no en una sesión interactiva con clicks.

## Referencias

- Diferenciador #9 en `OVERVIEW.md` y `PLAN-MAESTRO.md`.
- Plan ahora cita esto como puente hacia Etapa 2 / Bloque 1.10.
- Inspiraciones: Playwright MCP, Chrome DevTools Protocol, Puppeteer.
