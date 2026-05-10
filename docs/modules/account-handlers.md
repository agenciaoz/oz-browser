# Módulo `account-handlers`

**Path:** `browser/account-handlers.js`
**Líneas:** ~220
**Bloque/Etapa:** 1.5b (CORE)

## Qué hace

Handler maps puros `{name → fn}` para los dominios `vault` y `accounts`, consumidos por DOS layers:

1. `ipc-handlers.js` que los registra como `ipcMain.handle('oz:vault:X', fn)` y `ipcMain.handle('oz:accounts:X', fn)`.
2. `mcp-server.js` que los expone como tools MCP `oz.vault.X` y `oz.accounts.X` via `mcp-tools-vault.js`.

Mismo patrón que `identity-handlers.js`, `workspace-handlers.js`, `tab-handlers.js`. Misma implementación, dos transports.

## Vault gate

Todas las operaciones de `accounts.*` requieren `vault.unlock()` previo. Si el vault está locked, devuelven:

```js
{ __error: { code: 'LOCKED', message: 'Vault is locked — call oz.vault.unlock() first' } }
```

NO throw — se devuelve el error estructurado para que IPC y MCP puedan manejarlo uniformemente sin bracket de exception. Mismo patrón que `identity-handlers.create` con cap reached.

## Modelo Account

```js
{
  id,             // uuid hex 16 chars
  identityId,     // bind to identity (required en create)
  workspaceId,    // bind to workspace (puede ser null en EPHEMERAL)
  site,           // 'x.com', 'instagram.com', etc. (required)
  username,       // (required)
  password,       // plaintext while vault unlocked (required)
  totpSecret,     // base32 si aplica (default null)
  cookies,        // populated by anti-logout (1.5d) (default null)
  lastLoginAt,    // timestamp ms
  lastIp,         // last proxy IP seen
  status,         // 'active' (default) | 'inactive' | 'needs_relogin'
  notes,          // string (default '')
  customFields,   // object libre (default {})
  createdAt,      // timestamp ms
  updatedAt,      // timestamp ms
}
```

## Exports

| Símbolo                         | Tipo     | Descripción                                          |
| ------------------------------- | -------- | ---------------------------------------------------- |
| `buildVaultHandlers(browser)`   | function | Retorna handler map vault.                           |
| `buildAccountHandlers(browser)` | function | Retorna handler map accounts.                        |
| `VALID_STATUSES`                | array    | `['active', 'inactive', 'needs_relogin']` whitelist. |
| `ACCOUNT_PATCH_FIELDS`          | array    | Campos updateable via `update()`.                    |

## Vault handlers

| Nombre      | Args | Returns                                               | Side effects                                                               |
| ----------- | ---- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `status()`  | —    | `{exists, isUnlocked, accountsCount\|null}`           | —                                                                          |
| `unlock()`  | —    | `{ok:true, isUnlocked:true}` o `{__error:{code,msg}}` | broadcast `oz:vault:changed`                                               |
| `lock()`    | —    | `{ok:true, isUnlocked:false}`                         | broadcast `oz:vault:changed`                                               |
| `destroy()` | —    | `{ok:true}`                                           | broadcast `oz:vault:changed`. **DESTRUCTIVE** — borra file + Keychain key. |

## Account handlers

| Nombre              | Args                                          | Returns                     | Side effects                                  |
| ------------------- | --------------------------------------------- | --------------------------- | --------------------------------------------- |
| `list(filter?)`     | `{identityId?, workspaceId?, site?, status?}` | array (filtrado)            | —                                             |
| `get(id)`           | `id`                                          | account \| null             | —                                             |
| `create(opts)`      | `{identityId, site, username, password, ...}` | account \| `{__error}`      | broadcast `oz:accounts:changed`               |
| `update(id, patch)` | `id, patch`                                   | account \| null             | broadcast. Whitelist + invalid status ignored |
| `remove(id)`        | `id`                                          | bool                        | broadcast                                     |
| `setAll(accounts)`  | array                                         | `{ok, count}` o `{__error}` | broadcast. Bulk replace — Excel import (1.5e) |

## Privacy / metadata

`vault.status()` devuelve `accountsCount: null` cuando el vault está locked. Esto evita metadata leak a procesos que pueden invocar IPC pero no unlock (ej: extensión third-party con renderer access).

## IPC channels registrados

```
oz:vault:status        → status()
oz:vault:unlock        → unlock()
oz:vault:lock          → lock()
oz:vault:destroy       → destroy()
oz:accounts:list       → list(filter)
oz:accounts:get        → get(id)
oz:accounts:create     → create(opts)
oz:accounts:update     → update(id, patch)
oz:accounts:remove     → remove(id)
oz:accounts:setAll     → setAll(accounts)
```

## Eventos broadcast

| Channel               | Cuándo                                              |
| --------------------- | --------------------------------------------------- |
| `oz:vault:changed`    | unlock / lock / destroy ejecutado                   |
| `oz:accounts:changed` | create / update / remove / setAll modificó la lista |

## Tests

- `tests/account-handlers.smoketest.js` — 51 tests cubriendo:
  - vault.status locked vs unlocked
  - accounts.\* devuelven LOCKED si vault locked
  - create requires required fields
  - create defaults asignados correctamente (status='active', timestamps, etc.)
  - list filter por identityId/workspaceId/site/status combinable
  - get por id (encontrado/null)
  - update whitelist + invalid status ignorado + updatedAt incrementa
  - remove devuelve true/false correctamente
  - setAll bulk replace con count check + non-array → BAD_ARG
  - vault.destroy + unlock fresh devuelve list vacía
  - broadcasts events fire (oz:accounts:changed, oz:vault:changed)
- Contract test IPC↔MCP en `tests/mcp-server.smoketest.js` extendido para validar simetría de `oz:vault:*` y `oz:accounts:*`.

## Próximos pasos (1.5c-f)

- 1.5c: site templates + auto-fill content script + auto-save popup.
- 1.5d: anti-logout (cookie expiry extension + health check).
- 1.5e: Excel I/O con exceljs + bulk import 4 modos.
- 1.5f: Account Manager UI + cierre.

## Referencias

- [`account-vault.md`](account-vault.md) — backend de cifrado.
- [`identity-handlers.md`](identity-handlers.md) — patrón análogo.
- [ADR 0008](../architecture/0008-account-vault-encryption.md).
- [ADR 0012](../architecture/0012-oz-mcp-server.md) — patrón handlers shared IPC↔MCP.
