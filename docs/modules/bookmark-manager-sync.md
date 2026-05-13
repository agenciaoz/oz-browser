# Módulo `bookmark-manager-sync`

**Path:** `browser/bookmark-manager-sync.js`
**Líneas:** ~132
**Bloque:** D-4 mini b ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §1 (bookmarks full-file), §4 (pull-side apply)

## Qué hace

Standalone functions que aplican un remote bookmark collection al `BookmarkManager` sin disparar el push loop. **Único caso de single-record full-file sync** en el sistema (identities y workspaces son per-record).

## Modelo: single-record full-file LWW

A diferencia de identities/workspaces que sincronizan por record individual, bookmarks viajan como **una sola entidad** — recordId = `'all'`, body = collection completa. LWW se decide sobre el header timestamp del archivo entero. Razón (per ADR §1): cardinalidad chica (<100 bookmarks), low write rate, simpler.

## Exports

| Símbolo                                      | Tipo     | Descripción                                                 |
| -------------------------------------------- | -------- | ----------------------------------------------------------- |
| `applyRemoteUpsert(bm, body)`                | function | Replace local collection. Retorna `{op, count}` o null.     |
| `applyRemoteDelete(bm, recordId, deletedAt)` | function | **No-op + warn** — bookmarks no tienen tombstone semantics. |
| `BOOKMARKS_RECORD_ID`                        | const    | `'all'`.                                                    |

## Contracto

- **NO emite `'changed'`** (corta el loop).
- **SÍ emite `'remote-applied'`** en el manager — `{op: 'update', recordType: 'bookmark', recordId: 'all', count, updatedAt}`.
- **Validation**: rechaza null body / wrong recordId (`!== 'all'`) / non-array bookmarks.
- **Defensive entry filtering**: entries que no son objetos o que faltan `id/identityId/url` se descartan silenciosamente (warn con dropped count). Evita corromper local state con bytes raros.
- **updatedAt backfilled** a nowIso() si missing/malformed.
- **bm.bookmarks reemplazado wholesale** — la collection local es overwritten con la remote.
- **applyRemoteDelete es no-op intencional**: borrar "todos los bookmarks" no es una op normal de sync — los removes individuales viajan como upserts del whole-collection state (sin la entry eliminada). Un user que limpia sus bookmarks publica un body vacío, no un tombstone.

## Side effects en BM

1. `bm.bookmarks[]` reemplazado wholesale.
2. `bm._updatedAt` set desde `body.updatedAt`.
3. `bm._save()` (escribe `bookmarks.json`).
4. `bm._saveMeta()` (escribe `bookmarks-sync-meta.json` sidecar).
5. `bm.emit('remote-applied', payload)`.

## Tests

49 assertions en `tests/bookmark-manager-sync.smoketest.js`. Cubre: EventEmitter wiring, add/remove/removeByIdentity stamp+emit + no-op cases, sidecar meta file persistence cross-instance, getSyncRecord() shape + defensive copy, applyRemoteUpsert replaces local + no 'changed' emit, validation (null body / wrong recordId / non-array), drops malformed entries, updatedAt backfill, applyRemoteDelete no-op + warn, legacy bookmarks.json (no sidecar) loads OK + nowIso fallback.

## Gotchas

- `bm._updatedAt` empieza `null` para legacy installs (bookmarks.json existe pero sidecar no). `getSyncRecord()` backfills con nowIso() defensivamente; pero esto significa que el primer push remoto va a usar el momento actual como timestamp, no la fecha real del último cambio. Aceptable trade-off para evitar migration.
- El `getSyncRecord()` retorna una copia defensiva del array — mutar el resultado no afecta el manager.
- `applyRemoteDelete` retorna null SIEMPRE — los callers chequean para distinguir de un apply real.
