# Module: ScrapeObserver (scrape-observer.js)

**Files:**

- `browser/scrape-observer.js` — class ScrapeObserver + domainOf helper (puro)
- `tests/scrape-observer.smoketest.js` — 23 assertions (aislado + integración)

**ADR:** [`0042-scrape-observability.md`](../architecture/0042-scrape-observability.md).

## Qué hace

Consume los eventos `onProgress` de `runScrapeJob` (uno por URL procesada) y arma un reporte estructurado del job de scraping: action log, timeline de screenshots y cost tracker. Es la pieza V3-E ("observabilidad") de Fase 6.

Puro (sin Electron): reloj inyectable (`now`), solo procesa eventos. El wiring a un job real vive en `scrape-handlers.js`.

## API

```js
const obs = new ScrapeObserver({ jobId, identityId, now })
obs.start()
obs.record(evt) // por cada onProgress: { url, ok, workerId, durationMs, bytes, screenshot, error, depth }
obs.finish(summary) // guarda el summary del orquestador y sella endedAt
const report = obs.report()
```

## Forma del reporte

```
{
  jobId, identityId, startedAt, endedAt, wallMs,
  cost: { pages, ok, failed, successRate, bytes, avgPageMs, pagesPerMin },
  byWorker: [{ key, pages, ok, failed, bytes, totalMs, avgMs, successRate }],
  byDomain: [{ key, ... }],
  timeline: [{ ts, url, screenshot }],   // solo eventos con screenshot
  errors:   [{ ts, url, error }],         // cap 200
  actionLog:[{ ts, url, domain, ok, workerId, durationMs, bytes, screenshot, error, depth }], // cap 5000
  summary                                 // el resumen crudo del orquestador
}
```

## Consumo

- `scrape-handlers.run` adjunta `report` al summary y cachea el último en `browser._lastScrapeReport`.
- MCP `oz.scrape.lastReport` (registrado `oz_scrape_lastReport`) devuelve ese último reporte, o `null` si no hubo job.

## Caps

`MAX_ACTION_LOG = 5000`, `MAX_ERRORS = 200` — jobs enormes no explotan memoria; las métricas agregadas (`cost`, `byWorker`, `byDomain`) siguen contando todo.
