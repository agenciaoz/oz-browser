# Módulo `sync-queue`

**Path:** `browser/sync-queue.js`
**Líneas:** ~280
**Bloque:** D-3b ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §5 (offline queue + replay)

## Qué hace

Cola FIFO persistente de operaciones pendientes de sync (upsert / delete) que aún no fueron subidas a Dropbox. Drenada por `sync-engine` cuando hay conectividad + vault unlocked; crece cuando offline o vault locked.

**Coalesce key insight**: at most ONE pending op per `(recordType, recordId)`. Un enqueue subsecuente sobre la misma key REEMPLAZA la op anterior Y mueve el slot al END de la cola. Resultado: la cola siempre carga el estado más fresco, y el orden FIFO refleja most-recent-edit-first-among-pending.

## Storage

`userData/sync-queue.json` — atomic write via tmp + rename. Cheap to call after every mutation.

```json
{
  "schemaVersion": 1,
  "queue": [
    { "op": "upsert", "recordType": "identity", "recordId": "abc", "updatedAt": "..." },
    { "op": "delete", "recordType": "workspace", "recordId": "xyz", "deletedAt": "..." }
  ]
}
```

## Exports

| Símbolo          | Tipo  | Descripción                  |
| ---------------- | ----- | ---------------------------- |
| `SyncQueue`      | class | EventEmitter. Ver API abajo. |
| `SyncQueueError` | class | Error con `.code`.           |
| `SCHEMA_VERSION` | const | 1.                           |
| `MAX_QUEUE_SIZE` | const | 50_000 (sanity cap).         |

## API

| Método                       | Descripción                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `new SyncQueue({filePath})`  | Path absoluto al `sync-queue.json`. No carga hasta `.load()`.                         |
| `.load()`                    | Idempotente. Lee disk, valida ops, skip malformed con `'warn'` event. Retorna `this`. |
| `.save()`                    | Persist atómico. Llamado internamente tras cada mutación.                             |
| `.enqueue(op)`               | Valida + dedupa + persiste. Retorna `{coalesced: boolean}`. Throws en validation.     |
| `.peek()`                    | Primera op o null. Retorna SHALLOW COPY (mutar es harmless).                          |
| `.dequeue()`                 | Remueve + retorna primera. Persiste. Emite `'dequeued'`.                              |
| `.remove(recordType, recId)` | Quita por key específica. Retorna boolean. Usado por engine tras upload exitoso.      |
| `.has(recordType, recId)`    | Boolean.                                                                              |
| `.size()`                    | Número de ops pendientes.                                                             |
| `.list()`                    | Array (copia) en FIFO order.                                                          |
| `.clear()`                   | Drop todo. Emite `'cleared'` con `droppedCount`.                                      |

## Eventos

| Evento       | Payload                    | Cuándo                                                             |
| ------------ | -------------------------- | ------------------------------------------------------------------ |
| `'enqueued'` | `{op, coalesced: boolean}` | Tras cada enqueue exitoso.                                         |
| `'dequeued'` | `{op}`                     | Tras cada dequeue.                                                 |
| `'removed'`  | `{op}`                     | Tras remove por key.                                               |
| `'cleared'`  | `{droppedCount}`           | Tras clear().                                                      |
| `'warn'`     | `{reason, ...}`            | parse-failed / schema-mismatch / invalid-op-skipped / read-failed. |

## Validation codes

`BAD_OP`, `BAD_OP_TYPE`, `BAD_RECORD_TYPE`, `BAD_RECORD_ID`, `BAD_UPDATED_AT`, `BAD_DELETED_AT`, `UPSERT_WITH_DELETED_AT`, `DELETE_WITH_UPDATED_AT`, `QUEUE_FULL`, `BAD_ARG`.

## Tests

63 assertions en `tests/sync-queue.smoketest.js`. Round-trip, FIFO order, coalesce semantics (upsert→delete supersede, delete→upsert resurrect), distinct recordType slots, schema mismatch starts fresh, corrupt JSON starts fresh, todos los validation paths.

## Gotchas

- Coalesce significa que **no podés depender del orden de inserción para una key específica** — la última enqueue gana.
- La cola es bounded: si `MAX_QUEUE_SIZE` se alcanza, `enqueue` de NUEVAS keys throws `QUEUE_FULL` (re-enqueue de keys existentes siempre OK porque dedupa).
