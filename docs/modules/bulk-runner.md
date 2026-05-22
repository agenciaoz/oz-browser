# Módulo `bulk-runner`

**Path:** `browser/bulk-runner.js`
**Líneas:** ~350
**Bloque/Etapa:** v2 sub-bloque 1 (commit `1ee4b93`, v2.0.0-alpha.1)

## Qué hace

Motor que ejecuta una action registrada sobre N identities en orden, con delays anti-detect, reportando progreso per-identity y persistiendo state para survive a restarts. Es la pieza central del Automation Engine MVP de v2.

## Exports

| Símbolo                    | Tipo    | Descripción                                                                         |
| -------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `BulkRunner`               | class   | Motor. `new BulkRunner({userDataDir, identityManager, registry, logger?, clock?})`. |
| `BulkRunnerError`          | class   | Error con `code` para distinguir validation failures.                               |
| `STATUS_*`, `RUN_STATUS_*` | strings | Constantes de status. Exposed para handlers/tests.                                  |

## API

### Constructor

```js
new BulkRunner({
  userDataDir, // string — root para persistir runs
  identityManager, // requiere {get(id), list()}
  registry, // bulk-actions-registry singleton
  logger, // opcional — default no-op logger
  clock, // opcional — default real setTimeout; tests pasan fake
})
```

Carga runs existentes de disco en `userData/bulk-runs/*.json` y marca como `failed` los que quedaron en `running` o `cancelling` (process restart mid-run).

### `create({actionId, identityIds, params?, options?}) → Promise<runId>`

Valida + persiste un run pero **no lo arranca**. Validaciones:

- `actionId` debe estar registrado (`UNKNOWN_ACTION`)
- `identityIds` no vacío (`BAD_IDENTITIES`), ≤200 (`CAP_EXCEEDED`), sin duplicados (`DUPLICATE_ID`), todas existen en identityManager (`UNKNOWN_IDENTITY`)
- `params` debe ser objeto (`BAD_PARAMS`)
- `options.minDelayMs ≥ 0`, `options.maxDelayMs ≥ minDelayMs` (`BAD_DELAY`)
- Max 5 runs concurrentes activos (`CONCURRENT_CAP`)

Defaults: `minDelayMs=30000, maxDelayMs=90000` (30-90s entre identities).

### `start(runId) → Promise<void>`

Dispara la ejecución async. Resuelve cuando arranca; el run sigue corriendo en background. Listen a los eventos para tracking.

### `run(spec) → Promise<runId>`

Convenience: `create` + `start` en uno.

### `cancel(runId) → boolean`

Gentle cancel. Setea abort signal + marca status `cancelling`. Returns `true` si efectivamente canceló, `false` si el run ya estaba terminado. Idempotente.

### `get(runId) → {meta, items} | null`

Deep copy del state (safe para UI).

### `list() → meta[]`

Solo metadata de todos los runs (sin items), newest first.

### `waitFor(runId) → Promise<final-state>`

Espera hasta terminal status (`completed`, `failed`, `cancelled`).

## Eventos (EventEmitter)

| Evento       | Payload                       | Cuándo                             |
| ------------ | ----------------------------- | ---------------------------------- |
| `created`    | `{runId, meta}`               | Después de `create` exitoso        |
| `started`    | `{runId, meta}`               | Después de `start`                 |
| `progress`   | `{runId, item, index, total}` | Cada vez que un item cambia status |
| `completed`  | `{runId, meta}`               | Run llega a terminal status        |
| `cancelling` | `{runId}`                     | `cancel()` fue llamado             |

## Shape persistido (`userData/bulk-runs/<runId>.json`)

```json
{
  "meta": {
    "runId": "br-a1b2c3d4e5f6g7h8",
    "schemaVersion": 1,
    "actionId": "echo",
    "actionLabel": "Echo (test action)",
    "params": { "message": "hello" },
    "options": { "minDelayMs": 30000, "maxDelayMs": 90000 },
    "identityCount": 3,
    "status": "completed",
    "createdAt": "2026-05-21T22:00:00.000Z",
    "startedAt": "2026-05-21T22:00:00.100Z",
    "finishedAt": "2026-05-21T22:00:00.150Z",
    "stats": { "done": 3, "failed": 0, "skipped": 0, "cancelled": 0 }
  },
  "items": [
    {
      "identityId": "id-abc",
      "identityName": "Alice",
      "status": "done",
      "startedAt": "2026-05-21T22:00:00.110Z",
      "finishedAt": "2026-05-21T22:00:00.115Z",
      "result": { "message": "hello", "echoedAt": "..." },
      "error": null
    },
    ...
  ]
}
```

## Status values

**Run-level (`meta.status`):**

- `created` — creado, no arrancado
- `running` — ejecutando
- `cancelling` — cancel pedido, terminando
- `completed` — todos los items completaron (con cualquier mix de done/failed/skipped/cancelled)
- `failed` — todos los items fallaron (zero done)
- `cancelled` — cancel se completó antes de done

**Item-level (`item.status`):**

- `pending` — esperando turno
- `running` — ejecutando ahora
- `done` — éxito (con result)
- `failed` — action throw'eó (con error.message)
- `cancelled` — abort llegó mid-action o pre-action
- `skipped` — identity vanished mid-run (operador la borró)

## Ejemplo

```js
const { BulkRunner } = require('./bulk-runner')
const registry = require('./bulk-actions-registry')
const { echoAction } = require('./bulk-actions-echo')

registry.register(echoAction)

const runner = new BulkRunner({
  userDataDir: app.getPath('userData'),
  identityManager: browser.identityManager,
  registry,
  logger: log,
})

runner.on('progress', ({ item, index, total }) => {
  console.log(`[${index + 1}/${total}] ${item.identityName}: ${item.status}`)
})

const runId = await runner.run({
  actionId: 'echo',
  identityIds: ['id-1', 'id-2', 'id-3'],
  params: { message: 'hello' },
  options: { minDelayMs: 0, maxDelayMs: 0 },
})

await runner.waitFor(runId)
const final = runner.get(runId)
console.log(`Done. Stats:`, final.meta.stats)
```

## Decisiones no obvias

- **Persistencia atómica:** writes via `tmp-<pid>-<ts>` + rename. Si el process muere mid-write, el archivo viejo queda intacto.
- **No retry automático:** ver ADR 0030 §6 — un retry mal hecho amplifica bans.
- **AbortController para cancel:** signal se propaga al action handler vía `ctx.signal`. El handler puede chequearlo en loops largos.
- **`run()` convenience:** atajo común. `create()` + `start()` separados existen por si querés inspeccionar el plan antes de dispatch (futuro UI feature).
- **Fake clock injection:** `opts.clock = { sleep(ms, signal) }` permite tests deterministas sin esperar 30s reales por identity.

## Cómo agregar una action nueva

1. Crear `browser/bulk-actions-<name>.js`:

   ```js
   module.exports.action = {
     id: 'mi_accion',
     label: 'Mi acción',
     description: 'Explicación clara de qué hace y qué params espera.',
     paramsSchema: {
       /* JSON Schema 2020-12 inline */
     },
     run: async (identity, params, ctx) => {
       // ctx.signal AbortSignal, ctx.runId, ctx.identityIndex, ctx.totalIdentities, ctx.logger
       // throw para falla; return cualquier shape para success
       return { ok: true }
     },
   }
   ```

2. Registrar en `bulk-runner-setup.js`:

   ```js
   if (!registry.get('mi_accion'))
     registry.register(require('./bulk-actions-mi-accion').action)
   ```

3. Listo. La UI la pickeará automáticamente en `oz.bulk.actions`.

## Referencias

- [ADR 0030](../architecture/0030-bulk-runner.md) — decisiones arquitecturales completas
- [`bulk-actions-registry.md`](bulk-actions-registry.md) — registry de actions (TBD)
- [`mcp-tools-bulk.md`](mcp-tools-bulk.md) — MCP tools (TBD)
- `tests/bulk-runner.smoketest.js` — coverage 49 asserts
