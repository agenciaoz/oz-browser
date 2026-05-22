# ADR 0030 — Bulk Runner (v2 sub-bloque 1)

**Status:** Accepted
**Date:** 2026-05-21
**Supersedes:** Partially supersedes the F-1/F-4 design in `docs/PLAN-AUTOMATION-F-K.md` — see §"Relación con plan F-K original" abajo.

## Contexto

Cierre de v1 en 1.9.4. Jose pide arrancar v2. Conversación de scoping descubre que el modelo mental real es mucho más simple que el plan F-K original (95-101h de automation engine con LLM agent + recipes engine + spintax + cooldown registries):

> "Que sea manual.. yo le digo que haga algo, OZ lo ejecuta en N cuentas. Por ejemplo, mete estos comentarios uno por cada cuenta en este link."

Esto es **on-demand bulk execution**, no automation autónoma. Sin LLM en loop, sin cron-driven workflows, sin scraping anti-detect avanzado. El usuario dice qué hacer; el sistema lo ejecuta en paralelo (anti-detect-aware) y reporta.

## Decisión

Implementar un Bulk Runner core que toma `{actionId, identityIds, params, options?}`, lo persiste como `run`, y ejecuta las identities secuencialmente con delays anti-detect entre cada una. Las acciones específicas (postear IG, comentar, like, follow) son **handlers pluggables** registrados en un `bulk-actions-registry` global.

### Decisiones de diseño

| #   | Decisión                                                                                                                       | Razón                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Secuencial con delays randomizados** entre identities (30-90s default ± jitter)                                              | Anti-detect favorece pattern humano. 8-paralelo del plan F-1 era para thread urgency; no aplica acá. Si en el futuro se necesita N paralelo, agregar `options.concurrency` sin romper backward-compat.                                                                                                |
| 2   | **Action registry pluggable** (`bulk-actions-registry.js`) — mapa `id → {label, paramsSchema, run}`                            | Permite agregar acciones nuevas sin tocar el motor. Cada handler se registra en boot (`bulk-runner-setup` hace `registry.register(echoAction)`). Tests pueden registrar mocks vía `registry.clear()` + register.                                                                                      |
| 3   | **Persistencia: 1 archivo JSON por run** en `userData/bulk-runs/<runId>.json`, atómico tmp+rename                              | Mismo pattern que F-3 scheduled-actions. Permite inspección post-mortem y eventual resume sin migrar a SQLite. Caps de runs antiguos: por ahora cero — futuro sub-bloque puede agregar GC.                                                                                                            |
| 4   | **Restart-recovery:** runs en status `running` o `cancelling` al boot se marcan `failed` con error "process restarted mid-run" | Sin esto los runs huérfanos quedarían marcados como running forever. Sub-bloque futuro puede agregar auto-resume real.                                                                                                                                                                                |
| 5   | **Cancellation gentle vía AbortController**                                                                                    | `cancel(runId)` setea `signal.abort()` + marca status `cancelling`. La identity en curso recibe la signal — el action handler decide si abortar o terminar. Identities restantes se marcan `cancelled`. No mata mid-action por la fuerza (un kill mid-IG-post podría dejar contenido en estado raro). |
| 6   | **No retry automático en MVP**                                                                                                 | Retry mal hecho amplifica problemas: 5 intentos de comentar = posible flag de spam o ban. Mejor que el operador relance manual sobre las identities que fallaron. Sub-bloque futuro puede agregar retry policy configurable.                                                                          |
| 7   | **Skip+continue ante failures**                                                                                                | Un job de 50 identities no debe abortar entero por 1 falla. Item failed se reporta, runner sigue.                                                                                                                                                                                                     |
| 8   | **Status per-item:** `pending → running → done\|failed\|cancelled\|skipped`                                                    | `skipped` cubre el caso "identity vanished mid-run" (raro pero posible si el operador borra una identity con un job en curso).                                                                                                                                                                        |
| 9   | **Result blob libre per action**                                                                                               | El motor no impone shape del result — cada action handler retorna lo que tenga sentido. Reporter UI lo serializa con `JSON.stringify` para display.                                                                                                                                                   |
| 10  | **Caps:** max 200 identities/run, max 5 runs concurrentes                                                                      | Defensa contra typos / runaway jobs. Configurables si hace falta.                                                                                                                                                                                                                                     |
| 11  | **Exposición triple:** MCP tools `oz.bulk.*` + IPC `oz:bulk:*` + preload `window.oz.bulk.*`                                    | Mismo pattern que el resto del producto. Permite scriptear desde Claude Desktop O usar la UI nativa.                                                                                                                                                                                                  |

## Architecture diagram

```
                ┌─────────────────────────────────────────┐
                │       bulk-actions-registry             │
                │  ┌─────────────────────────────────┐    │
                │  │  Map<id, {label, schema, run}>  │    │
                │  └─────────────────────────────────┘    │
                └─────────────────────────────────────────┘
                           ▲
                           │ register()
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   echo (v2.0.0-α.1)    igPost (TBD)     igComment (TBD)
        │                                     │
        └──────────────────┬──────────────────┘
                           │
                           ▼ get(actionId)
                ┌─────────────────────────────────────────┐
                │           BulkRunner                    │
                │   ┌─────────────────────────────────┐   │
                │   │  Map<runId, {meta, items}>      │   │
                │   │  Persisted: userData/bulk-runs/ │   │
                │   └─────────────────────────────────┘   │
                │   EventEmitter: created, started,       │
                │                 progress, completed,    │
                │                 cancelling              │
                └─────────────────────────────────────────┘
                    ▲          ▲          ▲
                    │          │          │
              MCP tools    IPC routes   broadcastToWebUI
              oz.bulk.*    oz:bulk:*    oz:bulk:* (live)
                    │          │          │
              Claude Code   window.oz.    UI subscribe
              & external    bulk.* in     via preload
              scripts       renderer
```

## Lifecycle de un run

```
create()
  ├─ validate (action exists, identities exist, caps)
  ├─ persist {meta: status='created', items[]: pending}
  └─ return runId

start(runId)
  ├─ status='running'
  ├─ create AbortController
  ├─ emit 'started'
  └─ background _runLoop:
       for each item in items:
         if aborted → mark rest as cancelled, break
         if identity vanished → mark skipped, continue
         if i>0 → sleep random(min, max)  (abort-aware)
         item.status='running' → emit 'progress' → persist
         try: result = action.run(identity, params, ctx)
              item.status='done' + item.result
         catch: item.status='failed' + item.error
                (or 'cancelled' if aborted mid-action)
         emit 'progress' → persist
       finalize: status='completed' | 'failed' | 'cancelled'
       emit 'completed' → persist

cancel(runId)
  ├─ status='cancelling'
  ├─ controller.abort()
  ├─ emit 'cancelling'
  └─ (loop reacts and finalizes)

get(runId), list() → deep-copies for safe UI consumption
```

## Files

- `browser/bulk-runner.js` — motor (~350 LOC)
- `browser/bulk-actions-registry.js` — registry
- `browser/bulk-actions-echo.js` — built-in test action
- `browser/bulk-runner-setup.js` — lifecycle glue para main.js
- `browser/bulk-handlers.js` — IPC handler factory + event broadcast wiring
- `browser/mcp-tools-bulk.js` — 7 MCP tools
- `browser/preload-bulk-api.js` — preload bridge
- `browser/ui/bulk-runner-ui.js` (v2.0.0-alpha.2) — modal UI

## Tests

`tests/bulk-runner.smoketest.js` — 49 asserts. Cubre:

- Registry CRUD + duplicate/bad-format rejection
- create() validation (unknown action, empty, duplicate, cap, unknown identity)
- Happy path 3 identities con progress events
- Spread temporal con fake clock (que honra abort signals)
- Cancellation mid-flight, marca remaining como cancelled
- Failure mid-run: item failed, run continúa
- Persistence atómica + reload tras restart + orphan runs → failed
- Concurrent runs cap = 5
- Identity vanishes mid-run → skipped
- run() convenience method

## Update 2026-05-21 bis — UI (v2.0.0-alpha.2)

Sub-bloque 2 shipped: modal nativo con composer + live progress + result reporter unificados. Triggers: Cmd+Shift+B accelerator + Cmd+K palette entry "Bulk Run…". Cierra el gap del alpha.1 donde el motor solo era invocable via MCP chat.

Detalles en `docs/modules/bulk-runner.md` (módulo UI) y `browser/ui/bulk-runner-ui.js` (~420 LOC, singleton IIFE).

## Relación con plan F-K original

`docs/PLAN-AUTOMATION-F-K.md` definió un Automation Engine ambicioso (95-101h):

- F-1 ActionRunner Core con multi-strategy success capture, human-jitter (Box-Muller latency + bezier cursor + typing patterns + idle simulation)
- F-2 Recipes engine + spintax + X recipe MVP
- F-3 Scheduled Actions (cron-driven workflows)
- F-4 Bulk Orchestrator + Cooldown Registry + Rate-limit Budgets + Resume
- G-K LLM agents, recipes per platform, learning loops, etc.

El Bulk Runner de v2.0.0-alpha.1 implementa **únicamente** el equivalente reducido de F-4 (orchestrator + queue + delays + persist + resume light). Las features ambiciosas del plan F-K NO entran en el MVP definido por Jose post-v1.9.4:

- **Human-jitter complejo**: out — los delays simples entre identities son suficientes anti-detect a este nivel; el cursor bezier y typing patterns son v3 territory.
- **Spintax + recipes engine**: out — las actions son JS functions con params, no DSL.
- **Cooldown registry per-identity persistido**: out — el operador es responsable de no abusar; sub-bloque futuro puede agregar si los bans empiezan a aparecer.
- **Rate-limit budgets**: out — same razón.
- **Multi-strategy success capture** (urlChange + webRequest + DOMMutation + proofOfLife): el `igPost` action que viene en sub-bloque 3 probablemente use 1-2 strategies, no 4. Pragmatismo > completitud.
- **LLM en loop**: out — Jose no quiere autonomy, quiere ejecución obediente.
- **Scheduled Actions integration**: deferido a sub-bloque 5 del MVP.

Si en v3 (SaaS) los use cases requieren la maquinaria full F-K, este ADR no la prohibe — el design del registry + run engine permite agregar capas (recipes encima de actions, cooldown registry como middleware del runner, etc.) sin rehacer el motor.

## Referencias

- `docs/PLAN-AUTOMATION-F-K.md` — plan original v2 ambicioso
- `docs/modules/bulk-runner.md` — module reference
- `tests/bulk-runner.smoketest.js` — coverage
- `CHANGELOG.md` entries `v2.0.0-alpha.1` y `v2.0.0-alpha.2`
