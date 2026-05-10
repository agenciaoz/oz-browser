# Módulo `excel-handlers`

**Path:** `browser/excel-handlers.js`
**Líneas:** ~258
**Bloque/Etapa:** 1.5e (CORE)

## Qué hace

Handler map para el dominio `excel`. Envuelve las primitivas de [`excel-io.js`](excel-io.md) con (a) vault gate, (b) resolución de identity/workspace names a IDs (bulk creation cuando faltan), y (c) lógica de los 4 modos de import. Consumido por IPC (`ipc-handlers.js`) y MCP (`mcp-tools-vault.js`) — mismo patrón shared transports que el resto del 1.5.

## 4 modos de import

| Modo                | Comportamiento                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERMANENT_MERGE`   | Por cada row del Excel busca match exacto `(identityId, site, username)` en el vault. Si existe → UPDATE (preserva el `id` original). Si no → CREATE. Identities/workspaces faltantes se crean automáticamente.            |
| `EPHEMERAL_SESSION` | Parsea el Excel pero **NO persiste**. Devuelve `ephemeralRows` para que la UI 1.5f maneje sessions in-memory que se descartan al cerrar OZ. Útil para login one-shot sin guardar credenciales (cliente externo, etc.).     |
| `NEW_WORKSPACE`     | Crea un workspace nuevo dedicado (nombre auto-generado: `Imported YYYY-MM-DD`). Todos los accounts del Excel se asignan a ese workspace. Sin tocar workspaces/accounts existentes. Identities sí pueden ser bulk-creadas.  |
| `OVERWRITE_TOTAL`   | ⚠️ DESTRUCTIVO. **REEMPLAZA todo el vault** con el contenido del Excel. Caller (1.5f UI) debe hacer Time Machine snapshot antes (1.6) — el handler sólo loggea WARN. Útil para sincronizar 2 Macs con el mismo set master. |

## Vault gate

Como el resto de handlers de 1.5, todas las operaciones requieren `vault.unlock()` previo. Si el vault está locked, devuelven:

```js
{ __error: { code: 'LOCKED', message: 'Vault is locked — call oz.vault.unlock() first' } }
```

## Bulk identity / workspace creation

Cuando el Excel referencia identities o workspaces por nombre que NO existen en el browser, se crean automáticamente via `findOrCreate*`:

- Identity nuevo → `IdentityManager.create({name})` (respeta cap del 1.5b — si hay 25 identities y el Excel trae más, el `create` falla con `IDENTITY_CAP_REACHED` y el import aborta).
- Workspace nuevo → `WorkspaceManager.create({name})` (sin cap).

Lista de nombres creados se devuelve en `identitiesCreated` / `workspacesCreated` para que la UI muestre toast/banner.

## Exports

| Símbolo                       | Tipo     | Descripción                                |
| ----------------------------- | -------- | ------------------------------------------ |
| `buildExcelHandlers(browser)` | function | Retorna `{exportToFile, importFromFile}`.  |
| `IMPORT_MODES`                | array    | Re-export de `excel-io` para conveniencia. |

## Handlers

### `exportToFile(filePath) → {ok, filePath, rows} | {__error}`

- Vault gate.
- Construye `maps` desde `IdentityManager.list()` + `WorkspaceManager.list()`.
- Llama `excel-io.exportAccounts`.
- Loggea via `logger.info('excel-handlers', 'export ok')`.

### `importFromFile(filePath, mode) → {ok, mode, importedCount, ...} | {__error}`

- Vault gate.
- Valida `mode` contra `IMPORT_MODES`.
- Parsea Excel (errores de parse → `IMPORT_PARSE_FAILED`).
- Branch según modo (ver tabla arriba).
- Modos persistentes (todos menos EPHEMERAL): `vault.setAccounts(finalAccounts)` + broadcast `oz:accounts:changed`, `oz:identities:changed`, `oz:workspaces:changed`.

Returns:

```js
{
  ok: true,
  mode,
  importedCount,           // accounts del Excel parseados (skipeadas no cuentan)
  finalAccountsCount,      // total en el vault DESPUÉS del import
  identitiesCreated,       // [string] nombres
  workspacesCreated,       // [string] nombres
  dedicatedWorkspaceId,    // sólo NEW_WORKSPACE — id del workspace creado
}
```

## IPC channels registrados

```
oz:excel:exportToFile  → exportToFile(filePath)
oz:excel:importFromFile → importFromFile(filePath, mode)
```

## MCP tools (mcp-tools-vault.js)

```
oz.excel.exportToFile
oz.excel.importFromFile
```

Mismo handler map → contract test en `tests/mcp-server.smoketest.js` valida simetría IPC↔MCP.

## Eventos broadcast

| Channel                 | Cuándo                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `oz:accounts:changed`   | Tras `setAccounts` en cualquier modo persistente.                                            |
| `oz:identities:changed` | Si bulk creation de identities ocurrió.                                                      |
| `oz:workspaces:changed` | Si NEW_WORKSPACE creó workspace o si PERMANENT_MERGE/OVERWRITE crearon workspaces faltantes. |

## ID generation

`_uuid()` interno = `crypto.randomBytes(8).toString('hex')` — 16 hex chars, mismo formato que `account-handlers.create`. NO usa `uuid` package porque overhead injustificado para 16 chars random.

## Tests

Cobertura via:

- `tests/excel-io.smoketest.js` — primitives (export/import).
- `tests/mcp-server.smoketest.js` — contract test extendido para `oz.excel.*`.
- 1.5f cubrirá tests E2E del handler con vault real (mock-Electron) cuando se conecte a la UI.

## Gotchas

- `OVERWRITE_TOTAL` no tiene confirmación interna — la UI 1.5f DEBE mostrar dialog de double-confirm + recomendar Time Machine antes de invocar.
- En `PERMANENT_MERGE`, el match es por triple `(identityId, site, username)`. Si el user editó el username en el Excel, se crea un account nuevo — el viejo NO se borra. Decisión consciente: borrar implícito = destructivo, prefiero leak de duplicados.
- Identity cap (25) puede explotar el import a mitad — los identities ya creados se quedan creados, los accounts de filas posteriores no se persisten. La UI 1.5f mostrará el `__error` y el state del vault queda consistente (vault no se modifica si el error es antes de `setAccounts`).
- `cookies` siempre se setea a `null` en accounts importados — Excel sólo trae `Cookies Count` informativo, las cookies reales sólo se materializan en login.

## Referencias

- [`excel-io.md`](excel-io.md) — primitives.
- [`account-vault.md`](account-vault.md) — `vault.setAccounts` consumido aquí.
- [`account-handlers.md`](account-handlers.md) — patrón análogo (handler map shared IPC↔MCP, vault gate).
- [`identity-manager.md`](identity-manager.md), [`workspace-manager.md`](workspace-manager.md) — fuentes para `findOrCreate*`.
