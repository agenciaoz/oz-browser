# Bloque G-5 — Ghost importer idempotency + replace mode + self-heal (resultado)

**Status:** ✅ Cerrado 2026-05-14
**Commit:** `d2b7d8b`
**Tiempo:** ~3h efectivas
**Deps nuevas:** ninguna
**Tests:** +38 (`tests/ghost-browser-importer-g5.smoketest.js`)
**Files changed:** 9 (1 nuevo + 8 modificados)

## Origen — 3 bugs latentes surfaced por smoke real de Jose

G v1 quedó "cerrado" 2026-05-13 con smoke parcial: Claude llegó hasta el preview (counts: 3 identidades / 2 workspaces / 38 cookies / 1 password) + error-handler de vault locked. Pero NO se ejecutó el import real para no contaminar el Ghost de Jose.

Cuando Jose corrió el import real 2026-05-14 desde OZ 1.0.0, aparecieron **3 bugs** en cadena:

### Bug A — Importer no idempotente

Síntoma observado por Jose: corrió Import una vez (falló por vault locked, pero igual creó 3 identidades + 2 workspaces antes de llegar a cookies). Desbloqueó el vault, corrió Import otra vez. Resultado: **6 identidades duplicadas, 4 workspaces duplicados** (2 sets completos, IDs distintos).

Causa raíz: `runImport()` siempre llamaba `identityManager.create()` y `workspaceManager.create()` sin consultar el sidecar `ghost-migration-state.json` que SÍ existía y SÍ tenía el mapeo del primer intento — solo se escribía al final, jamás se leía al inicio. State.json se sobrescribía completo cada corrida.

### Bug B — Sidebar muestra "(no identities)" con tabs activos

Síntoma observado por Jose: después del cleanup manual del Bug A, los workspaces importados `Contextoec` y `El Informe` aparecían en la sidebar como `(0)` y "(no identities — click + New Identity)", pero los tabs SÍ funcionaban con la identidad correcta (Instagram contexto.ec logueado).

Causa raíz: misma que Bug C — el sidebar lee `workspace.identityIds[]`, que estaba vacío. Resuelto vía el fix de C.

### Bug C — `workspace.identityIds[]` se borra al boot

Síntoma observado por Jose: claude reparó el disco manualmente (puso `identityIds` correcto en `workspaces.json`). Cuando Jose abrió OZ, **a los ~3 segundos del boot OZ sobrescribió el archivo con `identityIds=[]`** otra vez. Cleanup manual era inútil — cada boot lo deshacía.

Causa raíz: el importer pre-G-5 (`ghost-browser-importer.js` línea 256) llamaba `identityManager.create({name, color})` sin pasar `workspaceId` → defaulteaba a `'general'`. Después llamaba `workspaceManager.addIdentity(ws.id, ozId)` que actualizaba el array `workspace.identityIds[]` PERO **no tocaba `identity.workspaceId`**.

Al boot, `identity-workspace-sync.js` corre `syncIdentityWorkspaces()` (ADR 0023 H3a), que **rebuildea `workspace.identityIds[]` desde `identityManager.listByWorkspace(ws.id)`**. La fuente de verdad es `identity.workspaceId`. Como las identidades importadas tenían `workspaceId='general'`, el rebuild las contaba como pertenecientes a General Browsing y vaciaba `Contextoec.identityIds` / `El Informe.identityIds`.

Defense-in-depth necesaria: además de fixear el importer, queríamos que el sistema **se auto-recupere** de cualquier inconsistencia similar futura sin requerir repair manual.

## Decisiones (verbal con Jose mid-debug)

1. **Modo importer `merge` (default) vs `replace`** (suggested por Jose: "deberías darme la opción de importar y reescribir o solo importar y unir"). Aceptada. Merge skipea ghost-ids ya mapeados; replace borra el import previo antes de re-importar.

2. **Self-heal en boot vs solo fix del importer.** Aceptado self-heal porque (a) recupera la data ya corrupta de Jose sin requerir repair manual, (b) actúa como safety net para futuros bugs similares en el importer u otros paths que toquen workspace.identityIds.

3. **Heurística del self-heal: tabSpec evidence + first-workspace-wins.** El boot reconcile detecta workspaces con tabSpecs cuya identityId apunta a identities con `workspaceId` mismatch → infer ownership y move. General Browsing EXCLUIDA (legítimamente hostea tabs de muchas identities sin "owner-ship").

## Cambios entregados

### `browser/migrations/ghost-browser-importer.js`

- **`opts.mode`** ('merge' default, 'replace') agregado en `_defaultOptions`.
- **`runImport` consulta state.json** al inicio. En merge mode, seedea `summary.identityMap` + `workspaceMap` con state previo.
- **Replace mode** borra identities del state previo via `identityManager.remove(ozId)` y workspaces via `workspaceManager.remove(ozId, {cascade: false})` — antes de re-importar. Defensive: unlock + unfreeze + skip default.
- **Skip en merge:** si `ghost-hash` ya está en `identityMap` Y la OZ identity todavía existe → `summary.reused.identities++`, continue. Idem workspaces.
- **Fix Bug C:** loop que asocia identities con su workspace ahora usa `identityManager.moveToWorkspace(ozId, ws.id)` en lugar de `workspaceManager.addIdentity(ws.id, ozId)`. moveToWorkspace dispara el hook de `wireIdentityWorkspaceSync` que mantiene ambos lados consistentes.
- **Summary nuevo:** `summary.mode`, `summary.reused.{identities, workspaces}`, `summary.removed.{identities, workspaces}`.

### `browser/identity-workspace-sync.js`

- **Step 1.5 nuevo en `syncIdentityWorkspaces`:** antes del rebuild step 2, scan tabSpecs evidence:
  ```js
  for (const ws of wsList) {
    if (ws.id === DEFAULT_WORKSPACE_ID) continue
    for (const tab of ws.tabSpecs || []) {
      const tid = tab.identityId
      if (!tid || tid === 'default') continue
      if (claimedBy.has(tid)) continue
      const ident = im.get(tid)
      if (!ident || ident.isDefault) continue
      claimedBy.set(tid, ws.id)
      if (ident.workspaceId !== ws.id) {
        im.moveToWorkspace(tid, ws.id)
        inferred += 1
      }
    }
  }
  ```
- General Browsing excluida (legítimamente hostea tabs de muchas identities).
- First-workspace-wins: si una identity aparece en tabSpecs de 2+ workspaces non-default, claim por el primero (orden de `wm.list()`).
- Log info línea contiene `identitiesInferredFromTabs: N` para observabilidad del self-heal.

### `browser/ui/webui.html` + `browser/ui/ghost-migration-ui.js`

- **Radio buttons** "Merge with existing (recommended)" / "Replace previous import (destructive)" en sección Migration. Visible solo cuando `getState()` retorna state previo.
- Confirm dialog (`window.confirm`) antes de replace.
- `_renderState` muestra `${idMapCount} identities and ${wsMapCount} workspaces` en la descripción del replace option.
- `_renderSummary` ahora muestra `Mode: merge|replace` + `Reused: N` + `Removed (replace): N`.

### `browser/ui/manifest.json`

- WebUI extension version bump `1.0.6 → 1.0.7` (regla persistente: bump en cualquier edit a `browser/ui/`).

### `package.json`

- App version bump `1.0.0 → 1.0.1` (policy: patch bump per release shippable, v1 line).

### `tests/ghost-browser-importer-g5.smoketest.js` (nuevo, +38 assertions)

4 secciones:

1. **Merge mode idempotency** — run1 crea N, run2 sobre misma source reusa N + crea 0. State.json mantiene size estable.
2. **Replace mode** — run1 crea N, manualmente agrego "Survivor" identity non-Ghost, run2 mode=replace remueve N + recrea N. Survivor untouched. State.json refleja solo run2.
3. **Self-heal from tabSpec evidence** — hand-craft estado roto (workspace con `identityIds=[]` + tabSpec referenciando identity con `workspaceId='general'`). Wire `wireIdentityWorkspaceSync` → post-wire la identity se movió al workspace correcto.
4. **General excluded from self-heal** — Alice claimed por Project (no por General) cuando aparece en tabs de ambos.

### `tests/ghost-browser-importer-e2e.smoketest.js`

Actualizado para wirear `wireIdentityWorkspaceSync` (production parity). Sin esto la assertion "My Project has 2 identityIds linked" fallaba porque el hook no se disparaba en el test.

## Recuperación de la data de Jose

El self-heal en boot es **el** mecanismo de recuperación. Cuando Jose instale el DMG 1.0.1 y abra OZ:

1. WorkspaceManager carga `workspaces.json` con `Contextoec.identityIds=[]`, `tabSpecs[1].identityId='2e270e3b'` (Contexto IG).
2. IdentityManager carga `identities.json` con Contexto IG.workspaceId='general'.
3. `wireIdentityWorkspaceSync` ejecuta `syncIdentityWorkspaces`:
   - Step 1.5: scan Contextoec.tabSpecs → encuentra `identityId=2e270e3b` con `workspaceId='general'` mismatch → `moveToWorkspace(2e270e3b, fd9aa34b)`. `inferred=1`.
   - Idem para El Informe + Pedro → `inferred=3`.
   - Step 2: rebuild → `Contextoec.identityIds=[2e270e3b]`, `ElInforme.identityIds=[1064b87a, 4c6c37aa]`.
4. Sidebar render correcto en el primer paint.

Sin repair manual de disco. Verificado vía test section 3.

## Repair manual previo (deprecated por self-heal)

Antes del fix de código, claude intentó dos veces el repair manual de disco vía Python (escribir `workspace.identityIds` directo + bump updatedAt). Ambas veces OZ sobrescribía a los segundos del boot:

- **Repair 1** (`.pre-cleanup-20260514-202655/`): cleanup de duplicates del Bug A. Quedó OK pero los identityIds del segundo intento ya se habían wipeado al boot.
- **Repair 2** (`.pre-repair-20260514-204633/`): re-aplicó identityIds con `updatedAt=2026-12-31`. OZ sobrescribió a `01:46:48Z` (~15s post-boot) con `now`.

Los backups quedan en `~/Library/Application Support/OZ Browser/.pre-*-*/`. Pueden borrarse manualmente después de confirmar que 1.0.1 funciona — no se usan más.

## Próximo paso

H restantes para v1 cierre completo:

- **I** Apple signing (~6-7h, bloqueado por approval de Apple Dev $99).
- **I-2** auto-updater (~1-2h post-I) — opcional pero clave para que Jose no tenga que reinstalar DMG manual cada bump.

## Referencias

- ADR 0023 — Identity-per-workspace hierarchy (updated con G-5 self-heal Step 1.5)
- `docs/modules/identity-workspace-sync.md` (nuevo)
- `docs/modules/ghost-browser-importer.md` (nuevo)
- CHANGELOG entry `[2026-05-14] [G-5 / v1.0.1]`
- Commit `d2b7d8b`
