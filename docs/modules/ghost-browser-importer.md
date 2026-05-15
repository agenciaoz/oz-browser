# Módulo `ghost-browser-importer`

**Path:** `browser/migrations/ghost-browser-importer.js`
**Líneas:** ~480
**Bloque:** G-2b ✅, extendido en G-5 ✅ (2026-05-14)
**ADR relacionado:** [0023 — Identity-per-workspace hierarchy](../architecture/0023-identity-workspace-hierarchy.md) §D10

## Qué hace

Orquesta el flow completo de import desde un data dir de Ghost Browser al state de OZ. Wirea el reader (G-1) + crypto (G-2a) contra `identityManager`, `workspaceManager`, `bookmarkManager`, `accountVault`, `backupManager`. Usa un sidecar `userData/data/ghost-migration-state.json` para idempotency.

## Exports

| Símbolo                                                     | Tipo           | Descripción                                                                                         |
| ----------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `dryRun({reader, crypto?, ghostDataDir, options?})`         | async function | Counts pre-import sin escribir disco. Usado por Preview UI.                                         |
| `runImport({reader, crypto, ghostDataDir, deps, options?})` | async function | Pipeline completo. Throw-then-rolls-back automático on failure via `backupManager.restoreSnapshot`. |
| `readState(userDataDir)`                                    | function       | Lee `ghost-migration-state.json` (sidecar). Retorna `null` si missing.                              |
| `clearState(userDataDir)`                                   | function       | Borra el sidecar. Usado por "Forget import history" button en Settings.                             |

## API de `runImport`

```js
runImport({
  reader,                  // ghost-browser-reader.js export
  crypto,                  // ghost-browser-crypto.js export (con fetchGhostKeychainKey injectable)
  ghostDataDir,            // path al data dir de Ghost
  deps: {
    identityManager,       // OZ IdentityManager — debe tener moveToWorkspace
    workspaceManager,      // OZ WorkspaceManager
    bookmarkManager?,      // optional — si missing, bookmarks skipped
    accountVault,          // OZ Vault unlocked
    backupManager,         // OZ BackupManager para pre-import snapshot
    getSession(id),        // (identityId) → Electron Session
    userDataDir,           // path OZ userData (para state sidecar)
  },
  options: {
    importIdentities?: true,
    importCookies?: true,
    importWorkspaces?: true,
    importBookmarks?: true,
    importPasswords?: true,
    includeDefaultCookies?: false,
    includeArchived?: false,
    mode?: 'merge' | 'replace',   // G-5: default 'merge'
    bookmarkIdentityId?: 'default',
  },
}) → Promise<summary>
```

### Summary shape

```js
{
  ok: bool,
  mode: 'merge' | 'replace',
  snapshotId: string | null,
  identityMap: { [ghostHash]: ozId },
  workspaceMap: { [ghostUuid]: ozId },
  counts: {
    identities: N,         // creadas EN ESTE run
    cookies: N,
    workspaces: N,
    bookmarks: N,
    passwords: N,
  },
  reused: {                // G-5 — solo merge mode
    identities: N,         // ya existían, skip create
    workspaces: N,
  },
  removed: {               // G-5 — solo replace mode
    identities: N,         // borradas antes de re-importar
    workspaces: N,
  },
  skipped: { cookies: N, passwords: N },
  keychainError: string | null,
  rolledBack?: bool,
  error?: { code, message, stack },
}
```

## Modes (G-5)

### `mode: 'merge'` (default)

Idempotente. Consulta `ghost-migration-state.json` al inicio, seedea `summary.identityMap` y `workspaceMap` con el mapeo previo. Por cada `ghost-hash`:

- Si está en `identityMap` Y `identityManager.get(ozId)` existe → `summary.reused.identities++`, skip create.
- Sino → `identityManager.create(...)` + agregar al map. `summary.counts.identities++`.

Idem para workspaces (key por ghost UUID).

State.json al final tiene el map **merged** con el previo. Múltiples corridas sobre la misma Ghost source NO duplican entidades.

### `mode: 'replace'`

Destructivo. Al inicio:

```js
for each ozId in prevState.identityMap.values():
  identityManager.remove(ozId)        // skip default; force-unlock if locked
  summary.removed.identities++
for each ozId in prevState.workspaceMap.values():
  workspaceManager.remove(ozId, {cascade: false})  // skip default; unfreeze if frozen
  summary.removed.workspaces++
```

Después corre el flow normal. `summary.identityMap` arranca empty, populated con IDs nuevos. State.json al final tiene solo el run actual.

**Survivor identities/workspaces** (creados manualmente, no en el state previo) **NO** se tocan. Aceptado: el state sidecar es el único source de "what was imported".

## Flow del runImport

1. **Pre-flight:** validate deps + `accountVault.isUnlocked`. Retorna `{error: {code: VAULT_LOCKED | BAD_DEPS | SNAPSHOT_FAILED}}` si falla.
2. **Snapshot:** `backupManager.createSnapshot({reason: 'pre-ghost-migration'})`. Stored en `summary.snapshotId` para rollback.
3. **Replace cleanup (si mode=replace):** delete prev identities + workspaces.
4. **Fetch Keychain key:** `crypto.fetchGhostKeychainKey()`. Deny non-fatal — surfacea `keychainError`, sigue sin cookies/passwords.
5. **Identidades:** crear via `identityManager.create({name, color})` (default `workspaceId='general'`). Map ghost-hash → ozId.
6. **Cookies:** por cada identity, `decryptCookies` → `session.cookies.set(details)` con `_cookieDetailsForElectron` mapping.
7. **Workspaces:** por cada Ghost project:
   - Si merge + ya en `workspaceMap` → reuse, `summary.reused.workspaces++`.
   - Sino → `workspaceManager.create({name})`. Mapear ghost-uuid → ozId.
   - Para cada identity del project: **`identityManager.moveToWorkspace(ozId, ws.id)`** (G-5 fix — antes era `workspaceManager.addIdentity` que no actualizaba `identity.workspaceId`).
   - `workspaceManager.setTabSpecs(ws.id, tabSpecs, null)`.
8. **Bookmarks:** opt-in via `options.importBookmarks` + `deps.bookmarkManager`. Imported con `identityId: 'default'` (Ghost bookmarks son pool-global Chromium, no per-identity).
9. **Passwords:** opt-in via `options.importPasswords` + derivedKey. Decrypt + `_buildAccountFromLogin(...)` + `accountVault.setAccounts([...existing, ...new])`. `customFields.importedFrom = 'ghost-browser'`.
10. **State save:** `_saveState(userDataDir, {version, lastImportAt, ghostDataDir, durationMs, identityMap, workspaceMap, counts, skipped, keychainError})`.

## Catch + rollback

Si cualquier paso throws:

- `backupManager.restoreSnapshot(snapshotId)` si está disponible.
- `summary.rolledBack = true`.
- `summary.error = {code: 'IMPORT_FAILED', message, stack}`.
- State.json **NO** se escribe (idempotent retry posible).

Si el rollback falla: `summary.rollbackError = {code: 'ROLLBACK_FAILED', message}` + el state queda parcial (peor caso — log + alert al user).

## Decisiones bakeadas

- **`identity.workspaceId` source-of-truth:** el importer usa `identityManager.moveToWorkspace`, no `workspaceManager.addIdentity` directo (ver ADR 0023 §D10 — el bug pre-G-5 violaba esto).
- **Passwords `identityId: null`:** pool-global en Ghost, no per-identity binding. User reasigna via UI.
- **`customFields.importedFrom: 'ghost-browser'`** marker en accounts. No se usa en identity schema (whitelist `[name, color, userAgent]` para update).
- **Orphan project dirs IGNORED:** solo projects en `projects_list.json` se importan.
- **Default/Cookies skipped by default:** opt-in via `options.includeDefaultCookies`.
- **Chrome time conversion:** `(microseconds / 1e6) - 11644473600 = unix seconds`.
- **Samesite int→str map:** Chromium 1=lax, 2=strict, others=unspecified.

## Tests

- `tests/ghost-browser-importer.smoketest.js` — 66 unit tests (fake deps).
- `tests/ghost-browser-importer-e2e.smoketest.js` — 43 e2e tests (REAL managers + wired sync).
- `tests/ghost-browser-importer-g5.smoketest.js` — 38 tests (merge idempotency, replace cleanup, self-heal en boot, General excluded).

## Gotchas

1. **Vault unlocked es prerequisite.** Sin esto returna `{error: {code: 'VAULT_LOCKED'}}` antes de tocar nada. UI debe abrir el unlock modal antes de ofrecer Import.

2. **Ghost cerrado durante import.** SQLite cookie/login DBs se lockean cuando Ghost está corriendo. Si Ghost open → reads fallarán. UI no enforcea esto — confiamos en el user (la descripción del panel sugiere "Always Allow Keychain").

3. **State.json no incluye cookies/passwords reasignados manualmente.** Si el user mueve cookies entre sessions post-import, eso no se persiste en el state. Replace mode no las "limpia" — solo limpia identities + workspaces del state.

4. **G-5 replace + survivor identities:** identities creadas FUERA del state previo NO se tocan en replace. Aceptado. Si el user las quiere borrar, debe hacerlo manual.

5. **Manifest WebUI bump obligatorio** cuando se toca `browser/ui/ghost-migration-ui.js` o el HTML de la sección Migration. Regla persistente del proyecto.

## Referencias

- ADR 0023 §D10 — Self-heal step 1.5 in syncIdentityWorkspaces
- `docs/history/31-bloque-g5-resultado.md` — context del fix G-5
- `docs/modules/identity-workspace-sync.md` — hooks bidireccionales
- `browser/ghost-migration-handlers.js` — IPC layer (G-3)
- `browser/ui/ghost-migration-ui.js` — UI layer (G-3 + G-5 mode radios)
