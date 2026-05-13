# ADR 0026 — Sync engine (D-2)

**Date:** 2026-05-10
**Status:** **Implemented** (D-3a → D-4 mini b, commits `d2b947e` → `befc354`, 2026-05-13). Internal layer feature-complete for identities + workspaces + bookmarks. main.js wire-up + real long-poll deferred to D-3c-3c/d (require live validation).
**Bloque:** D-2 — ADR sync engine + chunked upload + cursor-based listings
**Predecesores:** ADR 0008 (vault + AES-256-GCM), ADR 0023 (identities + workspaces), ADR 0025 (cloud backup — folder layout + zero-knowledge crypto)

## Implementation map (added 2026-05-13)

| §                | Module                                                                 | Commit    | Notes                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| §3 LWW merge     | `browser/sync-merge.js`                                                | `d2b947e` | Pure logic, no I/O. 40 tests.                                                                                          |
| §7 record format | `browser/sync-record-store.js`                                         | `d2b947e` | AES-256-GCM, mirrors D-1 backup format. 39 tests.                                                                      |
| §4 push trigger  | `IdentityManager extends EventEmitter` (`browser/identity-manager.js`) | `d2b947e` | Emits `'changed'` per CRUD. 24 tests.                                                                                  |
| §5 offline queue | `browser/sync-queue.js`                                                | `f2767f6` | FIFO + coalesce by (recordType, recordId). 63 tests.                                                                   |
| §4 push side     | `browser/sync-engine.js`                                               | `b752104` | Drain loop + backoff + race-safe conditional remove. 63 tests.                                                         |
| §4 pull side     | `browser/sync-pull.js`                                                 | `0fa12dc` | Cursor + LWW merge + `'remote-apply'` events. Persisted in `userData/sync-state.json`. 59 tests.                       |
| §4 apply side    | `browser/identity-manager-sync.js`                                     | `d18b84a` | `applyRemoteUpsert/Delete` — does NOT emit `'changed'` (cuts the loop). 39 tests.                                      |
| §4 wire-up       | `browser/sync-setup.js`                                                | `f9fecdc` | `setupSync({...}) → {engine, puller, queue, start, stop, pullNow}`. End-to-end Alice→Bob round-trip in test. 29 tests. |
| Workspace sync   | `WorkspaceManager` + `workspace-manager-sync.js`                       | `9b69776` | `tabSpecs` / `activeTabId` stripped on push AND apply (privacy carveout §1). 55 tests.                                 |
| Bookmark sync    | `BookmarkManager` + `bookmark-manager-sync.js`                         | `befc354` | Single-record full-file LWW (recordId='all'). Sidecar `bookmarks-sync-meta.json` for `updatedAt`. 49 tests.            |

**Deferred (per ADR §15 + new):**

- main.js wire-up via `setupSync(...)` — instantiate Vault + DropboxClient + IM/WM/BM + start the loops. Requires live validation (`npm start`).
- Long-poll connection via `filesListFolderLongpoll` — current implementation polls `listFolderContinue` every 30s. Real long-poll cuts remote→local lag to <10s.
- Tombstone GC sweep (§9) — 30-day retention enforcer.
- DR drill — wipe local, recibe full state via initial sync cold-start.

**Aceptados como diverge respecto al ADR original:**

- §4 "conflict pre-flight via filesGetMetadata" — NOT implemented. Push side just overwrites; LWW resolves on the pull side. The race window is narrow and tolerable for team <10.
- §2 storage layout: bookmarks live at `/sync/bookmarks/all.json.enc` (folder with one entry) rather than `sync/bookmarks.json.enc` (loose file) — keeps the engine treatment uniform.

## Context

D-1 cerró cloud BACKUP — snapshots `.ozbackup` cifrados replicados a Dropbox, restore cross-device end-to-end. Eso cubre DR (formateo / robo / SSD muerto) y restore manual desde otro device. Pero NO cubre el caso de team:

> Jose (owner) crea una identity nueva "IG client X" en su MacBook a las 10am. Maria (team member) en su Mac iMac quiere abrir esa identity a las 10:05am. Sin sync, ella tiene que pedirle a Jose que tome un snapshot manual + uploadee + ella restore-from-cloud + restart. UX inviable.

Sync engine: identities + workspaces + bookmarks viajan automáticamente entre devices del mismo team account, con conflict resolution definida y zero-knowledge crypto.

Cookies + history quedan FUERA del sync v1 — son pesadas (MBs por identity), session-bound, y la mayoría del team no las necesita compartir. El snapshot backup (D-1) sigue siendo el path para mover sessions en raras ocasiones.

Settings + downloads + proxies se quedan locales — son preferencias por device, no shared state.

## Decision

### 1. Scope del sync v1

| Recurso               | Sync v1  | Granularity                       | Razón                                                 |
| --------------------- | -------- | --------------------------------- | ----------------------------------------------------- |
| Identities            | ✅       | per-record (1 file per identity)  | High write rate; conflict-prone; needs per-record CR  |
| Workspaces            | ✅       | per-record (1 file per workspace) | Mismo perfil que identities                           |
| Bookmarks             | ✅       | full file                         | Cardinalidad chica (<100), low write rate, simpler    |
| Cookies (Partitions/) | ❌ v1    | n/a                               | MBs por identity, session-bound, riesgo logout chains |
| Proxies               | ❌ v1    | n/a                               | Per-device infra (latency, location preferences)      |
| Fingerprints          | ❌ v1    | n/a                               | Cached profiles, regen barato                         |
| Settings              | ❌ never | n/a                               | Per-device UI prefs por design                        |
| History / Downloads   | ❌ never | n/a                               | Local-only por privacy                                |

Cookies sync entra en D-4 polish solo si hay caso real. La mayoría del team comparte identities (= cuentas + auth data en vault), no sessions.

### 2. Storage layout en Dropbox

```
/Apps/OZ Browser/                        (Scoped App Folder)
  <device-folder>/snapshots/...          (D-1 backup, sin cambio)

  sync/                                  (D-2/D-3 nuevo)
    identities/
      <identity-uuid>.json.enc           (cifrado AES-256-GCM)
      ...
      _meta.json.enc                     (lista de IDs + tombstones + cursor)
    workspaces/
      <workspace-uuid>.json.enc
      ...
      _meta.json.enc
    bookmarks.json.enc                   (full file, sin _meta)

  team/                                  (bloque E, no D-2)
    members.json.enc
    wrapped-keys/<member-pubkey>.bin

  state/                                 (D-3 opcional)
    sync-state.json.enc                  (last cursor por folder, schema version)
```

`<uuid>` = el ID interno del record (ej. el `id` field de identity en `identities.json` local). NO el deviceFolder. Esto es global state compartido por todo el team.

`.json.enc` = AES-256-GCM con master key del vault. Header JSON visible incluyendo `updatedAt`, `deviceFolder`, `schemaVersion`, `recordType`. Body cifrado.

`_meta.json.enc` lista IDs + tombstones por folder. Permite enumerar records borrados sin tener que listFolder con todos los tombstone files físicos.

### 3. Conflict resolution: Last-Write-Wins con device-id desempate

Cada record file lleva en su header:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-11T10:00:23.456Z",
  "deviceFolder": "joses-macbook-pro-bff00ff9",
  "recordType": "identity",
  "recordId": "abc123",
  "deleted": false
}
```

**Merge rule:**

1. Si `local.updatedAt > remote.updatedAt` → keep local, push.
2. Si `local.updatedAt < remote.updatedAt` → overwrite local con remote.
3. Si `local.updatedAt === remote.updatedAt` → desempate por `deviceFolder` lex order (ascendente; el más bajo gana). Idempotente entre devices, sin necesidad de coordination.
4. Si `local.deleted && remote.deleted` → ambos lados de acuerdo, GC ambos tras 30 días.
5. Si `local.deleted XOR remote.deleted` → el más nuevo gana. Edit posterior a delete → record renace (raro pero coherente).

**Lost-update risk:** dos editores concurrentes en distintos devices → el segundo en escribir pisa al primero. Aceptable para team chico (<5 personas) editando cuentas sociales — typical conflict rate = casi cero.

**Por qué no vector clocks o CRDT:**

- Vector clocks: overhead lineal con número de devices, complejidad alta, beneficio mínimo para team chico.
- CRDT (auto-merge fields): obligaría rediseñar identity/workspace data model como deltas/operations. ROI bajo para v1.
- LWW cubre el 95% — los casos edge (2 personas editando la misma identity dentro de 1s) son raros y resolubles por re-edit manual.

### 4. Trigger: push on change + poll para remote

**Local → Remote (push):**

- IdentityManager / WorkspaceManager emiten event `'changed'` al persistir. Hook del sync engine:
  - Capturar `updatedAt = new Date().toISOString()` antes de persist local.
  - Encrypt record + upload con `mode: overwrite` (Dropbox idempotency via path).
  - Si offline → enqueue en `userData/sync-queue.json`.
- Coalesce: cambios al mismo record dentro de 500ms → debounce a una sola upload. Reduce burst on bulk edits.

**Remote → Local (pull):**

- Long-polling via Dropbox `filesListFolderLongpoll` sobre cada folder de sync (identities, workspaces). 30s timeout, reconnect en loop.
- Cuando Dropbox notifica change → `filesListFolderContinue(cursor)` para obtener delta. Decrypt + merge cada record con LWW rule.
- Si long-poll falla 3× consecutivas → fallback a poll cada 30s con `listFolderContinue(cursor)`.
- Bandwidth: long-poll connection abierta cuesta cero (~10KB/h keep-alive).

**Conflict detection:**

- Antes de push, el sync engine fetcha el `updatedAt` actual del remote (vía `filesGetMetadata`). Si remote > local _antes_ del push → es ese caso de "alguien escribió primero" → re-merge antes de subir.

### 5. Offline queue

`userData/sync-queue.json`:

```json
{
  "schemaVersion": 1,
  "queue": [
    { "op": "upsert", "recordType": "identity", "recordId": "abc", "updatedAt": "..." },
    { "op": "delete", "recordType": "workspace", "recordId": "xyz", "updatedAt": "..." }
  ]
}
```

- Queue FIFO. Cada op referencia el record actual local (no snapshot — porque pueden haber sucedido N edits del mismo record offline, solo importa el último).
- Online → replay queue. Por op: re-fetch local record, encrypt, upload (with conflict check from §4).
- Drain en background con backoff exponencial (1s → 30s) en errores red.
- Sobre delete: si remote también lo borró → no-op.
- Sobre upsert: aplica LWW. Si remote es más nuevo → keep remote local + drop la op del queue (perdimos la edit local — log WARN, mostrar alert al user "X edits no se sincronizaron, fueron sobrescritas").

### 6. Initial sync (cold start, primer device del team)

Cuando vault unlocked + sync enabled por primera vez:

1. `listFolder(/sync/identities)` — fetch all.
2. Por cada record: download + decrypt.
3. Merge contra local IdentityManager:
   - Si remote.id no existe local → create local.
   - Si remote.id existe local: LWW por updatedAt.
4. Tras pull complete: scan local IdentityManager + push records no presentes remotamente.
5. Persist cursor para subsequent long-poll.
6. Marca initial-sync completed en `state/sync-state.json`.

Boot subsequent: solo `listFolderContinue(cursor)` para delta desde último sync.

### 7. Encryption en records

Mismo AES-256-GCM scheme del vault (ADR 0008). Master key del Keychain. Per-record file:

```
[ header_len: u32 LE | header_json_bytes | iv: 12 bytes | authTag: 16 bytes | ciphertext ]
```

- Header JSON visible: filename ya implica recordId, pero header da `updatedAt` + `deviceFolder` para que listFolder + getMetadata den info útil sin descifrar.
- Body cifrado: JSON-serialized record entero (todos los fields de identity/workspace).
- authTag protege contra tampering.

Dropbox VE: filename (= recordId.json.enc), header timestamps, file size. Dropbox NO VE: name del identity, color, password, cookies, proxy, fingerprint.

### 8. Schema versioning

Cada record header tiene `schemaVersion`. `_meta.json.enc` por folder tiene `targetSchemaVersion`.

**Migración path:**

- Cliente con schema N+1 lee record schema N → migrate-in-memory (default values for new fields) → opcional re-write para upgrade.
- Cliente con schema N lee record schema N+1 → ignore el record + WARN. NO truncar fields desconocidos. Otro device con cliente más nuevo eventualmente actualiza.
- `_meta.json.enc.targetSchemaVersion` actúa como flag — si todos los devices están en >=N+1, podemos GC code legacy.

### 9. Tombstones + delete propagation

Soft delete: record file persiste con `deleted: true` + `deletedAt`. Body queda cifrado (no leak post-delete). Otros devices ven la flag + remueven local.

GC: tras 30 días desde `deletedAt`, cualquier device durante su sync puede hard-delete el file. Coordinated via `_meta.json.enc` para evitar races (single device hace el GC sweep, marcado en meta).

### 10. Multi-device race conditions

| Escenario                                                            | Comportamiento                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Device A + Device B push el mismo record al mismo `updatedAt` exacto | Lex order on `deviceFolder` desempata. Idempotente.             |
| Device A edita mientras Device B borra el mismo record               | Más nuevo `updatedAt` gana. Edit posterior a delete → "renace". |
| Vault locked en Device A; Device B pushea cambios                    | Device A no recibe hasta unlock + sync resume. Sin error.       |
| Network split: 24h offline en Device A                               | Queue se acumula. Online → drain + replay.                      |
| Device cae mid-upload                                                | Dropbox no commit; archivo no llega al folder. Next sync retry. |
| Long-poll cierra mid-poll (NetworkError)                             | Reconnect inmediato. Si falla 3× → poll fallback.               |
| Schema version conflict                                              | Older client skip + WARN. No crash.                             |

### 11. Performance budget

- Identities promedio: ~50 records × ~1KB encrypted = 50KB total folder.
- Workspaces: ~30 records × ~5KB = 150KB.
- Initial sync cold start: 1 listFolder + 80 GET requests = ~2-3s con good connection.
- Subsequent: 1 listFolderContinue = ~200ms.
- Long-poll: 1 connection abierta keep-alive. Negligible bandwidth.
- Push on change: 1 PUT per record edit. Coalesced si bursty.

Sin bottlenecks visibles para team <10. >50 records totales empezaría a notar — out-of-scope para v1.

### 12. Failure modes + UX

- **Sync deshabilitado en settings**: cero overhead, no listeners.
- **Network down**: queue grows, alert silenciosa hasta que vuelva.
- **Token expired (NEEDS_REAUTH)**: alert prominente, sync paused hasta reconnect Dropbox.
- **Vault locked**: sync paused, no encrypt/decrypt operations. Resume on unlock.
- **Conflict resolution discarded local edit**: alert con detalle "your edit to X was overwritten by user Y on device Z at HH:MM". User puede re-aplicar.
- **Sync engine crash**: error en main process is logged, the sync engine restart-on-error con backoff. Queue persists, no data loss.

### 13. Por qué NO usar Supabase realtime para sync

Misma razón que ADR 0025 §3 zero-knowledge: si pasamos plaintext (incluso JSON) por Supabase realtime, dejamos de tener zero-knowledge. Toda la value prop de OZ vs Ghost Browser cae. Dropbox como dumb storage + crypto local mantiene la garantía.

### 14. Trade-offs aceptados

| Trade-off                                  | Decisión           | Razón                                                                                                                                |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Lost-update con concurrent edits (LWW)     | Aceptado           | Team chico, conflict rate cerca de cero. Alert al user cuando happens.                                                               |
| Cookies/sessions NO sync v1                | Diferido D-4 o más | Pesadas, riesgo logout chain. Snapshot manual cubre 95%.                                                                             |
| Per-record vs operation log                | Per-record         | Simple, no replay complex logic, fácil debug.                                                                                        |
| 30s poll fallback vs WebSocket             | Poll fallback      | Dropbox no tiene WebSocket; long-poll es lo mejor disponible.                                                                        |
| Single owner del key (vault)               | Aceptado v1        | Bloque E agrega key-sharing Curve25519 para multi-owner. Sin E, sync engine corre pero team members no pueden descifrar — fail safe. |
| \_meta.json contention con high write rate | Aceptado v1        | Pocos cambios concurrentes en team chico. v2 podría chunkar por shard si necesario.                                                  |
| No CRDT                                    | Aceptado           | Overkill para data model + team size. Re-evaluar a 20+ users.                                                                        |

### 15. Dependencias de D-3 / D-4

**D-3 sync engine core** implementará:

- `browser/sync-engine.js` (top-level orchestrator)
- `browser/sync-record-store.js` (encrypt/decrypt + folder layout)
- `browser/sync-merge.js` (LWW + tombstone logic)
- `browser/sync-queue.js` (offline queue + replay)
- Hooks en IdentityManager + WorkspaceManager (`'changed'` event)
- Long-poll loop + listFolderContinue cursors
- Cursor-based listings (depende de D-2.3)

**D-4 polish:**

- Bookmarks sync (full file).
- Multi-device race regression tests con clock injection.
- Cookies sync opcional + opt-in toggle por identity.
- DR drill: device A wipea local, recibe full state via sync.

## Consequences

**Lograr:**

- Team members (post-bloque E key-sharing) ven cambios de identities/workspaces ~5s lag con long-poll.
- Owner sigue siendo single source of crypto truth; ninguno ve plaintext fuera de su Keychain.
- Sin Supabase, sin servidor, sin auth backend. Solo Dropbox como dumb storage.

**Cambios:**

- IdentityManager + WorkspaceManager emiten `'changed'` events (similar pattern al BackupManager EventEmitter de D-1).
- Nuevo `userData/sync-queue.json` persistente.
- Nuevo `userData/sync-state.json` con cursors per-folder.
- `cloud-backup.json` se mantiene independiente — backup ≠ sync, ambos coexisten.

**Decisiones diferidas a D-3/D-4:**

- Concurrent-write race details (transactional puts vs version-stamps).
- Bookmark conflict resolution (full-file LWW vs delta).
- Cookies sync (si entra a v1 o queda v2).
- Operación de migration tooling (cambios de schema requieren scripts admin).

**Riesgos identificados:**

- Long-poll keep-alive en Dropbox podría tener edge cases con NAT / corporate proxy. Plan B: aggressive fallback poll cada 30s funciona en todos lados pero menos snappy.
- Master-key dependency de Keychain durante decrypt en sync loop — vault locked = sync paused. Alternativa: cache master key en memoria con TTL post-unlock (5min). Decisión final en D-3.
- 1500 records es la línea aproximada donde performance del initial-sync empieza a doler. Out-of-scope v1 pero documentado.
