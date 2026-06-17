# ADR 0036 — Page-control layer (v3-A scraping/agent-control)

**Date:** 2026-06-17
**Status:** Accepted (primer slice)
**Predecesores:** ADR 0012 (MCP server interno), ADR 0005 (modular 500 LOC)
**Plan:** `docs/PLAN-V3-SCRAPING.md` §V3-A

## Contexto

v3 convierte OZ en un browser agent-controlled para scraping. El primer ladrillo (V3-A) es darle al agente (Claude/Cursor vía MCP) control de la página: navegar, leer el DOM y evaluar JS, todo scopeado a la tab de una identity concreta (con su fingerprint + proxy + cookies persistentes). Hasta hoy el MCP exponía identities/tabs/proxies/etc. pero **ningún** control de página (`oz.page.*` no existía).

## Decisiones

### D1 — Capa nueva, cero rearquitectura del MCP

`mcp-tools-page.js` (catálogo) + `page-handlers.js` (boundary DOM/Electron) + `page-utils.js` (helpers puros). Se spreadea en el catálogo existente (`mcp-tools.js`) igual que bulk/fingerprint/etc. No se toca el server MCP.

### D2 — Self-contained handlers (no `browser.handlers.page`)

`ipc-handlers.js` está clavado en el cap de 500 LOC, así que **no** se agrega `browser.handlers.page` ahí. `buildPageTools(browser)` construye su propia instancia de `buildPageHandlers(browser)` y la cierra sobre los tools. Las tools son MCP-only (no necesitan canal IPC para la UI), así que esto es suficiente y evita tocar archivos al límite.

### D3 — Resolución identity→tab→webContents

`resolveTab(identityId, tabId)`: por `tabId` explícito (en cualquier ventana) o, sin él, la primera tab de la identity. Si la tab es lazy se materializa (`tab.materialize()`) antes de ejecutar. `navigate` crea una tab en la ventana enfocada si la identity no tiene ninguna.

### D4 — Inyección segura

Los selectores/atributos se embeben con `JSON.stringify` en los snippets de `executeJavaScript`, así un valor hostil (`a"]; doEvil()`) queda como string literal, nunca como código. Los builders son puros y unit-testeados.

### D5 — `oz.page.eval` como escape hatch

Se expone `eval` (ejecuta JS arbitrario en la página y devuelve el valor) a propósito: es la herramienta del agente para extracción que las tools declarativas no cubren. El MCP server ya corre con `OZ_MCP_ENABLED=1` y es de uso local/confiable; no es superficie pública (eso se reevalúa en el SaaS, v3-real).

### D6 — Nombres ≤21 chars

`oz.page.navigate/getInfo/getText/getAttr/queryAll/eval` → sanitizados `oz_page_*` ≤21 (guard de `mcp-server.smoketest.js`). Se evita `querySelectorAll` (24) usando `queryAll`.

## Alcance

- **Slice 1 (alpha.48):** `navigate`, `getInfo`, `getText`, `getAttr`, `queryAll`, `eval`.
- **Slice 2 (alpha.49):** `click` (sendInputEvent real, no `.click()` sintético), `type` (char-by-char + `delayVarianceMs`), `scroll` (top/bottom/px), `waitFor` (poll selector + timeout), `screenshot` (`capturePage`→base64), `extract` (schema declarativo). Helper `resolveWC` compartido.

**Pendiente (próximos sub-bloques):** `oz.network.intercept`. Luego V3-B (humanization: Bézier + delays gaussianos), V3-C (stealth), V3-D (orquestación + headless), V3-E (observabilidad), V3-F (cookie import general).

## Tests

`tests/page-utils.smoketest.js` cubre los builders puros + validadores + seguridad de inyección. La ejecución DOM (executeJavaScript) se valida en smoke real contra una página local en sub-bloques siguientes.

## Trade-offs

- `eval` es poderoso; aceptable en MCP local, a reconsiderar en superficie SaaS pública.
- Sin input-events todavía: este slice lee/navega/evalúa pero no clickea como humano (eso es V3-A.2 + V3-B).
