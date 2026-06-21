# Módulo `scrape-orchestrator`

**Path:** `browser/scrape-orchestrator.js`
**Líneas:** ~187
**Bloque:** V3-D scraping / agent-control

## Qué hace

Orquestador de scrape paralelo: ata las piezas de V3-D para correr un crawl/scrape con N workers a la vez. Cada loop saca una tarea del `CrawlFrontier`, espera el slot del dominio (`DomainRateLimiter`), corre el `worker(task, ctx)` inyectado, y según el resultado hace `markDone` (+ encola links descubiertos) o `markFailed` (re-encola si retryable). Termina cuando el frontier se vacía sin workers en vuelo, al llegar a `maxPages`, o si `signal` aborta.

## Exporta / API

| Export                | Descripción                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| `runScrapeJob(args)`  | Corre el job paralelo; devuelve `{ processed, ok, failed, results, stats, aborted }`. |
| `DEFAULT_CONCURRENCY` | Concurrencia por defecto (3).                                                         |

`args`: `{ frontier, worker, rateLimiter?, concurrency?, clock?, signal?, maxPages?, followLinks?, onProgress? }`.

## IPC / MCP

No registra IPC directamente (lógica pura). El adapter Electron (worker real con identity + page-handlers) es un glue aparte (`scrape-worker.js` / `scrape-handlers.js`) que requiere smoke en vivo.

## Gotchas

- No lanza: los errores de cada URL se agregan al frontier (failed) y al `results`.
- `worker`, `clock`, `frontier` y `rateLimiter` se inyectan → testeable sin Electron (fakes en tests).
- Si la cola está vacía pero hay workers activos, el loop cede el control (`_tick` = `setTimeout(0)`) y reintenta — soporta links descubiertos mid-crawl.
- Un worker que lanza excepción se trata como `{ ok:false, retryable:true }`.
- ADR 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).
