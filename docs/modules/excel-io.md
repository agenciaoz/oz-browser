# Módulo `excel-io`

**Path:** `browser/excel-io.js`
**Líneas:** ~200
**Bloque/Etapa:** 1.5e (CORE)

## Qué hace

Export e import de la lista de accounts del vault a/desde archivos `.xlsx`. Usado para round-trip "mando a oficina externa → editan/limpian → importo de vuelta" y para bulk onboarding al crear el vault por primera vez con cuentas que ya tenía Jose en otro browser.

Implementación con `exceljs` — NO `xlsx` (xlsx community tiene CVE-2023-30533 y CVE-2024-22363 sin patch, decidido en [ADR 0008](../architecture/0008-account-vault-encryption.md)).

## Columnas v1 (orden fijo en export, tolerante en import)

```
Workspace | Identity | Site | Username | Password | 2FA Secret |
Last Login | Status | Cookies Count | Last IP | Notes
```

`Cookies Count` es read-only en export (info para humanos). En import se ignora — las cookies reales sólo se materializan cuando el user hace login.

## Exports

| Símbolo                                | Tipo     | Descripción                                                                    |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `exportAccounts(accounts, maps, path)` | function | Escribe `.xlsx` con styling header (bold + bg oscuro). Returns rows.           |
| `importAccounts(path)`                 | function | Parsea `.xlsx` → rows + identity/workspace names a resolver.                   |
| `COLUMN_DEFS`                          | array    | 11 column descriptors (`{key, header, width}`).                                |
| `IMPORT_MODES`                         | array    | `['PERMANENT_MERGE', 'EPHEMERAL_SESSION', 'NEW_WORKSPACE', 'OVERWRITE_TOTAL']` |

## API

### `exportAccounts(accounts, maps, filePath) → Promise<{rows, filePath}>`

- `accounts`: lista decryptada del vault (passwords plaintext).
- `maps.identityById`: `{id → name}` para resolver identityId → nombre humano en la columna Identity.
- `maps.workspaceById`: idem para workspaces.
- `filePath`: absoluto, debe terminar en `.xlsx`.

`lastLoginAt` (timestamp ms) se serializa a ISO string en la columna Excel para legibilidad humana — `importAccounts` parsea ISO de vuelta a timestamp ms (round-trip lossless validado en test).

### `importAccounts(filePath) → Promise<{rows, identityNamesNeeded, workspaceNamesNeeded}>`

- `rows`: array de `{identityName, workspaceName, site, username, password, totpSecret, lastLoginAt, status, lastIp, notes}`. Skipea filas sin `site || !username || !password`.
- `identityNamesNeeded`: array deduplicado de nombres de identity referenciados por las rows. Caller decide si crearlos (`PERMANENT_MERGE`/`OVERWRITE_TOTAL`) o ignorarlos.
- `workspaceNamesNeeded`: idem para workspaces.

Lookup de columnas por header name (case-insensitive) — tolera columnas reordenadas por el user en Excel/Numbers/Sheets.

## Defaults al parsear

- `identityName` ausente → `'Default'`.
- `status` ausente → `'active'`.
- `workspaceName` vacío → `null` (account sin workspace).
- `lastLoginAt` con string no parseable → `null` (sin error fatal).
- Rich-text cells de exceljs (`{text: "..."}`) se desempacan a string plano.

## Tests

- `tests/excel-io.smoketest.js` — 25 tests cubriendo:
  - export genera `.xlsx` válido (>1KB, header + rows correctos)
  - round-trip lossless: export → import preserva site/username/password/totpSecret/notes/status/lastLoginAt
  - notas con commas y `"quotes"` preservadas (CSV-safety)
  - identityNamesNeeded + workspaceNamesNeeded correctos (deduplicados)
  - rows incompletas (sin password/site/username) skipeadas
  - empty workbook → 0 rows
  - status default `'active'` si vacío

## Gotchas

- ExcelJS modifica el Workbook en `addRow` mutándolo — no es safe para concurrent writes. El `await writeFile` debe terminar antes de iniciar otro export.
- Passwords con caracteres especiales (`@`, espacios, quotes) preservados — exceljs maneja escaping XML internamente.
- 2FA secrets se exportan en plaintext base32 — el archivo `.xlsx` resultante DEBE tratarse como secrets material (NO commitear, NO email sin cifrar). Warning visible en la UI 1.5f cuando se ofrezca el export.

## Referencias

- [`excel-handlers.md`](excel-handlers.md) — los 4 modos de import + bulk identity/workspace creation.
- [ADR 0008](../architecture/0008-account-vault-encryption.md) — decisión exceljs vs xlsx.
- [`account-vault.md`](account-vault.md) — fuente de los accounts a exportar.
- npm: `exceljs`.
