# Módulo `ui-workspace-switcher`

**Path:** `browser/ui/workspace-switcher.js`
**Líneas:** ~290
**Bloque/Etapa:** 1.4-WS (Fase 1.4c)

## Qué hace

Componente WebUI que renderiza el switcher de workspaces como pills horizontales arriba del sidebar de identities. Maneja CRUD inline (rename, duplicate, freeze/unfreeze, archive/restore, delete) vía right-click context menu y el `+ New Workspace` con inline editor (mismo patrón que `IdentitySidebar.handleNewIdentity`).

## Layout

```
┌─── Sidebar ────────────────────┐
│ WORKSPACES                     │  ← header section
│ [● General] [● Cliente A]      │  ← pills (active highlighted)
│ [+ New Workspace]              │  ← inline editor button
│ [Hide archived (2)]            │  ← visible solo si hay archived
│ ─────────────────────────────  │
│ [+ New Identity]               │  ← sidebar de identities (como antes)
│  ▸ Default    (3)              │
│    - tab 1                     │
│  ▸ Custom 1   (1)              │
└────────────────────────────────┘
```

## Interacciones

| Acción           | Cómo                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| Switch workspace | Click en pill → `oz.workspaces.setActive(id)`                                   |
| Rename           | Double-click en pill → input inline · o right-click → "Rename"                  |
| Duplicate        | Right-click → "Duplicate" — no auto-switch al duplicado                         |
| Freeze/Unfreeze  | Right-click → "Freeze" / "Unfreeze". Frozen pill muestra 🔒 + name muted        |
| Archive/Restore  | Right-click → "Archive". Archivados ocultos por default; toggle "Show archived" |
| Delete           | Right-click → "Delete workspace" → confirm con tab count                        |
| New workspace    | Click "+ New Workspace" → inline input → Enter para crear + auto-switch         |

## Lock UX

Cuando `setActive` retorna `{ok: false, reason: 'already-open'}`, el switcher muestra un alert "This workspace is already open in another window." El user debe ir a esa ventana y hacer switch ahí, o cerrarla.

## Archivados

- Por default ocultos (UX limpio).
- Toggle `Show archived (N)` aparece solo cuando hay ≥ 1 archivado, mostrando el count.
- Cuando se restoran, el pill vuelve al flujo normal.

## Frozen workspaces

- Visual: 🔒 icon delante del nombre + name color muted.
- CRUD del usuario rechazado: rename queda disabled en el menu, alert si se intenta.
- Switch al WS frozen sigue permitido — runtime navigation no se bloquea (ADR 0015).

## Eventos consumidos

- `oz:workspaces:changed` → refresh completo (lista + active).
- `oz:workspaces:active-changed` → solo updatea `activeWorkspaceId` y re-render (sin re-fetch).

## Dependencias

- `window.oz.workspaces` (preload bridge) — los 15 IPC channels expuestos.
- `window.OZ.utils.safe` — wrap de promesas con error reporting al main.
- `oz-utils.js` debe cargarse antes (dependency en script tags).

## Convenciones

- Mismo patrón IIFE que el resto de scripts UI (clash de `const safe` en classic scripts compartiendo lexical scope global — ver comment en `tabstrip.js`).
- Inline editors usan blur + Enter para commit, Escape para cancel (replica `handleNewIdentity`).
- Context menu reusa CSS `.ctx-menu` ya definido en `webui.html` para identity menu.

## Testing

- No tests unitarios (JS UI sin DOM virtual sería poco aporte). Visual smoke test al cierre del bloque.

## Referencias

- [`workspace-handlers.md`](workspace-handlers.md) — IPC backend.
- [`workspace-manager.md`](workspace-manager.md) — modelo de datos.
- [`ui-sidebar.md`](ui-sidebar.md) — sidebar adyacente, mismo patrón de inline editor.
- [ADR 0015](../architecture/0015-workspace-model.md) — modelo + freeze semantics.
- [ADR 0011](../architecture/0011-modals-hide-content-view.md) — patrón ctx-menu (no requiere hide content view porque es overlay HTML, no requiere cubrir WebContentsView).
