# Módulo `sync-engine`

**Path:** `browser/sync-engine.js`
**Líneas:** ~440
**Bloque:** D-3c-1 ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §4 (push on change), §5 (offline queue), §12 (failure modes)

## Qué hace

**Push side** del sync engine. Wirea IdentityManager (y opcionalmente WorkspaceManager, BookmarkManager via `sync-setup.js`) a Dropbox: escucha `'changed'` events, traduce a queue ops, drena con backoff exponencial, sube records cifrados.

## Garantía clave — race-safe conditional remove

Después de cada upload exitoso, el engine **NO borra ciegamente** la op del queue. En su lugar:

1. Captura el `updatedAt` del record AL MOMENTO de fetchRecord (push time).
2. Sube ese snapshot a Dropbox.
3. Tras éxito: relee `queue.peek()` para esa key.
4. Si el slot del queue tiene `updatedAt <=` lo que pusheamos → remove (cumplido).
5. Si el slot tiene `updatedAt >` lo que pusheamos → DEJA el slot (un edit posterior llegó durante el upload, queda pendiente para el próximo drain).

Garantiza **zero edit loss** incluso bajo carga de mutations durante un upload lento.

## Exports

| Símbolo                  | Tipo  | Descripción                              |
| ------------------------ | ----- | ---------------------------------------- |
| `SyncEngine`             | class | EventEmitter. Constructor + API abajo.   |
| `SyncEngineError`        | class | Error con `.code`.                       |
| `DEFAULT_BACKOFF_MS`     | const | `[1000, 2000, 4000, 8000, 16000, 30000]` |
| `DEFAULT_IDLE_WAIT_MS`   | const | 1000                                     |
| `DEFAULT_APP_FOLDER`     | const | `'sync'`                                 |
| `DEFAULT_SCHEMA_VERSION` | const | 1                                        |

## Constructor

```js
new SyncEngine({
  dropbox,           // has upload(path, buffer), isAuthenticated()
  vault,             // has getMasterKey(), isUnlocked
  queue,             // SyncQueue instance (already .load()'d)
  deviceFolder,      // 'mac-aaaa1111'
  appFolder = 'sync',
  schemaVersion = 1,
  backoffSchedule,   // [1000, 2000, ...]
  idleWaitMs,
  scheduler = setTimeout,        // inject for tests
  cancelScheduler = clearTimeout,
})
```

## API

| Método                  | Descripción                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `registerSource({...})` | Wirea un source: `{recordType, manager, fetchRecord, folderName?}`. Instala 'changed' listener. |
| `start()` / `stop()`    | Drena loop. `start` idempotente. `stop` detacha listeners — engine queda finalizado.            |
| `drainOnce()`           | Una iteración: peek → encode → upload → conditional remove. Retorna status string.              |
| `currentBackoffMs()`    | Backoff actual.                                                                                 |

## Drain status values

| status              | significado                                                  |
| ------------------- | ------------------------------------------------------------ |
| `'pushed'`          | Upload exitoso + queue slot removed (o stay si raced).       |
| `'empty'`           | Queue vacío.                                                 |
| `'vault-locked'`    | Vault no unlocked — pausa (no error).                        |
| `'unauthenticated'` | Dropbox no auth — pausa (no error).                          |
| `'failed'`          | Upload throw, backoff escalates.                             |
| `'skipped'`         | RECORD_GONE (record borrado localmente entre enqueue+drain). |

## Eventos

| Evento                    | Payload                       | Cuándo                                           |
| ------------------------- | ----------------------------- | ------------------------------------------------ |
| `'pushed'`                | `{op, path, pushedUpdatedAt}` | Upload OK.                                       |
| `'push-failed'`           | `{op, path, message}`         | Upload throw.                                    |
| `'paused'`                | `{reason}`                    | vault-locked / unauthenticated.                  |
| `'warn'`                  | `{reason, ...}`               | unknown-op, no-source, record-gone-dropped, etc. |
| `'started'` / `'stopped'` | -                             | Lifecycle.                                       |

## Dropbox path

```
/{appFolder}/{folderName}/{recordId}.json.enc
```

Por defecto folderName = `${recordType}s` (e.g. 'identitys', 'workspaces'). registerSource puede override.

## Tests

- `tests/sync-engine.smoketest.js` (47 assertions) — registerSource + 'changed' → enqueue, empty queue, vault locked / unauthenticated pause, happy path upload + decode round-trip, tombstone upload, validation, registerSource + constructor errors, stop() detaches.
- `tests/sync-engine-resilience.smoketest.js` (16 assertions) — backoff escalation + cap + reset, race-safe conditional remove (concurrent enqueue mid-flight), RECORD_GONE skip + warn.

Split por ADR 0005 (500 LOC rule).

## Gotchas

- El engine **NO hace conflict pre-flight** via `filesGetMetadata` antes del push (diverge del ADR §4). Just overwrites; LWW resuelve en el pull side. Race window es estrecha y tolerable para team <10.
- `start()` arma el listener pero NO drena synchronously — la primera drainOnce ocurre via `scheduler(callback, 0)` next tick.
- `stop()` detacha el listener — el engine queda finalizado, no se puede re-start con sources viejas. registerSource refuse re-registration.
