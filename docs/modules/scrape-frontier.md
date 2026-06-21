# Módulo `scrape-frontier`

**Path:** `browser/scrape-frontier.js`
**Líneas:** ~227
**Bloque:** V3-D scraping / agent-control

## Qué hace

Cola persistente de URLs por crawlear con dedupe + visited set + reintentos, que sobrevive a restarts. El orquestador hace `next()` → procesa → `markDone()` o `markFailed()`. Dedupe por URL normalizada (nunca encola dos veces la misma, ni una ya vista). Orden FIFO (BFS si se encola nivel por nivel), con `maxDepth` opcional. Estados de una URL: `pending → done | failed`.

## Exporta / API

| Export                 | Descripción                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `CrawlFrontier`        | Clase cola (opts: `filePath?`, `maxDepth?`, `maxAttempts?`).                        |
| `normalizeUrl(url)`    | Normaliza para dedupe (dropea `#fragment`); `null` si no parsea o no es http/https. |
| `SCHEMA_VERSION`       | Versión del esquema (1).                                                            |
| `DEFAULT_MAX_ATTEMPTS` | Reintentos por URL por defecto (3).                                                 |

| Método                    | Descripción                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `enqueue(url, opts)`      | Encola una URL; `false` si dup/vista/inválida/excede maxDepth.  |
| `enqueueMany(urls, opts)` | Encola varias (una sola persistencia al final); devuelve count. |
| `next()`                  | Saca la próxima pendiente (FIFO) o `null`.                      |
| `markDone(url)`           | Marca completada con éxito.                                     |
| `markFailed(url, opts)`   | Re-encola si `retryable` y quedan intentos; si no, va a failed. |
| `has(url)`                | ¿URL ya vista alguna vez?                                       |
| `pending()`               | Cantidad de pendientes.                                         |
| `stats()`                 | `{ pending, seen, done, failed }`.                              |

## IPC / MCP

No registra IPC directamente (lógica pura). La consume `scrape-orchestrator.js`.

## Gotchas

- Persistencia atómica JSON (tmp + `renameSync`); sin `filePath` opera 100% en memoria (tests / crawls efímeros).
- `enqueueMany` usa `_deferPersist` para una sola escritura al final.
- `_load()` arranca fresco ante archivo corrupto o de otra versión.
- `markFailed` con `attempts >= maxAttempts` deja de re-encolar.
- ADR 0030 · 0005 · 0036.
