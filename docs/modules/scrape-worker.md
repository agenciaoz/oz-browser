# Módulo `scrape-worker`

**Path:** `browser/scrape-worker.js`
**Líneas:** ~59
**Bloque:** V3-D scraping / agent-control (cierre V3-D)

## Qué hace

Factory del worker real de scrape: convierte el page-driver (page-handlers) en un `worker(task)` para `runScrapeJob`. Por cada URL del frontier, navega y corre el recipe (reutilizando `runHeadlessRecipe`), y mapea el resultado a la forma que el orquestador espera: `{ ok, data?, links?, retryable?, error? }`.

## Exporta / API

| Export                   | Descripción                                              |
| ------------------------ | -------------------------------------------------------- |
| `makeRecipeWorker(args)` | Devuelve `async worker(task)` listo para `runScrapeJob`. |

`args`: `{ driver, identityId, recipe?, clock?, linksName? }`. `recipe.steps` son pasos extra tras navegar; `linksName` es el nombre del step cuyo resultado (array de URLs) se sigue como links.

## IPC / MCP

No registra IPC directamente. Es el glue entre `headless-runner` y `scrape-orchestrator`; en runtime el `driver` reales son los page-handlers (vía `scrape-handlers.js`).

## Gotchas

- El worker NO reintenta internamente (corre el recipe con `maxAttempts:1`); el reintento lo maneja el frontier/orquestador (clase de error → retryable vía `scrape-retry.classifyError`). Así no se duplican reintentos.
- `driver` y `clock` se inyectan → testeable con fakes; page-handlers reales en runtime.
- Ante fallo, extrae el primer step fallido para `error` y deriva `retryable` de `classifyError`.
- ADR 0030 · 0005 · 0036.
