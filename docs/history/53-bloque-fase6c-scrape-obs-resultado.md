# Bloque Fase 6c alpha.111 — Observabilidad de scraping (V3-E) — Resultado

**Fecha:** 2026-07-16 · **Release:** v2.0.0-alpha.111 · **ADR:** 0042

## Qué se entregó

Cierra "6c V3-E observabilidad (NO existe)" del plan de Fase 6.

- `browser/scrape-observer.js` — `ScrapeObserver` puro: consume los eventos `onProgress` de `runScrapeJob` y produce un reporte estructurado (cost tracker, byWorker/byDomain, timeline de screenshots, action log, errores). Caps 5000 acciones / 200 errores.
- `scrape-orchestrator.js` — `onProgress` enriquecido con `startedAt/endedAt/durationMs/bytes/screenshot/error/depth` (todos opcionales → compat hacia atrás; helper `_resBytes`).
- `scrape-handlers.run` — crea el observer, lo alimenta, adjunta `report` al summary, cachea `browser._lastScrapeReport`. Acepta `jobId` opcional.
- MCP `oz.scrape.lastReport` (registrado `oz_scrape_lastReport`, 20 chars) devuelve el último reporte.

## Qué quedó funcionando

- Tests +23 (`scrape-observer.smoketest.js`: observer aislado con reloj inyectado + integración real con `runScrapeJob`). scrape-orchestrator 10/10 sin cambios. mcp-server 155/155 (nombre nuevo ≤21 OK). check:loc verde (477 files).
- Solo main process (WebUI manifest sigue 2.0.64).

## Pendiente de Fase 6

- **6b** — worker real de scraping headless end-to-end (V3-D adapter) + smokes Electron. El observer ya está listo para instrumentarlo.
- **Fase 7** — bandwidth meter real del proxy (el observer ya mide bytes de respuesta a nivel worker; falta el meter a nivel de sesión/proxy).
- Smoke en vivo Jose: correr `oz.scrape.run` sobre una identity y leer `oz.scrape.lastReport`.
