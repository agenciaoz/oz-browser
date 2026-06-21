# Módulo `scrape-ratelimit-domain`

**Path:** `browser/scrape-ratelimit-domain.js`
**Líneas:** ~135
**Bloque:** V3-D scraping / agent-control

## Qué hace

Rate limiter por dominio para la orquestación de scraping en paralelo: aunque N identities corran a la vez, los requests al MISMO dominio se espacian un intervalo mínimo (anti-detect + buena ciudadanía); distintos dominios no se bloquean entre sí. Patrón "next-available timestamp": cada `reserve(url)` calcula cuánto esperar y empuja el próximo slot del dominio.

## Exporta / API

| Export                    | Descripción                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `DomainRateLimiter`       | Clase (opts: `minIntervalMs?`, `perDomain?`, `clock?`).            |
| `domainOf(url)`           | Hostname normalizado (lowercase, sin `www.`); `null` si no parsea. |
| `DEFAULT_MIN_INTERVAL_MS` | Intervalo default entre requests al mismo dominio (1000).          |

| Método                | Descripción                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `intervalFor(domain)` | Intervalo configurado para un dominio (override o default).                 |
| `reserve(url)`        | Reserva el próximo slot (MUTA); devuelve `{ domain, waitMs, scheduledTs }`. |
| `peek(url)`           | Espera actual sin reservar (no muta) — UI/telemetría.                       |
| `stats()`             | Snapshot `{ domain → nextAvailableTs }`.                                    |
| `reset(domain?)`      | Resetea un dominio (o todos).                                               |

## IPC / MCP

No registra IPC directamente (lógica pura). La consume `scrape-orchestrator.js` (que hace `await clock.sleep(waitMs)`).

## Gotchas

- Pieza PURA salvo `clock` inyectable (`Date.now` por defecto) → 100% testeable en node.
- No reduce a eTLD+1 (evita depender de una Public Suffix List): la clave es el hostname normalizado.
- URLs sin host (about:blank, basura) → `waitMs 0` y no se trackean.
- `perDomain` se normaliza con `domainOf` al construir (overrides tipo `{ 'instagram.com': 5000 }`).
- ADR 0030 · 0005 · 0036.
