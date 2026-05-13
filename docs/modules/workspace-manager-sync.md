# Módulo `workspace-manager-sync`

**Path:** `browser/workspace-manager-sync.js`
**Líneas:** ~189
**Bloque:** D-4 mini ✅
**ADR:** [0026 — Sync engine](../architecture/0026-sync-engine.md) §1 (carveout: cookies/session NOT synced), §4 (pull-side apply)

## Qué hace

Mismo pattern que `identity-manager-sync.js` pero para workspaces. Standalone functions que aplican remote records al `WorkspaceManager` sin disparar el push loop.

## Privacy carveout — tabSpecs / activeTabId

**Crítico**: el remote record PUEDE traer `tabSpecs[]` (URLs + títulos de las tabs abiertas del miembro del team al momento del push). Eso es session state, no shared team config. En el apply:

1. **Stripped del remote record** antes de mergear.
2. **Local tabSpecs PRESERVED** — el local-state de tabs sigue intacto.
3. **Local activeTabId PRESERVED** — el remote no manda al usuario a otra tab.

El strip dual (push side en sync-setup.fetchRecord + apply side en este módulo) garantiza que tabSpecs NUNCA crucen devices. Matchea el carveout del ADR §1 ("Cookies + history quedan FUERA del sync v1").

## Exports

| Símbolo                                      | Tipo     | Descripción                                                     |
| -------------------------------------------- | -------- | --------------------------------------------------------------- |
| `applyRemoteUpsert(wm, record)`              | function | Apply remote workspace. Retorna `{op, workspace}` o null.       |
| `applyRemoteDelete(wm, recordId, deletedAt)` | function | Idempotent tombstone apply. Retorna `{op, workspaceId}` o null. |
| `DEFAULT_WORKSPACE_ID`                       | const    | `'general'`.                                                    |

## Contracto

- **NO emite `'changed'`** (corta el loop).
- **SÍ emite `'remote-applied'`** en el manager — `{op, recordType: 'workspace', recordId, workspace? | deletedAt}`.
- **`'general'` workspace siempre rechazada** — per-device singleton.
- **`isDefault` forzado a false** en upsert.
- **Sanitization estricta**: solo campos whitelisted (id, name, color, isDefault, isArchived, isFrozen, quickTabsMode, createdAt, updatedAt, identityIds). Campos extras del remote se descartan.
- **updatedAt backfilled** a nowIso() si missing/malformed.
- **In-place mutation** de `wm.workspaces[]` — preserva references + local tabSpecs/activeTabId.
- **Listener throws aislados** con try/catch.

## Side effects en WM

1. `wm.workspaces[]` mutado (push o in-place replace con strip).
2. `wm._saveNow()` llamado (atomic persist).
3. `wm.emit('remote-applied', payload)`.

## Tests

38 assertions en `tests/workspace-manager-sync.smoketest.js`. Cubre: create / update / delete happy paths; General rejection; validation; updatedAt backfill; isDefault forced false; **tabSpecs / activeTabId stripped (privacy carveout)**; throwing 'remote-applied' listener isolation.

Adicional: `tests/sync-setup-workspace.smoketest.js` (17 assertions) verifica end-to-end que el push side TAMBIÉN strippea tabSpecs (encoded body en Dropbox NO los contiene).

## Gotchas

- Si el local workspace tiene `identities[]`, applyRemoteDelete **NO cascade** los identities a 'general' (a diferencia de `WorkspaceManager.remove`). El sync layer va a aterrizar identity deletes separately. Mientras tanto el local IM puede referenciar un workspace inexistente brevemente — el próximo pull tick reconcilia.
- Recover scenario: D-4+ polish podría añadir cascade hook similar al de WorkspaceManager.remove.
