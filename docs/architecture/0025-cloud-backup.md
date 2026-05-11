# ADR 0025 — Cloud backup architecture (Dropbox, D-1)

**Date:** 2026-05-10
**Status:** Accepted (implemented + 232 tests verde, visual smoke pendiente con vault unlocked)
**Bloque:** D-1 — Time Machine backup remoto + cross-device restore
**Predecesores:** ADR 0008 (vault + AES-256-GCM), 0023 (identities + workspaces), e2-b foundation (protocol handler `oz://`, OAuth helper PKCE + Keychain)

## Context

Time Machine (1.6) produce snapshots `.ozbackup` cifrados con AES-256-GCM usando la master key del Vault. Hoy viven solo en `userData/data/snapshots/`. Si Jose formatea la Mac, le roban el laptop, o se rompe el SSD → pierde toda la data (identities + workspaces + cookies + vault). Necesitamos replicación off-device.

Otro driver: Jose querrá eventualmente operar OZ desde múltiples Macs (la suya principal + Mac del team member). Sin replicación, cada Mac vive aislada — no se pueden mover identities entre devices.

Sub-Etapa 1B introduce Supabase pero solo para entitlements + auth. La storage de snapshots no encaja ahí: snapshots pesan MB y Supabase storage es caro vs un Dropbox personal free.

## Decision

Replicación de snapshots `.ozbackup` a una cuenta personal de Dropbox del user, con **per-device folder structure** y **zero-knowledge crypto** (Dropbox nunca ve plaintext — los `.ozbackup` ya son archivos cifrados standalone).

### 1. Estructura de carpetas

Cada instalación de OZ aterriza en su propia carpeta bajo el App Folder de Dropbox:

```
/Apps/OZ Browser/                       (root del App Folder; Scoped App)
  joses-macbook-pro-bff00ff9/           (← este device)
    snapshots/
      2026-05-10T22-00-00.000Z.ozbackup
      2026-05-10T03-00-00.000Z.ozbackup
      ...
  joses-macbook-pro-local-a1b2c3d4/     (otro device de Jose)
    snapshots/...
  team-member-mac-7f3d92a1/             (futuro team member)
    snapshots/...
```

`<device-folder>` = `${hostnameSlug}-${shortId}` donde:

- `hostnameSlug` = `os.hostname()` slugified — apóstrofes y comillas se DROPEAN antes de reemplazar resto con dashes (ej. "Jose's MacBook Pro (local)" → "joses-macbook-pro-local"), max 32 chars.
- `shortId` = primeros 8 chars (sin dashes) de un `crypto.randomUUID()` v4 generado al primer boot del .app y persistido en `userData/device-info.json`.

### 2. Por qué UUID + hostname y no MAC address o hostname solo

- **MAC address**: macOS hace Private Address Randomization → MAC inestable entre boots. Mala llave.
- **Hostname solo**: colisiona si dos Macs comparten nombre (team con plantilla MDM). El UUID local resuelve sin necesitar coordinación entre devices.
- **UUID solo**: ilegible cuando el user lista devices en el restore picker. El hostname-slug da contexto humano (el "macbook-pro" parte le dice de qué Mac es).
- **UUID solo + label override**: muy bien para v2. Por ahora mantenemos el slug como label implícito.

El UUID es local-only — NO se sube fuera de su propio archivo + path Dropbox, NO se loguea a servicios externos. No es identificador de tracking.

### 3. Zero-knowledge crypto: reuse del `.ozbackup`

ADR 0008 ya garantiza que `.ozbackup` es:

- Cifrado AES-256-GCM con la master key del Vault.
- Master key vive SOLO en Keychain (nunca toca disco fuera de Keychain).
- Header JSON visible (label, reason, timestamp, size) + body opaco.

Para cloud backup NO re-encriptamos. Subimos el `.ozbackup` tal cual. Resultado:

- Dropbox VE: filename, header JSON (timestamp, reason, size, fileCount).
- Dropbox NO VE: identities, cookies, accounts, workspaces, vault.enc.
- Compromise de Dropbox o de la cuenta de Jose → atacante consigue archivos cifrados con AES-256-GCM, sin la key.
- Compromise del Keychain de la Mac de Jose → atacante consigue la key. Vector más grande que Dropbox.

Decisión: no rotamos master key entre uploads. El threat model dice que el secret real (master key) ya vive en un hardware token (Secure Enclave-backed Keychain); cualquier crypto layer adicional encima del .ozbackup duplicaría complejidad sin reducir el ataque exitoso.

### 4. OAuth + token storage

Reusamos `browser/oauth-helper.js` (e2-b B-3):

- Auth endpoint: `https://www.dropbox.com/oauth2/authorize`
- Token endpoint: `https://api.dropboxapi.com/oauth2/token`
- PKCE flow → no client_secret embedded en .app (App Key sí, vía webpack DefinePlugin; Dropbox App es Scoped + "Allow public clients").
- `token_access_type=offline` → refresh_token retornado para auto-refresh.
- Scopes: `files.content.write`, `files.content.read`, `account_info.read`.
- Redirect URI: `oz://auth/dropbox/callback`.
- Tokens guardados en Keychain via `@napi-rs/keyring` (service `oz-browser-oauth`, account `dropbox`).

Refresh-on-401: catch del SDK Dropbox, si status === 401 → `refreshAccessToken` + retry una vez. Si refresh falla → clear tokens y throw `NEEDS_REAUTH` (UI muestra Connect button de vuelta).

### 5. Por qué NO usar el OAuth del SDK Dropbox

`dropbox@10.34.0` trae `DropboxAuth` que reimplementa PKCE + token mgmt, pero no se integra con `oauth-helper.js` ni con Keychain. Forzar dos implementaciones duplica superficie de bugs. Pasamos `accessToken` puro al `Dropbox(...)` constructor y manejamos refresh nosotros.

### 6. Auto-upload hook

`BackupManager` extiende `EventEmitter` (cambio quirúrgico — cero impacto en callers existentes) y emite `'snapshot-created'` después de cada `createSnapshot()` exitoso. CloudBackupManager listens y dispara `uploadSnapshot(id)` fire-and-forget si:

- `state.connected === true`
- `state.autoUpload === true`
- `header.reason !== 'pre-restore'` (se filtran para evitar amplificación — cada restore generaría ruido)

`pre-quit` SÍ sube (último snapshot antes de cerrar la app, queremos preservarlo si la Mac muere antes del próximo daily cron).

Toggle ON/OFF persistido en `userData/cloud-backup.json`. Default OFF — user opta in explícitamente.

### 7. Restore desde cloud (incluye cross-device)

Flujo `downloadAndRestore({snapshotId, deviceFolder?})`:

1. Vault gate (mismo que local restore — la master key tiene que estar disponible para descifrar el `.ozbackup`).
2. Pre-restore safety snapshot (mismo patrón que `backup-handlers.js` — el local restore ya lo hace).
3. Download `.ozbackup` del path Dropbox → escribe a `backupManager.snapshotsDir/${id}.ozbackup` (overwrite si existe; .ozbackup es content-addressable por timestamp y autenticado por AES-GCM authTag).
4. Invoke `backupManager.restoreSnapshot(id)` — flujo idéntico al local restore.
5. Lock vault + broadcast `oz:vault:changed` + `oz:timemachine:changed` + `oz:cloud-backup:changed`.
6. UI muestra el alert grande de "requires restart" (idéntico al local restore).

Cross-device: `deviceFolder` puede ser el folder de otra Mac. El restore prepara el local snapshotsDir con el archivo descargado y delega al mismo path. La master key del Vault (Keychain) tiene que existir EN ESTE device para que el restore funcione — recovery total post-format requiere ALGUNA forma de recuperar la master key (futuro: team mode con key-sharing Curve25519 en bloque E).

### 8. Trade-offs aceptados

| Trade-off                                                                                | Decisión       | Razón                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-device restore requiere Keychain del device origen presente en device destino      | Aceptado       | Zero-knowledge requiere que la key NO viaje. Bloque E (Team mode) implementará key-sharing voluntario via Curve25519.                                                                                              |
| Per-device folders pueden explotar si user reinstala OZ varias veces (cambia el shortId) | Aceptado v1    | shortId del UUID es estable mientras `userData` exista. Si el user wipea `userData` (que ya borra identities + workspaces + vault.enc), el nuevo shortId estrena folder limpio — es coherente con "device fresco". |
| Chunked upload no implementado para snapshots >150 MB                                    | Diferido a D-2 | Snapshots típicos de Jose < 50 MB. `filesUploadSession*` es deps-free pero ~150 LOC; D-2 lo agrega cuando justifique. Actualmente upload >140MB → throw `TOO_LARGE`.                                               |
| Free tier Dropbox = 2 GB                                                                 | Aceptado       | Snapshot ~50 MB × 30 daily + 4 weekly → ~1.7 GB. Retention policy del backup-manager (keep 30d + 1/week forever) ya cabe. Premium upgrade es decisión del user.                                                    |
| Production tier de Dropbox API requiere Apply (no automatizable)                         | Aceptado       | Development tier (250 user cap) cubre todos los betas. Apply post-validación, no-bloqueante para D-1.                                                                                                              |

### 9. NOT_CONFIGURED graceful degrade

Si `OZ_DROPBOX_APP_KEY` falta al build time (ej. build local sin `.env`), `cloud-backup-setup.js` deja `browser.cloudBackupManager = null`. Los IPC handlers devuelven `{notConfigured: true}` y la UI muestra disconnected view. App arranca normal — backup local sigue funcionando.

### 10. State persistido

`userData/cloud-backup.json`:

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

`disconnect()` resetea todo menos `autoUpload` (preferencia del user — si reconecta, el toggle vuelve a su último valor).

## Consequences

**Lograr:**

- DR completa: si Jose formatea la Mac, restaura `userData` desde Dropbox + ingresa password del vault (Keychain de la nueva Mac) → vuelve operativo.
- Multi-device awareness: ve cuántas Macs activas tiene + browsea snapshots de cada una.
- Auto-upload sin pensar en ello (toggle ON una vez).

**Cambios en otros sistemas:**

- `BackupManager` ahora extiende `EventEmitter` (anteriormente clase pura). Cero cambio comportamental para callers existentes.
- Nuevo channel IPC `oz:cloud-backup:*` (9 handlers) + nuevo broadcast `oz:cloud-backup:changed`.
- Nueva carpeta `userData/device-info.json` persistente.
- Nueva carpeta `userData/cloud-backup.json` persistente.

**Pendientes para D-2 / D-3 (sync engine):**

- Chunked upload para snapshots >150 MB.
- Sync engine ADR (conflict resolution + delta sync + offline queue).
- Probable evolución del estado a un per-folder cursor para listings incrementales.
