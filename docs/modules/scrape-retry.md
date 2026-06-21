# Módulo `scrape-retry`

**Path:** `browser/scrape-retry.js`
**Líneas:** ~190
**Bloque:** V3-D scraping / agent-control

## Qué hace

Helpers de retry/backoff: clasifica errores por clase y calcula el delay de backoff exponencial con jitter para reintentar acciones transitorias durante un scrape/orquestación. Reintenta SOLO errores transitorios (red, timeout, navegación). NO reintenta clases que requieren intervención (captcha, needs_login, rate-limit, aborted) ni errores fatales de programación (TypeError/ReferenceError/Syntax).

## Exporta / API

| Export                              | Descripción                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `classifyError(err)`                | → `{ class, retryable }`. Detecta por code/name/mensaje.                             |
| `buildRetryPolicy(opts)`            | Normaliza opts parciales a policy completa (tolera basura).                          |
| `backoffDelay(attempt, opts)`       | Backoff exponencial 1-based con equal-jitter; ms entero ≥ 0.                         |
| `shouldRetry(err, attempt, policy)` | ¿Conviene reintentar tras `attempt` intentos hechos?                                 |
| `NON_RETRYABLE_CLASSES`             | `['captcha','needs_login','rate-limit','aborted','fatal']`.                          |
| `DEFAULTS`                          | Policy congelada (`maxAttempts:3, baseMs:1000, factor:2, maxMs:30000, jitter:true`). |

## IPC / MCP

No registra IPC directamente (lógica pura). La consumen `headless-runner.js`, `scrape-worker.js` y el glue `bulk-runner-retry.js`.

## Gotchas

- 100% testeable en node (sin Electron/DOM/fs); `rng` inyectable en `backoffDelay`.
- Clases detectadas: `needs_login`, `rate-limit`, `captcha`, `aborted`, `fatal`, `timeout`, `network`, `navigation`, `unknown` (este último reintentable conservadoramente).
- Equal-jitter (mitad determinística + mitad aleatoria) evita thundering herd sin colapsar el delay a ~0.
- `shouldRetry` también respeta `policy.retryClasses` (allowlist opcional).
- ADR 0030 · 0005 · 0036. Política en `docs/PLAN-V3-SCRAPING.md` §3 V3-D.
