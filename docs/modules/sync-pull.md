# Módulo `sync-pull`

**Path:** `browser/sync-pull.js`
**Líneas:** ~360
**Bloque:** D-3c-2 ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §4 (pull / long-poll), §6 (initial sync cold-start)

## Qué hace

**Pull side** del sync engine. Lee remote records de Dropbox, decodifica con `sync-record-store`, corre LWW merge contra local state via `sync-merge`, y emite `'remote-apply'` events para que el host (sync-setup.js) los aplique en los managers (via `identity-manager-sync`, `workspace-manager-sync`, `bookmark-manager-sync`).

Independiente de `sync-engine` para mantener LOC bajo 500. D-3c-3 (sync-setup) compone ambos.

## Estado persistente

`userData/sync-state.json` — cursor por folder, atomic write.

```json
{
  "schemaVersion": 1,
  "cursors": {
    "identitys": "AAB7XBA...",
    "workspaces": "AAB7YDR...",
    "bookmarks": "AAB7ZE..."
  }
}
```

Bad JSON / schema mismatch al load → start fresh + emit `'warn'` (siguiente save reescribe).

## Exports

| Símbolo          | Tipo  | Descripción        |
| ---------------- | ----- | ------------------ |
| `SyncPuller`     | class | EventEmitter.      |
| `SyncPullError`  | class | Error con `.code`. |
| `SCHEMA_VERSION` | const | 1.                 |

## Constructor

```js
new SyncPuller({
  dropbox,           // has listFolder, listFolderContinue, download, isAuthenticated
  vault,             // has getMasterKey, isUnlocked
  deviceFolder,      // 'mac-aaaa1111'
  appFolder = 'sync',
  stateFilePath,     // absolute path
})
```

## API

| Método                                                   | Descripción                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `registerSource({recordType, fetchRecord, folderName?})` | `fetchRecord(id)` da el local record para LWW merge.             |
| `loadState()`                                            | Idempotente. Lee cursor file. Retorna `this`.                    |
| `saveState()`                                            | Persist atómico.                                                 |
| `cursorFor(folderName)`                                  | String o null.                                                   |
| `pullOnce(recordType)`                                   | Async. Cold-start = listFolder; subsequent = listFolderContinue. |

## pullOnce flow

1. Pause checks: vault locked → `{status: 'vault-locked'}`. Dropbox unauth → `{status: 'unauthenticated'}`.
2. List delta: si no hay cursor → `listFolder(folderPath)`; si hay → `listFolderContinue(cursor)`.
3. Para cada entry:
   - Skip folders + skip `isDeleted: true` (Dropbox-level hard delete, ej. GC sweep).
   - Download buf + decode.
   - Skip si `header.deviceFolder === thisDeviceFolder` (es nuestro propio upload).
   - Skip si `header.recordType !== expected` (mismatch — warn).
   - Build local header desde `fetchRecord(id)` (o null si no existe).
   - `mergeRecords(localHeader, remoteHeader)`:
     - `'take-remote'` → emit `'remote-apply'` con `{action: header.deleted ? 'delete' : 'upsert', recordId, header, body}`.
     - `'keep-local'` → emit `'local-wins'` con `{recordType, header, reason}` (informational).
     - `'noop'` → skip.
4. Persist nuevo cursor.

Retorna `{status: 'ok', applied, localWins, skipped, errors, hasMore, cursor}`.

## Eventos

| Evento           | Payload                        | Notas                                                                                          |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------- |
| `'remote-apply'` | `{recordType, action: 'upsert' | 'delete', recordId, header, body}`                                                             | body es null en tombstones. |
| `'local-wins'`   | `{recordType, header, reason}` | Solo informational.                                                                            |
| `'paused'`       | `{reason}`                     | vault-locked / unauthenticated.                                                                |
| `'warn'`         | `{reason, ...}`                | decode-failed / list-folder-failed / record-type-mismatch / download-failed / state-\* (load). |

## Tests

- `tests/sync-pull.smoketest.js` (44 assertions) — cold-start listFolder, subsequent listFolderContinue, LWW remote-newer → remote-apply upsert, LWW local-newer → local-wins, tombstone → remote-apply delete, skip self-uploads via deviceFolder match, skip Dropbox-level isDeleted, decode failure → warn + errors, recordType mismatch → warn.
- `tests/sync-pull-state.smoketest.js` (15 assertions) — cursor persistence, state schema mismatch + corrupt JSON start fresh + warn, vault locked / unauth pause, listFolder network failure, no-source NO_SOURCE, error class shape.

## Gotchas

- **NO incluye long-poll connection** via `filesListFolderLongpoll` — el caller (sync-setup) corre `pullOnce` en un `setInterval`. D-3c-3d reemplazará con long-poll real.
- **NO incluye pagination loop** — si `hasMore: true`, el caller debe llamar pullOnce de nuevo.
- **NO aplica** los `remote-apply` events — el host wirea esos events a los `*-manager-sync` modules.
