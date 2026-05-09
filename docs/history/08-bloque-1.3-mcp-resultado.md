# Bloque 1.3-MCP — Resultado: ✅ OZ MCP server (automation API)

**Fecha de cierre:** 2026-05-09 (cerrado en sesión continuada después del 1.2)
**Sesiones acumuladas:** 1 sesión larga (refactor + impl + tests + docs en una pasada)
**Estado anterior:** 1.2 cerrado, 1.3-MCP propuesto y aceptado en ADR 0012.

---

## Lo que entregamos en este bloque

### 1. Pasada estructural pre-implementación (lo primero)

Antes de tocar código MCP, hicimos una pasada de orden estructural sobre el repo entero:

- **PLAN-MAESTRO.md → v5** consolidado (única fuente de verdad). El de la raíz `Projects/.../07-PLAN-MAESTRO-V2.md` quedó deprecado con redirect.
- **Sub-bloques nuevos** insertados en el plan: 1.3-MCP (este), 1.3.5-CI (~3h), 1.3.6-DX (~2h). Renumeración del resto: 1.4-WS Workspace, 1.5 ⭐Vault, 1.6 Time Machine, 1.7 Tab Context Menu, 1.8 Proxies, 1.9 Fingerprint, 1.10 Settings + Polish.
- **Candidatos C-11..C-15** anotados en Etapa 2: headless mode, Ghost importer, demo mode, MCP recipes, health endpoint.
- **Tooling agregado:** `scripts/check-loc.js` (automatiza ADR 0005), `scripts/safe-test.sh`, `BENCHMARKS.md`, `CHANGELOG.md`, `docs/processes/CHECKLIST-CIERRE-BLOQUE.md`, `docs/processes/code-review-checklist.md`. npm scripts: `test`, `test:safe`, `check:loc`, `check:loc:verbose`, `lint` (placeholder).
- **2 ADRs nuevos:** 0013 (CI strategy con GitHub Actions), 0014 (ESLint flat config + Prettier + Husky pre-commit).
- **Drift cerrado:** docs/modules/ui-webui.md y ui-oz-utils.md creados (faltaban). README de modules y architecture actualizados.

### 2. Refactor: extraer handler maps puros

El IPC handler de identities y tabs de `ipc-handlers.js` se extrajo a archivos propios que exportan mapas `{name → fn}` consumibles por dos transports (IPC y MCP).

- **`browser/identity-handlers.js`** — `buildIdentityHandlers(browser)` retorna 9 handlers (list, get, getActive, setActive, create, rename, setColor, update, remove).
- **`browser/tab-handlers.js`** — `buildTabHandlers(browser)` retorna 6 handlers (list, getIdentity, openInIdentity, select, close, bulkCreateLazy).
- **`ipc-handlers.js` refactor** — ahora consume los maps via `browser.handlers.{identities,tabs}` y se queda fino. Misma API IPC, misma semántica, sin duplicación.

Validado: 28/28 tests originales siguen verdes. `check:loc` verde (max 301 LOC en sidebar.js).

### 3. ADR 0012 update — pivote SDK → hand-rolled

Durante la implementación, el sandbox de Cowork agotó disco intentando instalar `@modelcontextprotocol/sdk` (ENOSPC: trae hono + zod + transitive ≈ 200 MB). Decisión confirmada por Jose: **hand-rolled JSON-RPC 2.0** (~150 LOC) en vez de SDK.

Consecuencias:

- Cero deps nuevas → cero peso extra en bundle Electron.
- Wire protocol idéntico al estándar MCP, compatible con cualquier cliente.
- JSON Schema inline en tools (no zod) — más feo pero estándar y suficiente.
- Migración a SDK en el futuro queda como sub-bloque opcional, no bloqueante.

### 4. MCP Server core — `browser/mcp-server.js` (250 LOC)

Server MCP embebido en el main process. Off por default; on con `OZ_MCP_ENABLED=1`.

**Endpoints HTTP:**

- `GET /health` — sanity + métricas
- `POST /mcp` — JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`, batch)
- `GET /mcp/events` — Server-Sent Events stream con filtros `?channels=tabs.*,identities.*`
- CORS preflight para loopback

**Auth:**

- Default localhost-only (binds 127.0.0.1, nunca 0.0.0.0).
- Bearer token opcional via `OZ_MCP_TOKEN`.

**SSE wiring:** monkey-patch a `browser.broadcastToWebUI` para fan-out a clientes SSE en paralelo al broadcast IPC original. Restaurado al `stop()`.

**Errores estándar JSON-RPC:** -32700 (parse), -32600 (invalid), -32601 (method not found), -32000 (internal).

### 5. Tool catalog v1 — `browser/mcp-tools.js` (184 LOC)

13 tools:

- `oz.identities.*` (7): list, get, getActive, setActive, create, update, remove
- `oz.tabs.*` (4): list, openInIdentity, select, close
- `oz.system.getMetrics` (1): memoryMB, heapMB, cpuPercentCumulative, identitiesCount, tabsLazy/Materialized, windowsCount, uptimeSec, ozVersion
- `oz.events.subscribe` (1): redirige al endpoint SSE

Cada tool con JSON Schema inline (`additionalProperties: false`), descripción explicando edge cases (cap free, errores estructurados), y `call(args)` que invoca el handler correspondiente.

### 6. Stdio bridge — `tools/mcp-stdio-bridge.js`

Standalone Node script (sin Electron) que Claude Code/Cursor pueden spawnear. Lee JSON-RPC del stdin (linebreak-delimited), forwardea a localhost:9223/mcp, escribe respuestas a stdout. Permite que clientes MCP convencionales conecten al OZ Browser corriendo como si fuera stdio nativo.

Variables de entorno: `OZ_MCP_URL` (default `http://localhost:9223`), `OZ_MCP_TOKEN`.

### 7. Wire en main.js

`Browser.init()` crea + arranca `MCPServer` después de la primera ventana, gated por `OZ_MCP_ENABLED`. `before-quit` y `destroy` cierran graceful (cierra SSE clients, restaura broadcast monkey-patch, await server.close).

### 8. Smoke test — `tests/mcp-server.smoketest.js`

**57/57 assertions verde.** Cubre:

- Boot, health
- JSON-RPC initialize, tools/list, tools/call (oz.identities.list, create, system.getMetrics)
- Errores: tool desconocido (-32601), método desconocido, parse error (-32700)
- Notification (sin id) → no response body
- Bearer token (sin → 401, con correcto → 200, con erróneo → 401)
- SSE: hello event al conectar, tabs.updated event al broadcast
- **Contract test IPC↔MCP:** valida que cada `oz:identities:*` y `oz:tabs:*` channel del preload tiene su tool MCP correspondiente (con exempt list documentada).

Ejecuta Node-puro con mock-Electron, no requiere GUI.

### 9. Docs

- `docs/modules/mcp-server.md`, `mcp-tools.md`, `identity-handlers.md`, `tab-handlers.md` (4 nuevos).
- `docs/modules/ipc-handlers.md` actualizado para reflejar el refactor.
- `docs/guides/mcp-automation.md` — guía completa de uso (curl, Claude Code, Cursor, Python, Node, eventos SSE, troubleshooting).
- `docs/architecture/0012-oz-mcp-server.md` — 2 updates: scope v1 expandido (events.subscribe + getMetrics + contract test) y pivote SDK→hand-rolled.
- `docs/architecture/0008-account-vault-encryption.md` — actualizado durante review de deps: `@napi-rs/keyring` reemplaza `keytar` (archivado), `exceljs` reemplaza `xlsx` (CVEs sin patch), `otplib` reemplaza `speakeasy` (abandoned), KDF versionado para migration future a argon2id, snippet de referencia para AES-GCM authTag manual.
- `docs/PLAN-MAESTRO.md` actualizado: Etapa 3 corregida (Forge no Builder → `update-electron-app`), Etapa 4 con deep link OAuth, Etapa 5 con Stripe checkout en BrowserWindow externa, Etapa 7-OFFICE con Dropbox PKCE.

---

## Estado final del repo

```
browser/
├─ identity-handlers.js   ✅ NEW (95 LOC)
├─ tab-handlers.js        ✅ NEW (85 LOC)
├─ mcp-server.js          ✅ NEW (250 LOC)
├─ mcp-tools.js           ✅ NEW (184 LOC)
├─ ipc-handlers.js        ✅ refactored (250 LOC, antes 250)
├─ main.js                ✅ +20 LOC (wire mcp-server)
└─ … (resto sin cambios)

tools/
└─ mcp-stdio-bridge.js    ✅ NEW (85 LOC)

scripts/
├─ check-loc.js           ✅ NEW (estructural)
└─ safe-test.sh           ✅ NEW (estructural)

tests/
├─ identity-manager.smoketest.js   ✅ 28/28 (sin cambios)
└─ mcp-server.smoketest.js          ✅ NEW, 57/57

docs/
├─ PLAN-MAESTRO.md        ✅ v5 (estructural + correcciones de review)
├─ OVERVIEW.md            ✅ updated
├─ BENCHMARKS.md          ✅ NEW (estructural)
├─ CHANGELOG.md           ✅ NEW (estructural)
├─ architecture/
│  ├─ 0012-oz-mcp-server.md          ✅ updated 3x
│  ├─ 0013-ci-strategy.md            ✅ NEW (estructural)
│  ├─ 0014-lint-precommit.md         ✅ NEW (estructural, flat config)
│  └─ 0008-account-vault-encryption.md ✅ updated (deps audit + KDF version)
├─ modules/
│  ├─ mcp-server.md                  ✅ NEW
│  ├─ mcp-tools.md                   ✅ NEW
│  ├─ identity-handlers.md           ✅ NEW
│  ├─ tab-handlers.md                ✅ NEW
│  ├─ ipc-handlers.md                ✅ refactored
│  ├─ ui-webui.md                    ✅ NEW (estructural)
│  └─ ui-oz-utils.md                 ✅ NEW (estructural)
├─ guides/
│  ├─ mcp-automation.md              ✅ NEW
│  └─ dev-setup.md                   ✅ updated
└─ processes/
   ├─ CHECKLIST-CIERRE-BLOQUE.md     ✅ NEW (estructural)
   └─ code-review-checklist.md       ✅ NEW (estructural)

CHANGELOG.md (root)                  ✅ NEW
07-PLAN-MAESTRO-V2.md (raíz Projects) ✅ marcado DEPRECADO
```

---

## Pendientes que se reasignan

**No hay pendientes del bloque 1.3-MCP.** Todo el scope v1 entregado.

Pendientes que entran en 1.4-WS y siguientes (no son tech debt, son features futuras):

- Tools MCP `oz.workspaces.*` → 1.4-WS al cerrar
- Tools MCP `oz.tabs.navigate/getURL/getCookies/executeJS/getDOMSnapshot/screenshot/waitForSelector` → 1.5 (necesarios para Vault)
- Tools MCP `oz.proxies.*` → 1.8
- Tools MCP `oz.vault.*` y `oz.accounts.*` → 1.5
- Tools MCP `oz.fingerprint.*` → 1.9
- Settings UI toggle "Enable MCP server (advanced)" → 1.10

---

## Costos del bloque

- **Tiempo:** ~10 horas (pasada estructural ~3h + refactor ~1h + impl MCP ~3h + tests ~2h + docs ~1h). Estimado original 12-16h — quedó adentro.
- **Apple Developer:** $0 (todavía no aplica).
- **Dependencias npm nuevas:** **0** (decision pivot a hand-rolled).
- **GitHub:** $0 (free tier privado).
- **Total acumulado del proyecto:** **$0** (Etapa 0 + 1.1 + 1.2 + 1.3-MCP).

---

## Comandos para retomar / probar

```bash
cd "/Users/joserodrigocoronel/Documents/Claude/Projects/Ghost Browser Clone/oz-browser"

# Tests
npm test                       # 28+57 = 85 assertions, todas verdes
node scripts/check-loc.js      # max LOC actual: 329 (mcp-server smoke test)

# Probar MCP server con OZ corriendo
OZ_MCP_ENABLED=1 NODE_ENV= npm start

# En otra terminal:
curl http://localhost:9223/health
curl -X POST http://localhost:9223/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Stream de eventos
curl -N http://localhost:9223/mcp/events
```

---

## Próximo paso concreto

**Bloque 1.3.5-CI** (~3h, ADR 0013):

- `.github/workflows/ci.yml` con `npm test` + `check:loc` + `lint` (placeholder por ahora)
- Status badge en README
- Cron nightly job
- Push a una branch de prueba para validar verde

Después: **1.3.6-DX** (~2h, ADR 0014) — ESLint flat config + Prettier + Husky pre-commit + lint-staged. Aquí entra el primer `npm install` real (te paso el comando para que lo corras vos).

Después: **Bloque 1.4-WS — Workspace Manager**.

---

## Referencias

- ADRs creados/actualizados en este bloque: [0008](../architecture/0008-account-vault-encryption.md) (update), [0012](../architecture/0012-oz-mcp-server.md) (3 updates), [0013](../architecture/0013-ci-strategy.md), [0014](../architecture/0014-lint-precommit.md).
- ADRs aplicables: 0002 (lazy tabs), 0003 (Default = defaultSession), 0005 (500 LOC, ahora automatizado por check-loc.js), 0009 (logging), 0011 (modals).
- Módulos creados: `identity-handlers.js`, `tab-handlers.js`, `mcp-server.js`, `mcp-tools.js`, `tools/mcp-stdio-bridge.js`.
- Módulos refactorizados: `ipc-handlers.js`, `main.js`.
- Smoke test: `tests/mcp-server.smoketest.js` (57/57).
- Guía de uso: [`../guides/mcp-automation.md`](../guides/mcp-automation.md).
