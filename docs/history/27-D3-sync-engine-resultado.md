# Bloque D-3 → D-4 mini b — Sync engine resultado (2026-05-13)

> Sesión maratónica que cerró el internal layer del sync engine — desde primitivas hasta orchestrator end-to-end. 8 commits, +460 tests, todo CI verde. Falta solo wire-up en main.js (D-3c-3c, requiere live validation).

**Commit final:** `befc354` (push del D-4 mini b)
**Commits acumulados:** `d2b947e` → `f2767f6` → `b752104` → `0fa12dc` → `d18b84a` → `f9fecdc` → `9b69776` → `befc354`
**Tests acumulados:** 1776 → ~2236 (+460 nuevos, 0 regresiones)

## Qué se entregó por sub-chunk

### D-3a — Sync primitives (`d2b947e`, +103 tests)

- **`browser/sync-merge.js`** (40 tests) — Pure LWW logic. `mergeRecords(local, remote)` decide qué lado gana usando `updatedAt` con desempate por `deviceFolder` lex order (lower wins, idempotente). Tombstone-aware (edit-after-delete = resurrección, ADR §9). `compareTimestamps`, `isTombstoneGcEligible(header, now)`, `assertValidHeader` exportados. 30d GC window constante.
- **`browser/sync-record-store.js`** (39 tests) — AES-256-GCM encode/decode con mismo formato que D-1 backup: `[headerLen u32 LE | headerJson | iv 12 | authTag 16 | ciphertext]`. Header plaintext visible (Dropbox listFolder ve metadatos sin descifrar), body cifrado + auth-tagged. `SyncRecordStoreError` con 11 `.code` distintos. IV uniqueness verificada probabilísticamente (32 trials, 0 colisiones).
- **`IdentityManager extends EventEmitter`** (24 tests) — emite `'changed'` `{op, recordType, recordId, record?, updatedAt|deletedAt}` tras cada CRUD efectivo. `updatedAt` ISO 8601 con backfill defensivo on `_load`. No-op `update()` y idempotent `setLocked()` NO emiten ni stampan. Listener throws aislados en try/catch.
- **Bug bonus**: `backup-manager.smoketest` retention test era date-flaky (asumía `-50d` y `-52d` en la misma semana ISO, falla cuando el Mon/Sun boundary cae entre ellos). Arreglado calculando offsets desde el Mon de la semana objetivo.

### D-3b mini — Offline queue (`f2767f6`, +63 tests)

- **`browser/sync-queue.js`** — FIFO persistente en `userData/sync-queue.json`. Atomic write tmp+rename. **Dedup por `(recordType, recordId)`** con coalesce HACIA EL END del queue (último enqueue gana + reset position). Resultado: la cola siempre carga el estado más fresco, y el orden refleja most-recent-edit-first-among-pending. `MAX_QUEUE_SIZE = 50_000`. Validation con 10+ `.code` values. Events para observabilidad.

### D-3c-1 — Engine push side (`b752104`, +63 tests)

- **`browser/sync-engine.js`** — wirea IM 'changed' → queue.enqueue. Drain loop con **backoff exponencial 1s→2s→4s→8s→16s→30s** + reset on success. **Race-safe conditional remove**: tras upload exitoso, solo borra del queue si el slot no fue coalescido por un edit más nuevo durante el upload (compara timestamps). Garantiza zero edit loss. Scheduler inyectable para tests determinísticos. Vault locked / Dropbox unauth → `'paused'` event (no error). RECORD_GONE → drop + warn. Split en core + resilience por ADR 0005.

### D-3c-2 — Pull side (`0fa12dc`, +59 tests)

- **`browser/sync-pull.js`** — Independiente del engine para mantener LOC bajo. `pullOnce(recordType)` con cursor persistente en `userData/sync-state.json`. Cold-start `listFolder` → subsequent `listFolderContinue`. Download + decode + LWW merge contra local (via fetchRecord). Emite `'remote-apply'` events `{action: 'upsert'|'delete', recordId, header, body}` para que el host los aplique. Skip self-uploads via deviceFolder match. Skip Dropbox-level isDeleted (server-side hard-deletes). Pause cuando vault locked / unauthenticated. Schema mismatch / corrupt state file → start fresh + warn. Split en core + state/errors por ADR 0005.

### D-3c-3a — Identity apply-remote bridge (`d18b84a`, +39 tests)

- **`browser/identity-manager-sync.js`** — Standalone `applyRemoteUpsert(im, record)` y `applyRemoteDelete(im, recordId, deletedAt)` que mutan IM state **SIN emitir `'changed'`** (cortan el loop remote→local→push→remote). Emiten `'remote-applied'` para UI consumers. Default rejected. `isDefault` forzado a false (defensive). Sessions cache invalidado en delete. Listener throws aislados. Módulo separado porque identity-manager.js ya estaba a 499 LOC.

### D-3c-3b — Orchestrator (`f9fecdc`, +29 tests)

- **`browser/sync-setup.js`** — `setupSync({vault, dropbox, identityManager, userDataDir, deviceFolder}) → {engine, puller, queue, start, stop, isRunning, pullNow}`. Wirea `puller.on('remote-apply')` → `applyRemoteUpsert/Delete` con try/catch defensivo. Pull poll loop con `setInterval(pullOnce, 30s)` (D-3c-3c reemplaza con long-poll real). Surface engine/puller events via `log.info/warn` para observabilidad. **Tests incluyen end-to-end Alice→Bob round-trip** con 2 IdentityManager instances + fake Dropbox compartido — la canónica scenario del ADR §1.

### D-4 mini — WorkspaceManager sync (`9b69776`, +55 tests)

- **`WorkspaceManager extends EventEmitter`** + emite `'changed'` en metadata mutations. Tab-spec ops NO emiten (carveout §1 ADR). `updatedAt` convertido a ISO 8601 con backfill defensivo de legacy ms timestamps. Idempotency guards en archive/restore/freeze/unfreeze + no-op update.
- **`browser/workspace-manager-sync.js`** — `applyRemoteUpsert/Delete` con sanitization estricta. `'general'` workspace rejected. Privacy carveout: remote `tabSpecs` y `activeTabId` STRIPPED en apply (local preserved).
- **`sync-setup.js` extendido** para workspaceManager opcional. Bridge route en remote-apply por recordType. Engine fetchRecord también strippea tabSpecs/activeTabId al push — dual-strip = zero leakage en ambas direcciones. `pullNow` retorna `{identity, workspace}`.
- **Tests adicionales** verifican end-to-end que el encoded body en Dropbox NO contiene tabSpecs/activeTabId (privacy carveout end-to-end on push side).

### D-4 mini b — BookmarkManager sync (`befc354`, +49 tests)

- **`BookmarkManager extends EventEmitter`** — emite `'changed'` en add/remove/removeByIdentity (skip dedup'd add + no-op delete). Único caso de **single-record full-file LWW** (recordId = `'all'`, body = collection entera). Sidecar `bookmarks-sync-meta.json` para `updatedAt` (NO toca el formato de `bookmarks.json` — cero migration risk para legacy installs).
- **`browser/bookmark-manager-sync.js`** — `applyRemoteUpsert` reemplaza local collection wholesale. Validation rechaza null body / wrong recordId / non-array. Defensive: drops malformed entries con warn. `applyRemoteDelete` es **no-op intencional** + warn — borrar "todos los bookmarks" no es una op de sync (los removes individuales viajan como upserts del nuevo whole-collection state).
- **`sync-setup.js` extendido** para bookmarkManager opcional. fetchRecord retorna `getSyncRecord()` para recordId='all'. `pullNow` retorna `{identity, workspace, bookmark}`.

## Decisiones arquitectónicas memorables

1. **Race-safe conditional remove** (D-3c-1). Engine NO borra ciegamente la op del queue tras upload — relee el slot, compara timestamps, deja la op si fue coalescida por un edit más nuevo. Zero edit loss bajo carga.
2. **`'remote-applied'` distinto de `'changed'`** (D-3c-3a). Lo que mata el loop infinito remote→local→push→remote. UI consumers pueden suscribirse a ambos eventos para ver TODAS las mutaciones.
3. **Privacy carveout dual-strip** (D-4 mini). Workspace `tabSpecs/activeTabId` se quitan en el push fetchRecord Y en el apply side. No leakage en ninguna dirección.
4. **Bookmarks como single-record** (D-4 mini b). Diverge del pattern per-record de identities/workspaces porque ADR §1 dijo "full-file LWW". Sidecar meta file evita migración del formato bookmarks.json.
5. **8 LOC-splits ejecutados** sin violations en 8 commits. Cada vez que un archivo pasaba 500 LOC meaningful, lo splitteamos en sub-módulos coherentes (test files split per ADR 0005 también).
6. **Scheduler inyectable en engine** + **pollScheduler inyectable en sync-setup**. Permite tests determinísticos sin real setTimeout. Driven via `drainOnce()` / `pullNow()` directamente.

## Issues resueltos

- **bug pre-existente**: backup-manager retention test era date-flaky (offsets -50d/-52d cruzaban semana ISO en ciertos días de la semana). Arreglado calculando offsets dinámicos desde el lunes de la semana objetivo. Hoy: el test es determinístico en cualquier día del año.

## Costos

- $0 incrementales (todos los servicios externos ya estaban en plan, Dropbox dev tier free).
- Cero deps npm nuevas — sólo node:crypto + node:fs + node:events + node:path.

## Validación pendiente

Wire-up real en main.js (D-3c-3c) — requiere `npm start` para confirmar que setupSync se compone correctamente con Vault + DropboxClient + IM/WM/BM reales + UI toggle settings + OAuth flow. Estimado ~1-2h una vez se valide live.

Una vez D-3c-3c valide visualmente, las pruebas E2E con dos Mac reales (Jose + Maria) confirman:

- Alice crea identity en su Mac → aparece en Mac de Maria <30s
- Alice borra identity → desaparece en Mac de Maria
- Bob edita workspace name → cambio llega a Alice
- Conflict simultaneous edits → LWW + deviceFolder lex resuelve determinísticamente
- Vault locked en Alice → su sync pausa, edits cola, drena al unlock

## Próximo paso

**D-3c-3c — main.js wire-up.** Patch quirúrgico a `main.js` (que está en el límite 500 LOC, requiere split adicional probable). Instanciar Vault + DropboxClient + IM/WM/BM ya existentes + llamar `setupSync(...)`. Hook a settings UI toggle "Sync via Dropbox". Si Dropbox no auth → ofrecer botón "Connect Dropbox" disparando OAuth flow existente. Status badge en sidebar.

Después D-3c-3d opcional — long-poll real via `filesListFolderLongpoll` para snap remote→local de ~30s a <10s. Después D-4 polish (tombstone GC + DR drill) si hace falta.

## Documentación creada en este chunk

- ADR 0026 marcado **Implemented** con mapa de implementación
- 9 module docs nuevos: `sync-merge.md`, `sync-record-store.md`, `sync-queue.md`, `sync-engine.md`, `sync-pull.md`, `sync-setup.md`, `identity-manager-sync.md`, `workspace-manager-sync.md`, `bookmark-manager-sync.md`
- 3 module docs existentes extendidos: `identity-manager.md`, `workspace-manager.md`, `bookmark-manager.md` (este último creado de cero)
- CHANGELOG entry consolidada
- Este history doc
