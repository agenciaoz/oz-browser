# Bloque K1 (bulk-open) — 1-click "Open all identities" desde workspace context menu

**Status:** ✅ K1 bulk-open shortcut cerrado 2026-05-15
**Commit:** `93b21cc`
**Version:** 1.4.0 (minor bump — primer K1-extras)
**Tiempo efectivo:** ~30min (backend ya existía completo)
**Deps nuevas:** ninguna
**Tests nuevos:** +14 (workspace-context-menu.smoketest.js)

## Origen

Per roadmap `project_v1_roadmap.md` K1-extras: "Bulk-open workspace (1-click → todas las identities en tabs)". El use case: Jose abre su workspace de "Insta" con 50 identities → quiere las 50 tabs abiertas con un click, sin abrir el modal genérico, picking platform default URL.

## Hallazgo durante exploración

El bulk-opener **ya estaba completo desde 1.5/C-4**:

- `browser/bulk-opener.js` (265 LOC) — orchestrator con dos modos: `bulkOpenFromExisting` (abre N identities ya creadas) + `bulkCreateNew` (crea N identities + abre tab cada una).
- `browser/bulk-opener-handlers.js` — IPC handlers + 5 channels expuestos.
- `browser/ui/bulk-opener.js` — modal complete con mode toggle + identity multi-select + target workspace selector + URL pattern preview.
- Accesible via command-palette (`Cmd+K → Bulk open`).

**Lo único faltante**: el 1-click shortcut desde el sidebar. Tenías que abrir command palette → escribir "bulk" → seleccionar → modal → checks → URL. ~5 clicks.

## Cambios v1.4.0

### `browser/workspace-context-menu.js`

Nueva entry agregada entre Duplicate + Quick Tabs:

```js
const identityCount = (ws.identityIds && ws.identityIds.length) || 0
template.push({
  label: `Open all identities in tabs… (${identityCount})`,
  enabled: !ws.isFrozen && !ws.isArchived && identityCount > 0,
  click: () => {
    browser.broadcastToWebUI('oz:bulk-open:open', {
      mode: 'existing',
      workspaceId: ws.id,
      identityIds: (ws.identityIds || []).slice(),
    })
  },
})
```

Enabled gates: workspace tiene >0 identities + no frozen + no archived. Click envía broadcast con payload pre-fill.

### `preload.js` — `bulkOpen.onOpen` extended

Antes: `cb()` sin args. Ahora: `(_e, payload) => cb(payload || undefined)`. El payload incluye `{mode, workspaceId, identityIds}` cuando viene desde el context menu.

### `browser/ui/bulk-opener.js` — `open(payload?)` accepts pre-fill

- `this.mode = payload.mode` si es 'existing' o 'create'
- `this.selected = new Set()` + add cada `identityId` que existe en la lista actual (defensive: ignora unknown IDs si workspace cambió entre right-click y modal open)
- `this.activeWorkspaceId = payload.workspaceId` para que `_renderTargetOptions` pre-seleccione

User flow nuevo: right-click workspace → "Open all identities… (N)" → modal abre con todo seleccionado + workspace target preset → user tipea URL → Go.

**~5 clicks → 2 clicks**.

## Tests

`tests/workspace-context-menu.smoketest.js` (~165 LOC, **14 asserts**, archivo nuevo):

- **Basic shape** (3): template no vacío, contains Rename/Duplicate/Freeze/Quick Tabs, "Open all identities…" entry exists
- **Entry detail** (3): label muestra `(N)` count, enabled cuando identities > 0, label format consistent
- **Enabled gates** (3): empty workspace disabled, frozen disabled, archived disabled
- **Click handler** (2): broadcasts `oz:bulk-open:open` con payload correcto (mode='existing', workspaceId, identityIds array de length 3)
- **Edge cases** (3): no workspaceManager → empty template, unknown wsId → single disabled placeholder, default workspace has Open all entry pero NO Delete

Suite full verde. Lint clean. `check:loc` max 499.

## Version bumps

- `package.json` 1.3.0 → 1.4.0 (minor bump per versioning_policy)
- `browser/ui/manifest.json` 1.3.0 → 1.4.0

## Pendiente

Smoke visual REAL pendiente: right-click workspace en sidebar → "Open all identities… (N)" debe aparecer con el count → click → modal con pre-fill → workspace + identities seleccionadas.

## Próximo (1.4.x)

Per K1-extras restantes:

- `1.4.1` Session warmer template Scheduled Actions (~2h) ← NEXT
- `1.4.2` Mac sleep/wake proxy re-scan (~2h)
- `1.4.3` Identity HUD widget arriba-derecha (~3h)
- `1.4.4` Onboarding wizard 5-step (~3h)
