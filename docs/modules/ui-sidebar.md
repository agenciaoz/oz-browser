# Módulo `ui-sidebar`

**Path:** `browser/ui/sidebar.js`
**Líneas:** ~340
**Bloque:** 1.2 ✅

## Qué hace

Sidebar lateral izquierda con la lista de Identities y sus tabs agrupadas. CRUD inline (rename con doble-click, delete via context menu, + button hover-revealed para crear tab en esa identity).

## Class `IdentitySidebar`

| Estado | Descripción |
|---|---|
| `identities[]` | Cache de identities. |
| `tabs[]` | Cache de todas las tabs. |
| `activeIdentityId` | Identity activa (chip highlighted). |
| `activeOzTabId` | Tab activo. |

| Método | Descripción |
|---|---|
| `init()` | Carga inicial + subscribe a oz:identities:changed/active-changed/tabs:updated. |
| `refresh()` | Re-fetch de toda la data. |
| `handleTabEvent(info)` | Delta-update del cache. |
| `handleNewIdentity()` | Inline input (window.prompt está bloqueado en Electron). |
| `handleNewTabIn(id)` | + button hover. |
| `handleSelectTab(ozTabId)` | window.oz.tabs.select. |
| `handleCloseTab(ozTabId, ev)` | window.oz.tabs.close. |
| `handleSelectIdentity(id)` | window.oz.identities.setActive. |
| `handleRenameIdentity(id, currentName, rowEl)` | Inline editor. |
| `handleEditIdentity(identity)` | Abre modal completo via `window.OZ.IdentityEditor.open(identity)`. |
| `handleDeleteIdentity(identity)` | confirm() + window.oz.identities.remove. |
| `showContextMenu(e, identity)` | Right-click → Rename / Edit identity… / Delete. |
| `render()` | Re-render del DOM completo. |
| `renderIdentityRow(identity)` / `renderTabItem(tab, identity)` | DOM helpers. Renderiza chip color, nombre, contador `(n)` con tabs de la identity, botón `+` (hover-revealed). Default identity recibe class `default` + dot indicator. |

## Layout HTML target

```
#oz-sidebar (220px wide, var --bg-elevated)
  ├─ button.new-identity (+ New Identity)
  ├─ div.header "IDENTITIES"
  └─ #oz-identity-list
      └─ .identity (per identity)
          ├─ .identity-row[.default?][.active?]
          │   ├─ .identity-chip (color dot)
          │   ├─ .identity-name (con · trailing si Default)
          │   ├─ .identity-count (n)
          │   └─ .add-tab (hover-revealed)
          └─ .identity-tabs
              └─ .oz-tab (per tab)
                  ├─ .oz-favicon
                  ├─ .oz-title
                  └─ .oz-close (hover-revealed)
```

## Gotchas

- `window.prompt()` bloqueado en Electron (security default Electron 17+). Usamos input inline para la creación de identity y rename.
- Cap CSS de 220px → SIDEBAR_WIDTH constant en `browser/tabs.js` debe match (sino Tab content overlap).
- `dblclick` en row → rename. Misma row tiene `click` → setActive. Browser dispara click ANTES que dblclick — para evitar setActive flash, podemos delay con setTimeout pero por ahora lo dejamos así (no es problema visible).
- Lazy tabs se muestran en italic + color muted para distinguirlas.

## Referencias

- IPC: [`ipc-handlers.md`](ipc-handlers.md).
- Top par: [`ui-tabstrip.md`](ui-tabstrip.md).
- Estilo: en [`ui-webui-html.md`](ui-webui-html.md).
