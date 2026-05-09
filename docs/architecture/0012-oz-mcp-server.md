# ADR 0012 — OZ MCP server (automation + validation API)

**Estado:** Aceptado (2026-05-09 — Jose subió la prioridad a "primera cosa post-1.2")
**Fecha:** 2026-05-09
**Pedido por:** Jose (durante smoke test visual del Bloque 1.2)
**Bloque target:** 1.3-MCP (entra ANTES del Workspace Manager) — re-priorizado tras los bugs encontrados en el smoke test visual del 1.2 que un MCP habría detectado en minutos en lugar de horas

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

### Tools mínimos (v1)

| Tool | Descripción |
|---|---|
| `oz.identities.list` / `get` / `create` / `update` / `remove` | CRUD de identities. Mismo shape que el preload bridge actual. |
| `oz.workspaces.*` | (Bloque 1.3) CRUD de workspaces. |
| `oz.tabs.list` / `openInIdentity` / `select` / `close` | Tab management. |
| `oz.tabs.navigate(tabId, url)` | Programmatic navigation. |
| `oz.tabs.getURL(tabId)` / `getTitle` / `getCookies` | Read state. |
| `oz.tabs.executeJS(tabId, script)` | Inyectar JS arbitrario en el tab — equivalente a CDP `Runtime.evaluate`. Devuelve serializable result. |
| `oz.tabs.getDOMSnapshot(tabId)` | HTML serializado del documento. Útil para validación. |
| `oz.tabs.screenshot(tabId)` | PNG bytes del view del tab. |
| `oz.tabs.waitForSelector(tabId, selector, timeout)` | Bloqueante hasta que matches o timeout. |
| `oz.proxies.*` | (Bloque 1.4) CRUD de proxies. |
| `oz.vault.*` | (Bloque 1.5) Account vault read/write con auth. |
| `oz.events.subscribe(channelGlob)` | Stream de events del main (tab created, navigated, identity changed, etc.). |

### Transport

Opciones (no excluyentes):
- **stdio:** spawneable como child process. Claude Code y otros agentes consumen así.
- **HTTP/JSON-RPC en localhost:** Web-friendly, más fácil para testing manual con curl.
- **WebSocket localhost:** para clientes que quieran event streams en tiempo real.

V1: stdio + HTTP localhost. WebSocket en v2.

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
