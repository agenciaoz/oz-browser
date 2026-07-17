# ADR 0042 — Observabilidad de scraping (V3-E)

**Date:** 2026-07-16
**Status:** Accepted
**Contexto:** El plan de Fase 6 marcaba "6c V3-E observabilidad (NO existe)". El orquestador de scraping (`scrape-orchestrator.js`, V3-D) corría N workers en paralelo pero solo devolvía un resumen plano `{processed, ok, failed, results, stats}` — sin visibilidad de dónde se gasta el tiempo, qué dominios fallan, cuánto se descargó, ni un rastro de screenshots. Sin eso, un crawl que anda mal es una caja negra.

## Decisión

Un observador puro (`scrape-observer.js`, `ScrapeObserver`) que consume los eventos `onProgress` del orquestador (uno por URL) y arma un reporte estructurado. No toca Electron: el reloj se inyecta y solo procesa los eventos que le pasan → testeable determinista (ADR 0005).

**Enriquecimiento del orquestador:** `onProgress` ahora emite, además de `{url, ok, workerId, stats}`, los campos `startedAt/endedAt/durationMs`, `bytes` (de `res.bytes` o el tamaño serializado de `res.data`), `screenshot` (si el worker lo reporta), `error` y `depth`. Todos opcionales — consumidores viejos no rompen.

**El reporte** (`observer.report()`):

- `cost`: pages, ok, failed, successRate, bytes, avgPageMs, pagesPerMin (throughput sobre wall-clock).
- `byWorker[]` y `byDomain[]`: desglose con avgMs + successRate, ordenado por páginas.
- `timeline[]`: solo eventos con screenshot (para reconstruir visualmente el crawl).
- `errors[]`: URLs fallidas con su motivo (capado a 200).
- `actionLog[]`: rastro completo por URL (capado a 5000 — jobs enormes no explotan memoria).

**Wiring:** `scrape-handlers.run` crea el observer, lo alimenta vía `onProgress`, adjunta `report` al summary y lo cachea en `browser._lastScrapeReport`. Nuevo MCP `oz.scrape.lastReport` (registrado `oz_scrape_lastReport`, 20 chars ≤ 21) lo devuelve — así el agente puede preguntar "¿cómo fue el último crawl / dónde gastó tiempo / qué falló?" sin re-correrlo.

## Alternativas consideradas

- **Meter la observabilidad dentro del orquestador** — rechazada: mezcla la mecánica del crawl con la contabilidad; separado, el observer se testea solo y el orquestador queda limpio.
- **Persistir cada job a disco** — pospuesto: por ahora se cachea el último en memoria (suficiente para el flujo agent-driven). Persistencia multi-job es trabajo futuro si se necesita histórico.
- **Screenshots automáticos por página** — no forzado: el observer registra el `screenshot` que el worker/recipe ya produce (evidencia opt-in), sin imponer el costo de capturar en cada página.

## Consecuencias

- Un scrape job deja de ser una caja negra: cost tracker + desglose por worker/dominio + timeline + action log.
- Costo de memoria acotado por los caps (5000 acciones / 200 errores).
- Falta smoke en vivo (Electron): correr `oz.scrape.run` real y leer `oz.scrape.lastReport`. El worker real (V3-D adapter) sigue pendiente de smoke aparte.
- Tests: `tests/scrape-observer.smoketest.js` (23, incluye integración con `runScrapeJob`).

Ver: `docs/modules/scrape-observer.md`, `scrape-orchestrator.js`, ADR 0030 (bulk-runner), 0036 (page-control).
