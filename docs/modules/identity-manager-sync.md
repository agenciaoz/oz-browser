# Módulo `identity-manager-sync`

**Path:** `browser/identity-manager-sync.js`
**Líneas:** ~156
**Bloque:** D-3c-3a ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §4 (pull-side apply)

## Qué hace

Standalone functions que aplican un remote record a un `IdentityManager` SIN emitir `'changed'`. Es el bridge que el sync host (sync-setup.js) usa para landear cambios remotos sin disparar el loop infinito remote → local → push → remote.

Vive como módulo separado porque `identity-manager.js` ya está cerca de 500 LOC. Los helpers se usan únicamente en el wire-up del sync layer.

## Exports

| Símbolo                                      | Tipo     | Descripción                                                    |
| -------------------------------------------- | -------- | -------------------------------------------------------------- |
| `applyRemoteUpsert(im, record)`              | function | Apply remote record. Retorna `{op, identity}` o null.          |
| `applyRemoteDelete(im, recordId, deletedAt)` | function | Idempotent tombstone apply. Retorna `{op, identityId}` o null. |

## Contracto

- **NO emite `'changed'`** (cortaría el loop con sync-engine).
- **SÍ emite `'remote-applied'`** en el manager — payload `{op, recordType, recordId, identity? | deletedAt}`. UI consumers que quieren saber de TODOS los cambios (local + remote) deben escuchar AMBOS eventos.
- **Default identity siempre rechazada** (id === 'default'). Es per-device singleton, no sync.
- **`isDefault` forzado a false** en upsert (remote upload nunca puede claim Default).
- **`updatedAt` backfilled** a nowIso() si missing/malformed.
- **In-place mutation** de `im.identities[]` — preserva references que el host pueda tener.
- **Listener throws aislados** con try/catch — no rolean back state ya persistido.
- **sessionCache invalidado** en delete (matching IM.remove behavior).

## Side effects en IM

1. `im.identities` mutado (push o in-place replace).
2. `im._save()` llamado (persist a `identities.json`).
3. `im.sessionCache.delete(id)` en apply delete.
4. `im._fireWorkspaceSync()` en create + delete (mantiene `workspace.identityIds[]` sincronizado via el host hook).
5. `im.emit('remote-applied', payload)`.

## Tests

39 assertions en `tests/identity-manager-sync.smoketest.js`. Cubre: create / update / delete happy paths; Default rejection en upsert y delete; validation (null record / missing id / non-string id); updatedAt backfill; remote isDefault forced to false; workspaceSyncHook fires; throwing 'remote-applied' listener no rompe la apply; sessionCache invalidado en delete.

## Gotchas

- El módulo asume que el host TIENE referencia a una instancia ya construida de IM. No instantia nada.
- Si el record body tiene fields no whitelisted (e.g. extra metadata), van a sobrevivir al apply (Object.assign los copia). Sanitization más estricta queda en applyRemote del workspace manager (que sí restringe).
