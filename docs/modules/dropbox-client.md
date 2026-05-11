# `browser/dropbox-client.js`

**Bloque:** D-1.2 + D-2.2 (chunked upload) + D-2.3 (cursor-based listings)
**ADR:** [0025 Cloud backup architecture](../architecture/0025-cloud-backup.md), [0026 Sync engine](../architecture/0026-sync-engine.md)
**Tests:** `tests/dropbox-client.smoketest.js` (64 cases) + `tests/dropbox-client-d2.smoketest.js` (28 cases)

## Qué hace

Wrapper sobre `dropbox@10.34.0` SDK + nuestro `oauth-helper.js` (PKCE + Keychain). Centraliza upload/download/list/delete + auto-refresh on 401.

## API

```js
const { createDropboxClient } = require('./dropbox-client')
const c = createDropboxClient({ clientId: process.env.OZ_DROPBOX_APP_KEY })

c.startAuth()        // → { authUrl, codeVerifier, state }
await c.completeAuth({ code, state, expectedCodeVerifier, expectedState })
c.clearAuth()
c.isAuthenticated() // bool

await c.getAccountInfo()                        // → { accountId, email, name, country }
await c.ensureFolder(path)                      // idempotent on path/conflict/folder
await c.upload({ path, contents, mode? })       // contents = Buffer; routes single-PUT or chunked-session by size
await c.download(path)                          // → { contents: Buffer, path, size, rev, contentHash }
await c.listFolder(path, { recursive? })        // D-2.3: → { entries, cursor, hasMore }
await c.listFolderContinue(cursor)              // D-2.3: delta page; throws CURSOR_RESET on stale cursor
await c.listFolderAll(path, { recursive? })     // D-2.3: paginates listFolder + listFolderContinue until !hasMore
await c.delete(path)
```

## Chunked upload (D-2.2)

Routing automático por `contents.length`. ≤140MB → `filesUpload` (1 PUT). >140MB → `filesUploadSessionStart` + `filesUploadSessionAppendV2` × N + `filesUploadSessionFinish`. Chunks de 8MB.

La sesión entera corre dentro de un solo `_withAuth` wrapper — si 401 mid-session, refresh + retry desde chunk 0 (session_id puede invalidarse con stale token; re-upload los bytes es el path predecible).

## Cursor-based listings (D-2.3)

`listFolder()` retorna ahora una página `{ entries, cursor, hasMore }`. El cursor permite `listFolderContinue(cursor)` para delta listings — solo cambios desde el cursor. Entries del delta pueden tener `isDeleted: true` (file fue removido del folder).

Si Dropbox dice "cursor too old" → `listFolderContinue` propaga como `CURSOR_RESET`. Caller (cloud-backup-manager) lo trata como "drop cache + re-list from scratch".

`listFolderAll()` convenience: paginates internamente hasta `!hasMore`, devuelve la unión.

## Endpoints

- Auth: `https://www.dropbox.com/oauth2/authorize`
- Token: `https://api.dropboxapi.com/oauth2/token`
- Scopes: `files.content.write files.content.read account_info.read`
- Redirect: `oz://auth/dropbox/callback`
- `token_access_type=offline` (refresh_token in response).

## Token refresh

`_withAuth(op)` wrapper. Si la op falla con status 401:

1. Si no hay refresh_token → `clearAuth()` + throw `NEEDS_REAUTH`.
2. Si hay refresh_token → `refreshAccessToken` via oauth-helper.
3. Si refresh falla → `clearAuth()` + throw `NEEDS_REAUTH`.
4. Si refresh OK → rebuild SDK client con nuevo accessToken + retry una vez.

## Por qué NO el OAuth del SDK

`DropboxAuth` del SDK reimplementa PKCE + token mgmt. Forzaría dos paths de PKCE + dos storage layers (memoria SDK vs Keychain). Pasamos accessToken puro al `Dropbox(...)` constructor y manejamos refresh nosotros. Detalle en ADR 0025.

## Errors

`DropboxError(message, code, status)`. Codes: `BAD_ARG`, `STATE_MISMATCH`, `NEEDS_REAUTH`, `TOO_LARGE`, `API_ERROR`, `BAD_RESPONSE`.

## Path normalization

Dropbox API espera `/foo/bar.ext`. Helper `_normalizePath`:

- `''` o `'/'` → `''` (root del App Folder).
- Adds leading slash.
- Dedup `//` → `/`.
- Backslash → slash.
- Strip trailing slash.

## Test injection

`injectDropboxSdk(fake)` para inyectar fake SDK con `Dropbox` class.
