# ADR 0023 — Identity-per-workspace hierarchy + migración

**Date:** 2026-05-10
**Status:** Accepted
**Bloque:** H3 (subdividido en H3a/H3b/H3c)
**Predecesor:** ADR 0015 (Workspace model — lock 1 ventana = 1 workspace)
**Supersede parcial:** ADR 0015 §"Identidades son globales" (ya no — ahora viven en workspace)

## Contexto

Hasta hoy (HEAD `b0bddb2`) OZ tiene un modelo plano:

- **Workspaces** son globales (top-level): General Browsing, Perra, ssss, Cliente Test (archived)
- **Identities** son globales (top-level): Default + 7 custom (Cliente A, B, Cliente1-5)
- **Tabs** viven en `(workspace + identity)` — la única conexión entre ambos

Jose pidió cambiar el modelo a **jerárquico**: cada workspace contiene sus identities (proyecto Pedro contiene `Pedro Insta`, `Maria Insta`, `Daniela Insta`, etc — cada uno encapsulado como un browser distinto). Use case real: "tengo 100 cuentas Instagram a manejar, cada una vive en su workspace de proyecto".

## Decisiones

### D1 — Modelo: 1 identity = 1 workspace exacto (jerárquico simple)

```js
Identity {
  id: 'default' | uuid,
  name: string,
  workspaceId: string,  // NEW — required
  // ... resto de campos
}

Workspace {
  id: 'general' | uuid,
  name: string,
  identityIds: string[],  // NEW — default []
  // ... resto de campos
}
```

**NO M:N** — la misma identity NO puede estar en 2 workspaces. Si querés "Pedro Insta" también en otro proyecto → creás "Pedro Insta 2" allá. Justificación: simpler invariants, easier to reason about, mantiene el lock 1-1 ventana=workspace.

### D2 — Default identity special case: vive solo en workspace `'general'`

Default usa `defaultSession` (ADR 0003) y tiene Chrome Web Store extensions. Es ubiquitous SOLO en el workspace `'general'`. En otros workspaces NO aparece. Jose confirmó este modelo via AskUserQuestion el 2026-05-10. Workspace `'general'` no se puede borrar (`isDefault: true`).

### D3 — Migración automática first-run, idempotente

Estado actual: 8 identities sin `workspaceId`, 4 workspaces sin `identityIds`. Migration plan:

1. Si TODAS las identities ya tienen `workspaceId` → skip (idempotente)
2. Sino:
   - Backup `identities.json` y `workspaces.json` a `*.pre-migration-YYYYMMDD.json`
   - Default → `workspaceId: 'general'`
   - Crear workspace `'migrated-bulk'` (id hardcoded — NO por name lookup) con `name: 'Migrated'`, `color: '#8b5a8c'` (púrpura distintivo). Si ya existe (re-run accidental), skip.
   - Las 7 custom identities existentes → `workspaceId: 'migrated-bulk'`
   - Sync TODOS los workspaces: `identityIds[]` populated correctamente para los 4 actuales (general, Cliente Test, Perra, ssss) + el nuevo migrated-bulk
   - Save ambos JSON files
   - Log `INFO migration` con counts

**Llamado:** método separado `Browser.migrateIdentitiesToWorkspaces(im, wm)` invocado SYNCHRONOUSLY entre `new WorkspaceManager()` y `AntiLogout.install()`. Decisión C4.

**Dry-run:** flag `OZ_MIGRATION_DRY_RUN=1` ejecuta solo el log sin escribir. Para validar antes del primer write real.

### D4 — Account.workspaceId queda independiente del workspace de la identity

En `vault.enc` cada Account tiene `workspaceId`. Con D1 podría argumentarse que debería derivarse de `identity.workspaceId`. **NO**: el vault está locked al boot, no podemos migrarlo. Decisión: mantener Account.workspaceId independiente. Al `vault.unlock()`, ejecutar `_sweepOrphanAccounts()` que loggea (no auto-fixea) accounts cuya identity ahora vive en otro workspace. UI futura permite "fix" manual.

### D5 — `Tab.moveToWorkspace` cuando identity no pertenece al WS destino

**Auto-mueve la identity también** (cascade), si la identity no está locked. Si está locked → reject con `reason:'identity-locked-in-source-workspace'`. UX más amigable que rechazar siempre.

### D6 — Excel import scope (C1)

`findOrCreateIdentity(name, workspaceId)` SCOPED al workspace target. Modos:

- **NEW_WORKSPACE:** crea identities en el workspace nuevo
- **PERMANENT_MERGE / OVERWRITE_TOTAL:** Excel DEBE llevar columna `workspaceName` por row. Si missing → reject con error claro
- **EPHEMERAL_SESSION:** sin persist, sin scope check

Esto es un cambio breaking de la semántica actual (hoy `workspaceName` es opcional). Hay que actualizar tests `excel-io.smoketest.js` + documentar en módulo.

### D7 — Workspace remove con identities adentro (H2.3)

`workspaceManager.remove(id)` por default **rejects** con `{ ok: false, reason: 'has-identities', count: N }`. Caller (UI) muestra dialog: "Esto borrará el workspace y mueve N identities a Default. ¿Continuar?". Si confirma → cascade move-to-Default (workspaceId='general' para esas identities). Si alguna identity está locked → reject completo `{ ok: false, reason: 'has-locked-identities' }`. Workspace `'general'` no se puede borrar (ya enforced por isDefault flag).

### D8 — Cross-workspace identity access (C3 — ⚠️ user-confirmed)

Use case real: "estoy en workspace María, quiero abrir Insta de Pedro rápido". El sidebar filtered NO muestra identities de otros workspaces. Solución:

- Menu File → "Open identity from another workspace…" (`Cmd+Shift+O`)
- Modal con search + lista de TODAS las identities agrupadas por workspace
- Al confirm: abre **NUEVA ventana** con workspace target + tab nueva en identity seleccionada
- Mantiene el lock 1-1 (cada ventana 1 workspace), no rompe sidebar

### D9 — Sidebar filtered + tabs hidratadas (C6)

Durante `hydrateWorkspace`, filtrar tabSpecs cuya identity ya no vive en el workspace → loggear WARN + skip. Post-migration corre 1 vez `cleanupOrphanTabs(window)` para limpiar tabSpecs huérfanos sin perder data (los logueamos a un orphans-log para audit).

## Implementación — sub-bloques

### H3a (~3h) — Modelo + Migration sin UI

- `Identity.workspaceId` + `Workspace.identityIds[]` fields
- `IdentityManager.listByWorkspace`, `moveToWorkspace`, validation
- `WorkspaceManager.addIdentity/removeIdentity` helpers, `remove` con D7 logic
- `Browser.migrateIdentitiesToWorkspaces` method
- Tests: identity-manager + workspace-manager schema updates + nuevo `identity-workspace-migration.smoketest.js`

### H3b (~2h) — API + MCP + Excel scope fix

- IPC handlers + 2 tools MCP nuevos
- `excel-handlers.findOrCreateIdentity` scoped (D6)
- `tab-handlers.moveToWorkspace` con D5 logic
- `tab-context-handlers` Move-to-workspace submenu filtered (D5)
- Tests: excel-io reescritura parcial (~10 tests) + mcp-server contract

### H3c (~3h) — UI sidebar filtered + cross-WS UX

- `sidebar.js` render filtered por workspace activo
- `workspace-switcher.js` re-trigger sidebar render on switch
- Cmd+Shift+O modal "Open identity from another workspace…" (D8)
- Right-click identity → "Move to workspace…" submenu
- Drag-drop identity → workspace pill
- Validation visual end-to-end via Desktop Commander

## Alternativas consideradas

- **N:M (identity en múltiples workspaces)** — descartado. Más complejo, requiere semantics de delete cross-WS, choca con lock 1-1.
- **Identities siguen globales + workspace.identityIds[] como filtro** — descartado. El usuario pidió jerárquico real, no filtros.
- **Default visible en TODOS los workspaces** — descartado por Jose. Default vive solo en 'general'.
- **Migration manual (Jose decide identidad por identidad)** — descartado. Migration automática a `'migrated-bulk'`, Jose reorganiza después manualmente.
- **Folders globales (sin reformar workspace)** — descartado. El use case es "workspace = proyecto, identities = cuentas del proyecto".

## Trade-offs aceptados

- **Cross-workspace identity access requiere `Cmd+Shift+O` + nueva ventana** (D8). Más fricción que el modelo plano viejo. Aceptado en favor de aislamiento real.
- **Account.workspaceId puede divergir del workspace de la identity** (D4). Documentado como by-design. Sweep al unlock log + UI fix manual futuro.
- **Excel import requires `workspaceName` column en MERGE/OVERWRITE** (D6). Breaking change documentado en module .md + CHANGELOG.
- **Sidebar filtered ocultaría tabs huérfanas** si las hubiera. Mitigación: cleanupOrphanTabs post-migration + logging.

## Risk

**HIGH** — toca data model, vault interaction, UI sidebar, MCP tools, Excel semantics. Mitigación:

- Branch separate `hotfix/H1H2H3`
- Backups explícitos `*.pre-migration-20260510.json` ya creados
- Time Machine snapshot manual antes del primer write
- Migration con dry-run flag
- 3 sub-bloques con commit + CI verde por sub-bloque
- Validación visual via MCP por sub-bloque
- Rollback claro: `git checkout main` + restore desde `.pre-migration-20260510.json`

## Referencias

- ADR 0003 — Default identity uses defaultSession
- ADR 0015 — Workspace model + lock 1-1
- ADR 0017 — Proxy model (afectado indirect: byWorkspace ahora afecta indirect a identidades)
- Audit del plan H1+H2+H3 — encontró 7 CRITICAL bloqueantes resueltos en este ADR
- `docs/history/19-bloque-hotfixes-resultado.md` — cierre del bloque (al finalizar H3c)
