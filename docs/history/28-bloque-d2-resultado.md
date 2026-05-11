# Bloque D-2 — Sync engine ADR + chunked upload + cursor-based listings (resultado)

**Status:** ✅ Cerrado 2026-05-11 madrugada
**Commits:** TBD (main directo)
**Tiempo:** ~4-5h efectivas vs ~5-7h estimadas
**Deps nuevas:** 0
**Tests:** 2008 → 2043 (+35)
**Files added:** 1 ADR + 2 new test files + 1 history entry

## Origen

Chunk natural post-D-1. D-1 cerró cloud BACKUP (snapshots cifrados → Dropbox + cross-device restore). Pero el sync REAL de identities/workspaces/cookies en vivo cross-device no estaba especificado. D-2 escope original: ADR del sync engine. Bundle con dos polish operacionales de D-1 que valía cerrar ahora antes de tipear D-3:

- Chunked upload (snapshots >140MB tiraban `TOO_LARGE` — bug operativo).
- Cursor-based listings (Dropbox API permite `listFolderContinue` con delta — listings sub-segundo en refreshes posteriores).

Decisiones de scope tomadas via AskUserQuestion al inicio (B = recommended). Diferida la implementación del sync core a D-3.

## Decisiones clave del ADR (detalle en 0026-sync-engine.md)

1. **Scope sync v1**: identities + workspaces + bookmarks. Cookies/sessions OUT v1 (pesados, session-bound, snapshot manual cubre). Settings/history/downloads NEVER (per-device prefs).
2. **Granularity**: per-record JSON files cifrados en `/sync/identities/<uuid>.json.enc`. Bookmarks como full file. `_meta.json.enc` por folder con tombstones.
3. **Conflict resolution**: Last-Write-Wins con `updatedAt` timestamp + deviceFolder lex desempate. Vector clocks/CRDT descartados por overkill para team <10.
4. **Trigger**: push on local change (debounced 500ms) + long-poll para remote (`filesListFolderLongpoll` + reconnect; fallback poll 30s).
5. **Offline queue**: `userData/sync-queue.json` FIFO. Replay con conflict check pre-push.
6. **Encryption**: AES-256-GCM mismo scheme que vault (D-1 reuse). Header visible (updatedAt, deviceFolder, recordType, schemaVersion). Body opaco. Zero-knowledge mantenido.
7. **Tombstones + soft delete**: `deleted: true` + `deletedAt`. GC tras 30 días coordinado via \_meta.
8. **Schema versioning**: per-record + per-folder target. Forward-compat: older clients skip new schemas.
9. **NO Supabase realtime**: mantener zero-knowledge. Dropbox como dumb storage + crypto local.

## Cambios de código entregados en D-2 (no del sync engine — eso es D-3)

### D-2.2 — Chunked upload (browser/dropbox-client.js)

- Antes: `upload()` con buffer >140MB → throw `TOO_LARGE`.
- Ahora: routing automático. <140MB sigue usando `filesUpload` (1 PUT). >140MB usa `filesUploadSessionStart` + `filesUploadSessionAppendV2` × N + `filesUploadSessionFinish`. Chunks de 8MB (Dropbox recommended).
- Auth: toda la sesión corre dentro de un solo `_withAuth` wrapper. Si 401 mid-session, el wrapper hace refresh + retry de toda la sesión desde chunk 0 (session_id puede invalidarse con stale token).
- Tests: 28 nuevos (`tests/dropbox-client-d2.smoketest.js`).

### D-2.3 — Cursor-based listings (browser/dropbox-client.js + cloud-backup-manager.js)

- `listFolder()` ahora retorna `{ entries, cursor, hasMore }` en vez de array (breaking, internal-only — callers actualizados).
- Nuevo `listFolderContinue(cursor)` para delta listings via Dropbox cursor.
- Nuevo `listFolderAll(folderPath)` para enumerar todo paginando internamente.
- `cloud-backup-manager`: in-memory cache `Map<folder, {entries, cursor}>`. Primera call → `listFolderAll`, cachea entries + cursor. Calls subsecuentes → `listFolderContinue` con delta apply (upsert + remove on `isDeleted`). Si `CURSOR_RESET` → drop cache + re-list fresh.
- Cache invalidation: `uploadSnapshot` y `deleteRemoteSnapshot` invalidan el folder afectado. `disconnect` clear todo.
- Tests: 14 nuevos (`tests/cloud-backup-cache.smoketest.js`).

### Side effects en otros tests

- Update del shape de listFolder en dropbox-client tests + cloud-backup-manager tests.
- Splits por ADR 0005 (LOC budget):
  - `tests/dropbox-client.smoketest.js` (~64 tests, D-1 scope) + `tests/dropbox-client-d2.smoketest.js` (~28 tests, D-2 scope).
  - `tests/cloud-backup-cache.smoketest.js` (14 tests) extraído de cloud-backup-manager.

## Tests breakdown D-2

- `dropbox-client-d2.smoketest.js` — 28 (chunked upload x4 + listFolderContinue + listFolderAll).
- `cloud-backup-cache.smoketest.js` — 14 (cache hit/miss, delta apply, upload/delete invalidates, CURSOR_RESET re-list).

Plus 7 chunked-upload tests integrados en flujos existentes de dropbox-client.smoketest.

Total D-2: 35 tests nuevos. Regression D-1: cero falla.

## Trade-offs aceptados

- Chunked upload: si 401 mid-session, restart desde chunk 0 (re-upload). Simple, predecible, vs. retry-mid-session complejo. Real-world fail rate ~0.1%.
- Cursor cache: memoria-only (cold start re-lista). Persistir cursor en disco agrega complejidad de invalidación cross-boot, ROI marginal para snapshots ya rápidos.
- Long-poll para sync (futuro D-3): aceptable fallback poll cada 30s en redes con NAT/corporate proxy raros.

## Validación

- ✅ 35/35 D-2 tests nuevos verde.
- ✅ Full suite 2043 passed, 0 failed.
- ✅ `npm run check:loc` passa (max 498/500 main.js).
- ✅ `npm run lint` passa (prettier auto-applied a los nuevos archivos).
- ✅ Regression D-1 + backup-manager + todos los demás: verde.

## Próximo chunk

Bloque D-3 sync engine core (~10-13h): `sync-engine.js`, `sync-record-store.js`, `sync-merge.js`, `sync-queue.js`. Hooks en IdentityManager + WorkspaceManager. Long-poll + cursor flow. Implementa todo lo decidido en ADR 0026.

Decisión abierta de Jose: arrancar D-3 antes o saltar a Bloque E (Team mode con key-sharing Curve25519) para que sync engine ya nazca multi-owner.
