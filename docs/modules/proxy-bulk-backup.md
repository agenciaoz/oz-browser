# Módulo `proxy-bulk-backup`

**Path:** `browser/proxy-bulk-backup.js`
**Líneas:** ~135
**Bloque/Etapa:** H-2 extras (v1.1.6)

## Qué hace

Snapshot del proxy pool a disk antes de bulk operations destructivas (delete, disable). Si el user se equivoca de selección y borra 50 proxies, el snapshot queda accesible para restore manual.

## Storage

```
userData/proxy-bulk-backups/
  2026-05-15T22-32-35-688Z.json
  2026-05-15T22-15-12-104Z.json
  ...
```

Cada blob:

```json
{
  "ts": "2026-05-15T22:32:35.688Z",
  "reason": "bulk-delete",   // or 'bulk-disable' | 'bulk-other'
  "ids": ["p1", "p2", ...],   // ids being acted on
  "proxies": [/* full proxy records snapshot from proxyManager.list() */]
}
```

Retention: últimos `MAX_KEPT=20` backups. Prune automático post-snapshot.

## API factory

```js
const bk = buildProxyBulkBackup({
  proxyManager, // required — .list() returns records to snapshot
  userDataDir, // required — base dir for snapshots subdir
  now, // optional — () => Date, injectable for tests
})

bk.snapshot({ reason, ids })
// → { ok: true, path, count, ts, reason }
// → { ok: false, reason: 'NO_PROXY_MANAGER' | 'WRITE_FAILED', message? }

bk.list()
// → [{ ts, reason, count, idsCount, path }, ...] newest-first

bk.pruneOldBackups()
// → { kept, deleted }
```

`snapshot()` NUNCA throws — backup failures no bloquean la op real (defensive UX: mejor ejecutar la op sin backup que negar la acción al user).

## Wire en consumers

**`browser/proxy-actions-bulk.js`** — factory accepts optional `bulkBackup`:

```js
async function bulkDeleteProxies(ids) {
  const backup = bulkBackup ? bulkBackup.snapshot({ reason: 'bulk-delete', ids }) : null
  const r = await _runSequential(ids, 'bulkDeleteProxies', ...)
  if (backup) r.backup = backup
  return r
}

async function bulkSetDisabled(ids, disabled) {
  // Solo snapshot al deshabilitar (flag=true).
  const backup = flag && bulkBackup ? bulkBackup.snapshot({ reason: 'bulk-disable', ids }) : null
  ...
}
```

**`browser/ipc-handlers-extra.js`** — singleton on browser instance:

```js
if (!browser._proxyBulkBackup) {
  const { app } = require('electron')
  browser._proxyBulkBackup = buildProxyBulkBackup({
    proxyManager: browser.proxyManager,
    userDataDir: app.getPath('userData'),
  })
}
```

## IPC

| Channel                   | Returns          |
| ------------------------- | ---------------- |
| `oz:proxyBulkBackup:list` | array de entries |

## Restore

NO hay UI de restore en v1.1.6. El path se loguea + viene en `r.backup.path` del bulk result. User puede inspeccionar/restaurar manualmente. Auto-restore deferred — merge logic con post-backup creates es delicada (proxy IDs pueden colisionar) y queremos pensarlo bien.

## Tests

`tests/proxy-bulk-backup.smoketest.js` — **9 asserts**: factory guards (throws sin userDataDir), snapshot happy + JSON shape, defensive (no proxyManager → ok:false, broken proxyManager → ok:false caught), list shape, pruneOldBackups respeta MAX_KEPT cap.

## Gotchas

- ISO timestamp filename con `:` y `.` reemplazados por `-` para FS compatibility.
- `ids.slice(0, 1000)` en payload — cap defensive para no escribir blobs gigantes si alguien pasa 50K ids.
- Prune corre post-snapshot — un backup nuevo siempre se persiste antes de podar los viejos.
