# Bloque alpha.112 — Módulo de diagnóstico total (oz.diag.\*) — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.112 · **ADR:** 0043

## Qué se entregó

Idea de Jose: "deberíamos tener un módulo para que [Claude] pueda siempre revisar todo... hasta con pantallazos y análisis de esas imágenes... que puedas hasta analizar este mismo módulo tú mismo."

Subsistema `oz.diag.*` MCP-first:

- `browser/system-diagnostics.js` (puro): `buildDiagnostics` (snapshot único: runtime, enforceProxy, identidades, salud de proxies, sesiones cacheadas, tabs por ventana, workspaces, sync, settings, último scrape, selfCheck + cola de log), `parseLogTail`/`readLogTail` (cola WARN/ERROR, solo últimos ~512KB), `summarizeProxies`, `selfCheck` (verifica managers/handlers + los propios exports → el diagnóstico se diagnostica).
- `browser/diagnostics-handlers.js` (Electron): `snapshot`, `logs`, `selfCheck`, `screenshot` (capturePage del chrome o de un tab → PNG en userData/diagnostics/, devuelve path para que el agente lo lea y lo analice con su visión).
- `browser/mcp-tools-diag.js`: 4 tools MCP (`oz_diag_snapshot`/`_logs`/`_selfCheck`/`_screenshot`, todos ≤21). Wired en mcp-tools-extra + handler `diag` en ipc-handlers.

## Qué quedó funcionando

- Tests +36 (`system-diagnostics.smoketest.js`, lógica pura con browser fake). mcp-server 155/155 (nombres nuevos OK). check:loc verde (481 files). Solo main process (WebUI manifest sigue 2.0.64).

## Pendiente

- **Smoke en vivo (Jose):** reiniciar OZ para que las tools aparezcan en el MCP server; después Claude puede llamar `oz.diag.snapshot`, `oz.diag.screenshot` (chrome + content) y leer los PNG. El screenshot no corre en sandbox/CI (capturePage requiere Electron).
- Idea futura: limpieza de PNG viejos en userData/diagnostics/; exponer diag en la UI (hoy es solo MCP).
- Sigue abierto: 6b (worker scraping real), Fase 7 (bandwidth meter), video posts.
