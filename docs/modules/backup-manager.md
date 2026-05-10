# Módulo `backup-manager`

**Path:** `browser/backup-manager.js`
**Líneas:** ~452
**Bloque/Etapa:** 1.6a (Time Machine)

## Qué hace

Snapshots completos del `userData` (configs + `vault.enc` + `Partitions/*` con cookies, IndexedDB, localStorage, service workers) a archivos `.ozbackup` cifrados con la master key del Vault. Sirve como red de seguridad pre-OVERWRITE_TOTAL del Excel import (1.5e), pre-quit, daily 3am, y manual on-demand. Cero deps nuevas — solo `crypto` + `zlib` nativos + walk recursivo manual.

## Formato `.ozbackup` (versión 1)

```
| u32 LE headerLen | headerJson (utf-8) |
| iv (12B) | authTag (16B) | ciphertext = AES-256-GCM(gzip(flatpack(payload))) |
```

Header JSON visible (no cifrado) para listar metadatos sin descifrar:

```json
{
  "format": "ozbackup",
  "version": 1,
  "createdAt": "2026-05-10T03:02:07.163Z",
  "label": "smoke test 1",
  "reason": "manual",
  "vaultVersion": 1,
  "uncompressedBytes": 524288,
  "compressedBytes": 29571,
  "fileCount": 196,
  "appVersion": "0.1.0"
}
```

### FlatPack format (uncompressed payload)

Concat de `[u32 LE pathLen][pathBytes UTF-8 posix][u32 LE contentLen][contentBytes]` por cada file, terminado con `[0][0]`. Decodificación es lineal y predictible.

Decisión vs `tar`: cero deps + simple parser de 30 LOC + zero-overhead. Trade-off: incompatible con tools tar standard (no inspeccionable con `tar -tvf`), pero el `.ozbackup` es opaco al user (cifrado).

## API de `BackupManager`

| Método                            | Returns                                              | Descripción                                               |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `createSnapshot({label,reason})`  | `{id, filePath, header}` o throws                    | LOCKED si vault no unlocked.                              |
| `listSnapshots()`                 | array sorted newest-first (no decrypt — header only) | Cheap. Itera `snapshots/`, lee headerLen + headerJson.    |
| `restoreSnapshot(id)`             | `{ok, restoredCount, header}` o throws               | LOCKED / NOT_FOUND / BAD_FORMAT / DECRYPT_FAILED.         |
| `deleteSnapshot(id)`              | `bool` (false si no existía)                         | Permanente (no Trash).                                    |
| `applyRetention({keepDailyDays})` | `{deletedCount, deletedIds}`                         | Keep all últimos N días + 1 por ISO week para más viejos. |

## Triggers (1.6b)

| Trigger               | Where wired                                          | Vault locked? |
| --------------------- | ---------------------------------------------------- | ------------- |
| `manual`              | `Cmd+Shift+B` (menu.js) + UI button                  | Skip silently |
| `pre-quit`            | `before-quit` hook en `main.js`                      | Skip silently |
| `pre-overwrite-total` | Hook en `excel-handlers.OVERWRITE_TOTAL`             | Skip + warn   |
| `pre-restore`         | Auto en `backup-handlers.restore`                    | Required      |
| `daily-3am`           | `Browser._installBackupCron()` setInterval cada hora | Skip silently |

Pre-restore es **obligatorio** — si no se puede crear el snapshot de seguridad, el restore aborta con `PRE_RESTORE_FAILED`.

## Storage

```
~/Library/Application Support/OZ Browser/data/snapshots/<id>.ozbackup
```

Donde `id` = ISO timestamp con `:` y `.` reemplazados por `-` (filesystem-safe en macOS, Linux y Windows). Ej: `2026-05-10T03-02-07-163Z`.

## Reusa master key del Vault

`Vault.getMasterKey()` (1.5a, agregado en 1.6) devuelve la key (32 bytes Buffer) si unlocked, null si locked. El BackupManager nunca toca el Keychain directamente — solo el Vault. **Single point of recovery: el user solo cuida el Keychain**.

## Retention policy: keep daily Nd + weekly forever

`applyRetention({keepDailyDays: 30})`:

1. Snapshots con `createdAt >= now - 30d` → keep all.
2. Snapshots más viejos → group by ISO week (función `isoWeek()` UTC-safe).
3. Por cada week con >1 snapshot, keep the newest (mayor `createdAt`), delete the rest.

Ejemplo: 4 snapshots, 1 reciente + 2 mismas-semana viejos + 1 semana-distinta vieja → deletedCount=1.

## Tests

`tests/backup-manager.smoketest.js` — **40/40** verde cubriendo:

- FlatPack round-trip (incluye binary content).
- AES-GCM bytes round-trip + tamper detection.
- LOCKED si vault locked.
- createSnapshot escribe `.ozbackup` con header válido.
- listSnapshots lee headers sin descifrar, sorted newest-first.
- restoreSnapshot recrea estructura **bit-perfect** (sha256 hash de cada file pre/post).
- LOCKED + NOT_FOUND.
- deleteSnapshot.
- Retention policy: keep daily Nd + 1 weekly para older.
- isoWeek UTC-safe (no se rompe en zonas horarias negativas).

## Cloud backup futuro (C-19, post-Etapa 7-OFFICE)

El formato `.ozbackup` es **file-standalone** y **cifrado client-side** — se puede subir tal cual a Dropbox/Supabase sin re-encrypting. Backend cloud nunca ve plaintext (zero-knowledge), header JSON visible permite listar/buscar snapshots remotos sin descargar el body. Compromise de Dropbox no compromete data — master key sigue local en Keychain. Servicio premium diferenciador vs Ghost. Ver memoria del proyecto.

## Gotchas

- **Memoria**: snapshots grandes se buildan in-memory (Buffer.concat). Para userData típico (cookies + JSON) entre 5-50MB. Si Partitions/\* tiene caches enormes (>500MB), considerar streaming version (post-v1).
- **Restore destructivo**: sobrescribe files in-place sin staging atómico. La safety net es el pre-restore snapshot. Si el restore se interrumpe a mitad, userData puede quedar mixto — restore desde el pre-restore para recuperar.
- **Daily cron**: si OZ está cerrado a las 3am, el snapshot se pierde ese día. El próximo boot >3am del día siguiente lo retomará. NO se hace catch-up retroactivo (decisión consciente — evita ruido).
- **Pre-quit silencioso**: no se intenta unlock al apagar. Si el user nunca hizo unlock en la sesión, no hay snapshot pre-quit.

## Referencias

- [`backup-handlers.md`](backup-handlers.md) — handler map IPC↔MCP + auto pre-restore.
- [`account-vault.md`](account-vault.md) — fuente de la master key.
- [ADR 0008](../architecture/0008-account-vault-encryption.md) — decisión crypto.
