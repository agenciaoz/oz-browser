# Módulo `bookmark-manager`

**Path:** `browser/bookmark-manager.js`
**Líneas:** ~280
**Bloque:** 1.7b ✅ + D-4 mini b sync hook
**ADR:** [0016 — Tab context menu](../architecture/0016-tab-context-menu.md) (sección Bookmarks MVP)

## Qué hace

CRUD mínimo de bookmarks per-identity con persistencia en `~/Library/Application Support/<appName>/bookmarks.json`. Storage v1 — la página completa de gestión (search/edit/folders) llega en Bloque 1.10. Dedup por `(identityId, url)` — re-bookmark del mismo URL es no-op.

## Modelo

```js
{
  id: 'uuid-hex',          // crypto.randomBytes(8).toString('hex')
  identityId: 'string',    // owning identity
  url: 'string',           // navigable href
  title: 'string',         // display string
  favicon: 'dataURL'|null,
  addedAt: number,         // epoch ms
}
```

## API

| Método                                       | Descripción                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| `list({ identityId? })`                      | Array (copia), opcionalmente filtrado por identity.        |
| `get(id)`                                    | Bookmark por id o null.                                    |
| `findByUrl(identityId, url)`                 | Dedup helper.                                              |
| `add({ identityId, url, title?, favicon? })` | Crea + persiste. Dedup'd → `{...existing, deduped: true}`. |
| `addFromTab(tab)`                            | Extrae fields de un tab/tabSpec.                           |
| `remove(id)`                                 | Quita por id. Returns boolean.                             |
| `removeByIdentity(identityId)`               | Bulk purge cuando una identity se borra.                   |

## D-4 mini b — EventEmitter para sync (2026-05-13)

`BookmarkManager` ahora `extends EventEmitter` y emite `'changed'` después de `add` (no dedup'd), `remove`, y `removeByIdentity` (solo cuando algo se borró). Payload single-record:

```js
{ op: 'update', recordType: 'bookmark', recordId: 'all', updatedAt }
```

- **Bookmarks sincronizan como SINGLE record** (`recordId = 'all'`, body = collection entera). Único caso de full-file LWW en el sistema (identities y workspaces son per-record). Razón ADR 0026 §1: cardinalidad chica, low write rate, simpler.
- **Sidecar `bookmarks-sync-meta.json`** persiste `updatedAt` sin tocar el formato de `bookmarks.json` (cero migration risk para legacy installs). Atomic write tmp+rename. Schema `{schemaVersion: 1, updatedAt: ISO}`.
- **`getSyncRecord()`** retorna `{id: 'all', updatedAt, bookmarks: [...]}` para el sync engine. Defensive copy del array — mutaciones del caller no afectan al manager.
- **`getUpdatedAt()`** expone el stamp para introspection.
- **Legacy compat**: bookmarks.json sin sidecar → `_updatedAt = null`; `getSyncRecord()` backfill con nowIso() defensivamente.
- **Apply-remote sin loop** en [`bookmark-manager-sync.md`](bookmark-manager-sync.md). `applyRemoteUpsert` reemplaza la collection wholesale; `applyRemoteDelete` es no-op + warn (deleting "all bookmarks" no es una op de sync — round-trip como upserts del nuevo whole-collection state).

## Exports

| Símbolo               | Tipo  | Descripción        |
| --------------------- | ----- | ------------------ |
| `BookmarkManager`     | class | Manager principal. |
| `BOOKMARKS_RECORD_ID` | const | `'all'`.           |

## IPC

Registrado en `ipc-handlers.js` como `oz:bookmarks:*`.

## Dependencies

- `electron` (`app.getPath('userData')`)
- `crypto` (uuid)
- `events` (EventEmitter — D-4)
- `./logger`

## Storage

- `userData/bookmarks.json` — array de bookmark objects. Format unchanged across D-4.
- `userData/bookmarks-sync-meta.json` (D-4 mini b) — sidecar para `updatedAt`.

## Ver también

- [`bookmark-manager-sync.md`](bookmark-manager-sync.md) — apply-remote helpers.
- [`sync-setup.md`](sync-setup.md) — orchestrator wire-up.
- ADR 0026 §1 — single-record sync rationale.
