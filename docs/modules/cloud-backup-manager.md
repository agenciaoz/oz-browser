# `browser/cloud-backup-manager.js`

**Bloque:** D-1.3 + D-1.4 + D-2.3 (cursor cache)
**ADR:** [0025 Cloud backup architecture](../architecture/0025-cloud-backup.md), [0026 Sync engine](../architecture/0026-sync-engine.md)
**Tests:** `tests/cloud-backup-manager.smoketest.js` (52) + `tests/cloud-backup-restore.smoketest.js` (27) + `tests/cloud-backup-cache.smoketest.js` (14)

## Qué hace

Orquesta el backup remoto. Combina:

- DeviceInfo (de dónde sale el `deviceFolder`)
- DropboxClient (transport)
- BackupManager (fuente de `.ozbackup` locales + restore target)

Estado en `userData/cloud-backup.json`.

## API

```js
const m = createCloudBackupManager({
  userDataDir,
  deviceInfo,
  dropboxClient,
  backupManager,
})
m.init() // wires auto-upload listener (call once after construction)

m.getStatus() // sync
m.connect() // → { authUrl } — caller does shell.openExternal
await m.completeConnect({ code, state }) // called by protocol dispatcher
m.disconnect()
m.setAutoUpload(bool)

await m.uploadSnapshot(snapshotId)
await m.downloadSnapshot(snapshotId, fromDeviceFolder?)
await m.restoreFromCloud(snapshotId, fromDeviceFolder?)
await m.listRemoteSnapshots(deviceFolder?) // sorted newest-first
await m.listDevices() // current device first, others alphabetical
await m.deleteRemoteSnapshot(snapshotId, deviceFolder?)
```

## Estado persistido

```json
{
  "connected": false,
  "account": { "accountId": "...", "email": "...", "name": "..." } | null,
  "autoUpload": false,
  "lastUploadAt": "ISO" | null,
  "lastUploadError": "string" | null,
  "lastSyncAt": "ISO" | null,
  "schemaVersion": 1
}
```

`disconnect()` resetea todo MENOS `autoUpload` (preferencia del user).

## Auto-upload hook

`init()` instala listener sobre `backupManager.on('snapshot-created', ...)`. Por cada snapshot creado:

- Skip si `!connected` o `!autoUpload`.
- Skip si `header.reason === 'pre-restore'` (amplification filter — un restore creará 2+ snapshots intermedios que no aportan info nueva).
- `uploadSnapshot(id)` fire-and-forget. Errores se loguean a `lastUploadError` pero no propagan.

`pre-quit` SÍ sube — es el último estado antes de cerrar.

## Folder layout en Dropbox

Cada device aterriza bajo `/Apps/OZ Browser/` (path root del Scoped App, internamente APP_BASE_PATH = `''`):

```
<deviceFolder>/snapshots/<snapshotId>.ozbackup
```

`listDevices()` lista la raíz + por cada folder hace `listRemoteSnapshots(folder)` para counts + latest timestamp. O(N) round-trips — aceptable para <20 devices.

## Cross-device restore

`restoreFromCloud(id, deviceFolder)`:

1. `downloadSnapshot(id, deviceFolder)` → escribe `${id}.ozbackup` en local `backupManager.snapshotsDir` (overwrite OK — content-addressable + AES-GCM auth).
2. `backupManager.restoreSnapshot(id)` (existing flow, vault required).

Caller (handler layer) hace el pre-restore safety snapshot ANTES, mismo patrón que `backup-handlers.restore`.

## Cursor cache (D-2.3)

In-memory `Map<folderPath, {entries, cursor}>`. Flujo:

- Cache miss → `dropboxClient.listFolderAll(folder)`, cachea `entries + cursor`.
- Cache hit → `dropboxClient.listFolderContinue(cursor)`, aplica delta (upsert + remove on `isDeleted`), refresca cursor.
- `CURSOR_RESET` → drop cache + re-list fresh.

Invalidation explícita: `uploadSnapshot` y `deleteRemoteSnapshot` invalidan el folder afectado. `disconnect` clear todo.

Cold start re-lista (memory-only). El cursor en disco es trade-off vs complejidad — postergado a D-3 si la métrica de UX lo justifica.

## NOT_CONFIGURED

Si `OZ_DROPBOX_APP_KEY` falta al build, el setup deja `cloudBackupManager = null`. El handler IPC `status` devuelve `{notConfigured: true}` y la UI muestra disconnected view.
