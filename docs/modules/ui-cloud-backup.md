# `browser/ui/cloud-backup.js`

**Bloque:** D-1.6
**ADR:** [0025 Cloud backup architecture](../architecture/0025-cloud-backup.md)

## Qué hace

Modal renderer-side para Cloud Backup. Mismo patrón que `time-machine.js` (1.6c) / `account-manager.js` (1.5f). Markup en `webui.html#oz-cb-modal`. Singleton expuesto en `window.OZ.CloudBackup` con API `open()` / `close()`.

## Vistas

| View           | Cuándo                       | Contenido                                                                                                     |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `disconnected` | `status.connected === false` | Banner explicativo + botón "Connect Dropbox"                                                                  |
| `connected`    | `status.connected === true`  | Account email + deviceFolder + autoUpload toggle + lastUpload status + lista de devices con cards expandibles |

## Entry point

Botón `oz-tm-cloud-btn` en el toolbar de Time Machine. Se monta SOLO cuando el vault está unlocked (la toolbar live-view).

## Device cards

Cada device se renderiza como card. Current device tiene border accent + label "(this device)". `snapshotCount === 0` deshabilita el toggle "Browse snapshots". Click en toggle hace `listRemoteSnapshots(deviceFolder)` y expande inline.

## Snapshot row

`{ id, sizeBytes, when }` + acciones Restore + Delete. Restore confirm dialog menciona explícitamente si viene de otro device. Delete pide confirmación irreversible.

## Eventos

Suscribe a `window.oz.cloudBackup.onChanged()` → refresh full state. Disparado por:

- Boot del Dropbox OAuth completeConnect (via protocol dispatcher → main.js → broadcast).
- disconnect / setAutoUpload / uploadNow / downloadAndRestore / deleteRemote.

## Interacción cross-modal

Cuando el user click "Connect Dropbox", el browser default abre Dropbox auth en una tab. Mientras se autoriza, mostramos hint info banner. El completeConnect happens out-of-band → broadcast → refresh automático del modal.

## Restore confirm copy

Específico: menciona "another device" si `deviceFolder !== status.deviceFolder`. Aclara que crea pre-restore safety snapshot, que reemplaza state actual, y que requiere restart post-restore.
