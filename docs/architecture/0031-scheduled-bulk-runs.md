# ADR 0031 — Scheduled Bulk Runs (v2 Etapa 2.1)

**Status:** Accepted
**Date:** 2026-05-22
**Builds on:** ADR 0030 (Bulk Runner core), F-1 Scheduled Actions runner

## Contexto

v2 alpha.1-17 cerraron el bulk runner: 11 actions sobre 4 plataformas, auto-login con vault, rate-limit registry, UI polish. Pero todo el flujo era **on-demand**: Jose abre Cmd+Shift+B, configura, click Run. Para usar OZ como "automation engine real" — el caso de uso que justifica el rebrand de v1 → v2 — falta poder decir:

> "todos los lunes 9am, corré IG Like en estas 20 identities"

v1 ya tiene F-1 (Scheduled Actions): cron-lite con persistence, runner que tickea 60s, handler registry, lifecycle (load/start/stop). v1 lo usa para `open-workspace`, `sync-push`, `backup-snapshot`, `session-warmer` — todo workspace-level, sin acción de plataforma.

La pregunta de diseño es: ¿cómo se acoplan bulk runner (v2) + scheduled actions (v1) sin duplicar código y sin romper la separación de capas?

## Decisión

Modelar "scheduled bulk run" como **un action type más** del F-1 runner. La integración es un handler thin que delega 100% al `BulkRunner`.

### Decisiones de diseño

| #   | Decisión                                                                                                     | Razón                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Action type `'bulk'`** registrado en `registerScheduledActionHandlers` cuando `deps.bulkRunner` está wired | Mismo pattern que `open-workspace`/`sync-push`/`session-warmer`. F-1 ya soporta plug-in de handlers por type; agregar uno no requiere modificar el runner.                                                                                                                                                                                                                                                                            |
| 2   | **Handler thin (~140 LOC) en archivo separado** (`scheduled-action-bulk.js`)                                 | No duplica lógica de bulk: solo valida shape de params, opcionalmente chequea registry para typo detection temprana, skip on locked vault, llama a `bulkRunner.run(spec)`. Un code path, un set de bugs. Archivo separado para no inflar `scheduled-action-handlers.js` (LOC budget).                                                                                                                                                 |
| 3   | **`params.spec` contiene el spec completo del bulk** (`actionId`, `identityIds[]`, `params`, `options`)      | El shape es idéntico al que toma `oz.bulk.run`. Permite copy-paste mental entre "Run now" y "Schedule": misma estructura, distinto dispatcher.                                                                                                                                                                                                                                                                                        |
| 4   | **Fire-and-forget**: el handler retorna `{ok:true, runId}` apenas `bulkRunner.run()` devuelve el runId       | `bulkRunner.run()` arranca la ejecución async per-identity (con delays anti-detect). Si el handler esperara `await runner.start(runId)` y la cola tarda 30 min, el scheduler tick quedaría bloqueado. Fire-and-forget mantiene el scheduler responsivo.                                                                                                                                                                               |
| 5   | **Skip on locked vault**                                                                                     | La mayoría de los bulk actions necesitan vault para auto-login retry. Sin vault, el run quedaría no-op para todos los items. Mejor skip con `{skipped:true, reason:'vault-locked'}` que loggear N failures. Misma política que `sync-push`/`backup-snapshot`.                                                                                                                                                                         |
| 6   | **Registry probe opcional** para early actionId validation                                                   | Si `deps.bulkActionsRegistry` está wired, el handler chequea `registry.get(actionId)` y throwea `UNKNOWN_BULK_ACTION` antes de delegar. Sin probe, el typo se manifestaría como NO_HANDLER mid-run. Probe surface el typo en el `lastResult.error` de la scheduled action.                                                                                                                                                            |
| 7   | **Setup order en main.js: bulkRunner ANTES de scheduledActions**                                             | `setupScheduledActions._buildDeps()` lee `browser.bulkRunner` y `browser.bulkActionsRegistry`. Si scheduledActions setup corre primero, esos campos están undefined y el handler 'bulk' nunca se registra. Swap simple.                                                                                                                                                                                                               |
| 8   | **MCP tools `oz.sched.*`** — primer surface MCP para scheduled-actions                                       | Hasta alpha.17 no había forma de crear scheduled actions desde Claude. Etapa 2.1 agrega `oz.sched.list/get/create/remove/setEn/status/tickNow`. Esto habilita el flujo end-to-end "Claude, programá IG Like cada lunes" sin abrir la UI.                                                                                                                                                                                              |
| 9   | **UI: botón "Schedule…" en bulk-runner modal con native prompts**                                            | Re-usa el composer (action picker + identity selector + params + delays) — esos pasos son idénticos para "Run now" vs "Schedule". Click en Schedule prompts para schedule type (daily/weekly), time, name → `scheduledActions.create({action:'bulk', params:{spec}, schedule})`. Native prompts feos pero funcionales. UI rica (date picker, day chips) es polish futuro.                                                             |
| 10  | **Settings → Scheduled Actions UI NO se extiende en alpha.18**                                               | El formulario create allí hardcodea action types `open-workspace`/`sync-push`/`backup-snapshot`/`session-warmer`. Para incluir 'bulk' habría que también renderizar form para `params.spec.actionId` + `identityIds[]` + `params` + `options` — esencialmente re-implementar el bulk-runner composer. Defer: la lista existente muestra scheduled bulk actions correctamente (data-driven), y create se hace desde modal o desde MCP. |

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Bulk Runner (v2 sub-bloque 1) — ADR 0030                          │
│  ────────────────────────────                                      │
│  oz.bulk.run({actionId, identityIds, params, options}) → runId     │
│      │                                                              │
│      └──> sequential per-identity execution with anti-detect delays │
│             + auto-login retry (sub-bloque 4)                       │
│             + rate-limit registry (sub-bloque 6)                    │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ delegated to (fire-and-forget)
                              │
┌────────────────────────────────────────────────────────────────────┐
│  Scheduled Action handler 'bulk' (Etapa 2.1)                       │
│  ────────────────────────                                          │
│  scheduled-action-bulk.js                                          │
│      - validates params.spec                                       │
│      - skip on locked vault                                        │
│      - calls bulkRunner.run(spec) → returns immediately            │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ ticks every 60s, fires due actions
                              │
┌────────────────────────────────────────────────────────────────────┐
│  Scheduled Actions runner (F-1)                                    │
│  ──────────────────────────                                        │
│  - cron-lite: every-minutes / daily HH:MM / weekly DAY HH:MM      │
│  - JSON store at userData/scheduled-actions.json                   │
│  - plug-in handler registry                                        │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ creates / updates / removes
                              │
┌────────────────────────────────────────────────────────────────────┐
│  Surfaces — all three are first-class                              │
│  ────────                                                          │
│  MCP:     oz.sched.create({name, action:'bulk', params:{spec},     │
│                            schedule:{type:'weekly', day:'mon',     │
│                                      time:'09:00'}})               │
│  UI:      bulk-runner modal "Schedule…" button                     │
│  Code:    window.oz.scheduledActions.create({...}) via preload     │
└────────────────────────────────────────────────────────────────────┘
```

## Concurrencia y semántica de fire

- **Reentrancy:** F-1 ya garantiza que una scheduled action no se solapa consigo misma (`_inFlight` Set). Si una scheduled bulk action está corriendo y otro tick la encuentra due, skip-ea con `'action-skipped'` `reason:'in-flight'`.
- **Pero**: `bulkRunner.run()` retorna inmediatamente. El handler resuelve apenas se asigna el runId. El "in-flight" del scheduler dura ~milisegundos, no las horas del bulk real. Esto es intencional: si el bulk de Monday todavía está corriendo el Tuesday a la 9am, queremos que el siguiente tick OK-ee otro bulk run, no que lo saltee.
- **Trade-off**: si esto causa concurrent bulks que pisan rate-limits o se chocan por identity, el rate-limit registry los protege (per-day caps). Más allá de eso, el operador es responsable de no programar runs que se traslapen.

## Failure modes

| Falla                                                           | Comportamiento                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `params.spec` malformed                                         | Handler throwea, `lastResult.error = BAD_PARAMS / BAD_ACTION_ID / etc.` Visible en `oz.sched.get` y en Settings UI.                             |
| `actionId` no existe en registry                                | `UNKNOWN_BULK_ACTION` en `lastResult.error`. Caught early gracias al registry probe.                                                            |
| Vault locked                                                    | `lastResult.value = {skipped:true, reason:'vault-locked'}`. No error, no retry — el próximo tick re-intenta.                                    |
| `bulkRunner.run()` throws (e.g. `MAX_CONCURRENT_RUNS` exceeded) | Handler propaga el error; `lastResult.error` lo refleja. F-1 ya cap-ea 200 actions; max concurrent bulks (5) es el cap del runner.              |
| Bulk run en sí falla mid-execution                              | Eso es opaco al scheduler (fire-and-forget). El bulk run queda en disco como cualquier otro bulk run, visible vía `oz.bulk.list` y reporter UI. |
| Identity referenciada ya no existe                              | El bulk runner skip-ea esa identity con `status:'skipped'` (cubierto por ADR 0030 §8). Otras identities en el spec siguen ejecutándose.         |

## Rejected alternatives

**1) Re-implementar bulk execution dentro del scheduler.**
Crearía un segundo code path para "bulk action en cron" vs "bulk action manual". Diverge en bugs, anti-detect cadence, rate-limit behavior. Rechazado por el principio "one code path = one set of bugs".

**2) Crear un cron engine separado en v2 que no use F-1.**
F-1 funciona, está testeado, tiene UI. Reinventarlo gastaría 5-8h sin valor incremental. Cron-lite con resolución de minuto es más que suficiente para automation engine (la naturaleza anti-detect dicta delays randomizados ± horas, no segundos).

**3) Hacer scheduledActions.create un MCP tool dentro de mcp-tools-bulk.js.**
Tentador para "todo lo de bulk en un solo archivo", pero scheduled-actions es ortogonal: también schedule-ea sync-push, backup-snapshot, session-warmer. Lo natural es un namespace `oz.sched.*` separado. Adicionalmente, scheduled-actions ya existía sin MCP surface — la Etapa 2.1 corrigió ese gap como side-effect.

**4) Block scheduler tick until bulk completes.**
Bloquearía 30 min+ todos los demás handlers (sync-push, backup-snapshot, session-warmer). Inaceptable. Fire-and-forget es la opción correcta.

## Open questions

- **¿Notificar al operador cuando un scheduled bulk completa?** Hoy el bulk run aparece en `oz.bulk.list` y en el reporter UI si está abierto, pero no hay push/native notification. Esto es Etapa 4 (Reliability + Observabilidad).
- **¿Soportar one-shot scheduled bulks?** F-1 solo soporta recurring (`every-minutes`, `daily`, `weekly`). Para "una sola vez el 2026-06-01 14:00" hoy hay que crear una weekly y removerla manualmente después de que dispare. Use case real para el agency: poco — los bulks son recurring. Punteo a futuro.
- **¿Rate-limit caps por scheduled action específica?** Hoy las caps son globales por (platform, action). Si un usuario quiere "este scheduled bulk no debe exceder 50 likes/día aunque el cap global sea 200", no se puede. Punteo a Etapa 4.

## Referencias

- `browser/scheduled-action-bulk.js` — handler implementation
- `browser/scheduled-action-handlers.js` — registry helper
- `browser/scheduled-setup.js` — deps wiring
- `browser/mcp-tools-scheduled.js` — MCP surface
- `browser/ui/bulk-runner-schedule.js` — UI helper
- `tests/scheduled-action-bulk.smoketest.js` — 27 assertions
- ADR 0030 — Bulk Runner core
- F-1 spec: `browser/scheduled-actions.js`
