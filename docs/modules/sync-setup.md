# Módulo `sync-setup`

**Path:** `browser/sync-setup.js`
**Líneas:** ~260
**Bloque:** D-3c-3b ✅ + D-4 mini + D-4 mini b
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §4 + §12

## Qué hace

Orchestrator que compone TODAS las primitivas del sync engine en un solo objeto controlable. El host (main.js o test) llama `setupSync(...)` con deps + recibe `{engine, puller, queue, start, stop, isRunning, pullNow}`. Pendiente: wire-up real en main.js (D-3c-3c).

## API

```js
const sync = setupSync({
  vault,              // required — Vault instance
  dropbox,            // required — Dropbox client
  identityManager,    // required — IdentityManager instance
  workspaceManager,   // optional — WorkspaceManager instance
  bookmarkManager,    // optional — BookmarkManager instance
  userDataDir,        // required — path to queue + state files
  deviceFolder,       // required — 'mac-aaaa1111'
  appFolder = 'sync',
  pollIntervalMs = 30_000,
  scheduler,          // inject for tests
  cancelScheduler,
  pollScheduler = setInterval,
  pollCancelScheduler = clearInterval,
})

sync.start()         // begin engine drain + pull poll loop
sync.stop()          // halt + detach listeners
sync.pullNow()       // manual trigger — returns {identity, workspace, bookmark}
```

## Lo que internamente arma

1. `SyncQueue` en `userData/sync-queue.json`.
2. `SyncEngine` con queue + registra IM como source 'identity'. Si workspaceManager → source 'workspace' con fetchRecord que STRIPEA `tabSpecs` y `activeTabId` (privacy carveout). Si bookmarkManager → source 'bookmark' con fetchRecord = `bm.getSyncRecord()` (single-record `id='all'`).
3. `SyncPuller` con cursor file en `userData/sync-state.json`. Registra los mismos sources.
4. Bridge: `puller.on('remote-apply')` rutea por `recordType`:
   - `'identity'` → `identity-manager-sync.applyRemoteUpsert/Delete(im, ...)`.
   - `'workspace'` → `workspace-manager-sync.applyRemoteUpsert/Delete(wm, ...)`.
   - `'bookmark'` → `bookmark-manager-sync.applyRemoteUpsert(bm, ...)` (delete es no-op para bookmarks).
5. Surface logs: engine `'pushed'`/`'push-failed'`, puller `'paused'`/`'warn'`/`'local-wins'`, queue `'warn'`.
6. Pull poll loop: `setInterval(pullTick, 30s)` que pulls cada source registrado en secuencia.

## start / stop semántica

- `start()` arranca engine.start() + Promise.resolve().then(pullTick) (immediate primer pull on next microtask) + interval.
- `stop()` clearInterval + engine.stop() (detacha 'changed' listeners). Idempotente. Después de stop el setup queda finalizado — `start()` post-stop no funciona.

## Exports

| Símbolo                    | Tipo     | Descripción                   |
| -------------------------- | -------- | ----------------------------- |
| `setupSync(opts)`          | function | Constructor del orchestrator. |
| `SyncSetupError`           | class    | Error con `.code='BAD_ARG'`.  |
| `DEFAULT_POLL_INTERVAL_MS` | const    | 30_000.                       |
| `DEFAULT_APP_FOLDER`       | const    | 'sync'.                       |

## Tests

- `tests/sync-setup.smoketest.js` (29 assertions) — constructor validation, local IM create → engine push, remote upload → applyRemoteUpsert, self-uploads no se re-aplican (deviceFolder match), applyRemote no triggera push (no infinite loop), start/stop lifecycle, **end-to-end Alice→Bob round-trip** con 2 IdentityManager instances + fake Dropbox compartido.
- `tests/sync-setup-workspace.smoketest.js` (17 assertions) — workspace push verifica que el encoded body NO contiene tabSpecs ni activeTabId (privacy carveout end-to-end), workspace round-trip Alice→Bob.

## Gotchas

- Los tres managers son **opcionales** salvo identityManager. Setup arranca sin workspaceManager / bookmarkManager — sólo identidades sincronizan.
- `pullNow()` retorna un objeto con `{identity, workspace?, bookmark?}` — cada uno es el return de `pullOnce` (`{status, applied, ...}`).
- `pollIntervalMs` controla la latencia remote→local. Default 30s. D-3c-3d podría reemplazar con long-poll real para <10s.
