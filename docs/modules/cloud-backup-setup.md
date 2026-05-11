# `browser/cloud-backup-setup.js`

**Bloque:** D-1.7
**ADR:** [0025 Cloud backup architecture](../architecture/0025-cloud-backup.md)
**Tests:** smoke boot validation (no dedicated unit test — pure wiring)

## Qué hace

Extraído de `main.js` por ADR 0005 (LOC budget). Wireado del cloud backup stack:

1. DeviceInfo (always, even sin Dropbox app key).
2. DropboxClient (solo si `OZ_DROPBOX_APP_KEY` presente al build time via DefinePlugin).
3. CloudBackupManager (con auto-upload listener).
4. Protocol dispatcher para `oz://auth/dropbox/callback`.

## API

```js
const { setupCloudBackup } = require('./cloud-backup-setup')
const { deviceInfo, cloudBackupEnabled } = setupCloudBackup(browser)
```

Llamar DESPUÉS de:

- `browser.backupManager` instanciado (auto-upload listener depende).
- `installProtocolHandler(browser)` (registerProtocolDispatch necesita el handler montado).

Llamar ANTES de `registerIpcHandlers(browser)` — los IPC handlers leen `browser.cloudBackupManager`.

## Side effects

- `browser.deviceInfo` (always)
- `browser.dropboxClient` (or null si no app key)
- `browser.cloudBackupManager` (or null si no app key)
- Listener `oz:cloud-backup:changed` broadcast en completeConnect success/fail.

## NOT_CONFIGURED path

Sin `OZ_DROPBOX_APP_KEY`:

- WARN log explícito en boot ("cloud backup disabled").
- `cloudBackupManager = null` → IPC `status` devuelve `notConfigured: true`.
- App arranca normal; backup local sigue funcionando.
- Protocol dispatcher NO se registra → `oz://auth/dropbox/callback` cae a "no-dispatcher" si llega (impossible flow ya que el button "Connect" tampoco existe en este path).
