# Módulo `identity-workspace-sync`

**Path:** `browser/identity-workspace-sync.js`
**Líneas:** ~165
**Bloque:** H3a ✅, extendido en G-5 ✅ (2026-05-14)
**ADR:** [0023 — Identity-per-workspace hierarchy](../architecture/0023-identity-workspace-hierarchy.md) §D10 self-heal

## Qué hace

Wirea los hooks que mantienen consistente la invariante de ADR 0023 D1:

```
workspace.identityIds[]  ===  { i.id : i.workspaceId === workspace.id }
```

`identity.workspaceId` es la **fuente de verdad**; `workspace.identityIds[]` es estado derivado mantenido sincronizado vía hooks bidireccionales + un reconcile defensive al boot.

Loose coupling: el módulo recibe `browser` y opera sobre `browser.identityManager` + `browser.workspaceManager` sin que ningún manager conozca al otro.

## Exports

| Símbolo                              | Tipo     | Descripción                                                                                                             |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `wireIdentityWorkspaceSync(browser)` | function | Instala los 2 hooks + corre el initial reconcile. Idempotent.                                                           |
| `syncIdentityWorkspaces(browser)`    | function | Standalone reconcile (re-home + self-heal + drift fix). Llamado por `wireIdentityWorkspaceSync` y exportado para tests. |

## Cuándo se llama desde main.js

Entre `new WorkspaceManager()` y `AntiLogout.install()` durante `Browser.init()`. Después de esto, todo `identityManager.create/remove/moveToWorkspace` propaga al workspace correctamente; todo `workspaceManager.remove` con cascade re-homea identidades a `general`.

## Hooks instalados

### 1. IdentityManager → WorkspaceManager

`identityManager.setWorkspaceSyncHook((op, identityId, fromWsId, toWsId))`:

- `op === 'add'` + `toWsId` → `workspaceManager.addIdentity(toWsId, identityId)`
- `op === 'remove'` + `fromWsId` → `workspaceManager.removeIdentity(fromWsId, identityId)`
- `op === 'move'` → `removeIdentity(from)` + `addIdentity(to)`

Fires desde `IdentityManager.create()`, `remove()`, `moveToWorkspace()`. Errores en el hook se loguean WARN y se swallowean (el cambio en IM ya commit, no rollback).

### 2. WorkspaceManager cascade hooks

`workspaceManager.setWorkspaceCascadeHooks({probe, run})`:

- `probe(wsId, identityIds)` → `{lockedCount, movableCount}`. Cuenta locked identities en el workspace target del remove.
- `run(wsId, identityIds, destWorkspaceId)` → `identityManager.moveToWorkspace(iid, destWorkspaceId)` por cada identity no-default, no-locked.

Fires desde `workspaceManager.remove(id, {cascade: true})` cuando hay identities en el workspace que se borra. Default workspace `general` no se puede borrar (rejected por isDefault).

## Initial reconcile (al boot)

`syncIdentityWorkspaces` corre 3 steps:

### Step 1 — Re-home orphans

Por cada identity con `workspaceId` que apunta a un workspace que ya no existe → `moveToWorkspace(id, 'general')`. Loggea `identitiesRehomed`.

### Step 1.5 — Self-heal desde tabSpec evidence (G-5)

**Por qué existe:** ver ADR 0023 §D10. El importer Ghost pre-G-5 dejaba el estado inconsistente — `workspace.identityIds=[]` + `tabSpecs[].identityId` apuntando a identities con `workspaceId='general'`. Step 2 ciegamente confiaba en `identity.workspaceId` y wipeaba los identityIds de los workspaces importados.

**Heurística:**

```
for each workspace W (excluding 'general'):
  for each tab in W.tabSpecs:
    let X = identity referenced by tab.identityId
    if X is valid, non-default, and X.workspaceId !== W.id:
      moveToWorkspace(X, W.id)
      inferred += 1
```

- General Browsing **excluida** del scan (semánticamente puede hostear tabs de muchas identities).
- **First-workspace-wins** en conflict (identity referenciada por tabs en 2+ workspaces non-default): claim por el primero del `wm.list()` order. Estable cross-boot.
- Loggea `identitiesInferredFromTabs`.

### Step 2 — Drift fix (rebuild `workspace.identityIds[]`)

Por cada workspace, comparar `expected = listByWorkspace(ws.id)` vs `actual = ws.identityIds`. Si difieren: `addIdentity()` para los expected-not-actual + `removeIdentity()` para los actual-not-expected. Loggea `workspacesDriftFixed`.

## Side effects

- IM mutations vía `moveToWorkspace` (que fire hooks → WM updates).
- WM mutations vía hooks + cascade.
- `_save()` en ambos managers cuando cambian.

## Logs producidos

```
[identity-workspace-sync] wire skipped — managers missing       # missing deps
[identity-workspace-sync] sync hook error                      # hook throw
[identity-workspace-sync] invariant reconciled                 # any drift fixed
  ↑ payload: {identitiesRehomed, identitiesInferredFromTabs, workspacesDriftFixed}
```

Si los 3 counters son 0, NO loggea (silencioso en el happy path).

## Tests

- `tests/ghost-browser-importer-g5.smoketest.js` (sections 3-4): self-heal desde tabSpecs + General Browsing excluida.
- Cobertura indirecta en `tests/ghost-browser-importer-e2e.smoketest.js` (production parity wire-up).
- Step 1 + Step 2 cobertura indirecta en cualquier test que use IM + WM con `wireIdentityWorkspaceSync` (vía idempotency en re-runs).

## Gotchas conocidos

1. **No usar `workspaceManager.addIdentity()` directamente** para asociar identidad ↔ workspace. Eso solo updatea el array derivado, no la source-of-truth `identity.workspaceId`. **Usar `identityManager.moveToWorkspace(id, wsId)`** que dispara el hook bidireccional.

2. **Self-heal puede mover identidades inesperadamente** si el user tenía un tab abierto en workspace A usando identity de workspace B (estado pre-G-5 inconsistente con D1). Aceptado en favor de la invariante. Ver §D10 trade-off.

3. **`syncIdentityWorkspaces` no es transaccional**: cambios fluyen via hooks que persisten cada uno. Si crashea mid-reconcile, el state queda parcialmente migrado — el próximo boot lo retoma idempotente.

4. **Test wire-up imprescindible**: cualquier test e2e que use IM + WM REAL debe llamar `wireIdentityWorkspaceSync({identityManager, workspaceManager})` después de construir los managers, o las assertions sobre `workspace.identityIds[]` van a fallar silenciosamente (los managers están construidos pero el hook nunca se enganchó).
