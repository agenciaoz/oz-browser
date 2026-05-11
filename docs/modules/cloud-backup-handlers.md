# `browser/cloud-backup-handlers.js`

**Bloque:** D-1.5
**ADR:** [0025 Cloud backup architecture](../architecture/0025-cloud-backup.md)
**Tests:** `tests/cloud-backup-handlers.smoketest.js` (33)

## Qué hace

IPC handler map para Cloud Backup. Mismo patrón que `backup-handlers.js` (1.6b). Wiring del IPC en `ipc-handlers-extra.js#registerCloudBackupHandlersIPC`.

## Channels expuestos en preload

```js
window.oz.cloudBackup.status()              // → estado sync
window.oz.cloudBackup.connect()             // opens external browser
window.oz.cloudBackup.disconnect()
window.oz.cloudBackup.setAutoUpload(bool)
window.oz.cloudBackup.uploadNow(snapshotId)
window.oz.cloudBackup.listRemoteSnapshots(deviceFolder?)
window.oz.cloudBackup.listDevices()
window.oz.cloudBackup.downloadAndRestore({ snapshotId, deviceFolder? })
window.oz.cloudBackup.deleteRemote({ snapshotId, deviceFolder? })
window.oz.cloudBackup.onChanged(cb)         // event subscriber
```

## Gates

| Operación                                           | Vault gate         | Connected gate                               |
| --------------------------------------------------- | ------------------ | -------------------------------------------- |
| status                                              | —                  | returns `{notConfigured:true}` if no manager |
| connect / disconnect / setAutoUpload                | —                  | —                                            |
| uploadNow / listRemote / listDevices / deleteRemote | —                  | manager throws "not connected"               |
| downloadAndRestore                                  | **vault unlocked** | manager throws "not connected"               |

## Pre-restore safety

`downloadAndRestore` invoca `backupManager.createSnapshot({reason:'pre-restore'})` ANTES del flujo cloud. Si pre-restore falla → `PRE_RESTORE_FAILED`, NO se procede.

Si el restore propio falla post pre-restore, el error response incluye `preRestoreId` para que el user pueda rollback al state que tenía justo antes.

Post-restore: lock vault + broadcast `oz:vault:changed` + `oz:timemachine:changed` + `oz:cloud-backup:changed` + `oz:timemachine:restore-completed` (con `source: 'cloud'`, `deviceFolder`).

## Error codes

`NOT_CONFIGURED`, `BAD_ARG`, `LOCKED`, `CONNECT_FAILED`, `DISCONNECT_FAILED`, `SET_AUTOUPLOAD_FAILED`, `UPLOAD_FAILED` (+ inner code propagated), `LIST_REMOTE_FAILED`, `LIST_DEVICES_FAILED`, `PRE_RESTORE_FAILED`, `RESTORE_FAILED`, `DELETE_REMOTE_FAILED`.

## Broadcast

`oz:cloud-backup:changed` se emite en: disconnect, setAutoUpload, uploadNow (success), downloadAndRestore (success or fail), deleteRemote (success), y en `cloud-backup-setup.js` cuando el protocol dispatcher completa OAuth.
