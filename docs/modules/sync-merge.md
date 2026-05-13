# Módulo `sync-merge`

**Path:** `browser/sync-merge.js`
**Líneas:** ~180
**Bloque:** D-3a ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §3 (conflict resolution) + §9 (tombstones)

## Qué hace

Lógica pura (zero I/O) de Last-Write-Wins para el sync engine. Compara dos headers de record por `updatedAt`, desempata por `deviceFolder` lex order (lower wins, idempotente entre devices), maneja tombstones (deleted vs alive, edit-after-delete = resurrección). Trivialmente unit-testable.

## Exports

| Símbolo                   | Tipo     | Descripción                                                      |
| ------------------------- | -------- | ---------------------------------------------------------------- |
| `mergeRecords(l, r)`      | function | Decide qué lado gana. Retorna `{action, reason}`.                |
| `compareTimestamps(a, b)` | function | -1/0/1 sobre ISO 8601. Throws en input no parseable.             |
| `isTombstoneGcEligible`   | function | True si tombstone > 30d (constante exportada `TOMBSTONE_GC_MS`). |
| `assertValidHeader`       | function | Throws si header viola schema mínimo.                            |
| `TOMBSTONE_GC_DAYS`       | const    | 30.                                                              |

## Header shape (subset relevante)

```js
{
  schemaVersion: 1,
  updatedAt: '2026-05-11T10:00:23.456Z',  // ISO 8601
  deviceFolder: 'mac-bff00ff9',
  recordType: 'identity' | 'workspace' | 'bookmark',
  recordId: 'string',
  deleted: false,
  deletedAt?: '...'                        // solo cuando deleted=true
}
```

## Merge rules (§3 del ADR)

1. `local.updatedAt > remote.updatedAt` → `keep-local`.
2. `local.updatedAt < remote.updatedAt` → `take-remote`.
3. Tied → desempate por `deviceFolder` lex ascendente (lower wins). Idempotente en cualquier device sin coordinación.
4. Same device + same ts → `noop` (identical-provenance).
5. `deleted XOR deleted` → newer wins (edit posterior a delete → record renace).

## Edge cases manejados

- local null + remote present → `take-remote`
- local present + remote null → `keep-local`
- both null → `noop`
- equal updatedAt sin deviceFolder en algún lado → throws

## Tests

40 assertions en `tests/sync-merge.smoketest.js`. Cubre cada rama de la tabla + tombstone GC eligibility (0d/29d/30d/31d) + header validation completa.

## Gotchas

- `compareTimestamps` requiere ISO 8601 strings (no millis). El sync-engine convierte si recibe ms.
- `mergeRecords` no muta los headers — callers pueden re-leer `reason` para logging.
