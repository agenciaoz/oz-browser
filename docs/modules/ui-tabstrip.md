# Módulo `ui-tabstrip`

**Path:** `browser/ui/tabstrip.js`
**Líneas:** ~341
**Bloque:** 1.2 ✅ (+ multi-fila/reorder alpha.65; shrink-to-fit estilo Chrome alpha.92; inset medido alpha.93; foco omnibox alpha.94)

## Qué hace

Top tabstrip de la WebUI. Muestra TODAS las tabs (across all identities) con stripe del color de la identity. Click activa, X cierra, + crea tab en active identity. Botones de navegación (back/forward/reload) y omnibox usan `window.oz.nav`. Tabs multi-fila con tope duro (4 filas) + drag-reorder; al saturarse el cupo las tabs se achican estilo Chrome (ver `applyRows`).

## Class `TabStrip`

| Estado          | Descripción                           |
| --------------- | ------------------------------------- |
| `tabs[]`        | Array de tab serializations cacheado. |
| `identities[]`  | Idem identities.                      |
| `activeOzTabId` | Tab actualmente seleccionado.         |

| Método               | Descripción                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init()`             | Carga inicial via window.oz + subscribe a eventos + listener `resize` → `applyRows`.                                                                                                                                                                                                                                                                                                    |
| `loadMaxRows()`      | Lee el setting `tabStrip.maxRows` (clampeado por `clampMaxRows`) para el tope de filas.                                                                                                                                                                                                                                                                                                 |
| `handleEvent(info)`  | Aplica delta del evento `oz:tabs:updated` al cache local.                                                                                                                                                                                                                                                                                                                               |
| `handleCreate()`     | + button — abre tab en active identity.                                                                                                                                                                                                                                                                                                                                                 |
| `render()`           | Re-render completo del tabstrip; en `rAF` siguiente llama `applyRows`.                                                                                                                                                                                                                                                                                                                  |
| `applyRows()`        | Mide el ancho disponible y llama `TabstripLayout.tabLayout`; fija `--oz-tab-rows`/`--oz-tab-basis`/`--oz-tab-min`/`data-compact`. alpha.93: además MIDE el alto real del DOM (filas por `offsetTop` + alto de fila por `getBoundingClientRect`) → fija `--oz-toolbar-push` exacto y reporta a main `oz.chrome.setRows(rows, insetPx)` con el inset = borde inferior real de la toolbar. |
| `wireDrag(node,tab)` | Drag-and-drop reorder (HTML5) con indicador before/after → `oz.tabs.reorder`.                                                                                                                                                                                                                                                                                                           |
| `renderTabNode(tab)` | DOM de un tab con stripe de color + label compacto + dot de identidad.                                                                                                                                                                                                                                                                                                                  |
| `renderToolbar(tab)` | Actualiza la URL del omnibox.                                                                                                                                                                                                                                                                                                                                                           |

## Color stripe

```css
boxshadow:
  inset 3px 0 0 0 <identity-color>,
  inset -1px 0 0 0 rgba(0, 0, 0, 0.33);
```

3px stripe a la izquierda del tab con el color de su identity.

## Multi-fila / shrink-to-fit (alpha.65 → alpha.92)

La matemática vive en [`tabstrip-layout.md`](tabstrip-layout.md) (pura). `applyRows` es el puente al DOM:

- Mide el ancho disponible sobre el **contenedor** (`.tab-container`), descontando el botón `+` y un margen para la zona de arrastre — NO sobre `.tab-list`, cuyo ancho depende del wrap actual (circular).
- Fija SIEMPRE `--oz-tab-basis` (+`--oz-tab-min`) al `tabWidth` calculado: el `flex-wrap` rompe filas por el basis, así que ése es el único valor que hace que el navegador envuelva donde queremos. Sin esto reaparecen filas infinitas (bug alpha.91).
- Setea `data-compact` en el `<ul>` cuando `tabLayout` lo indica → CSS favicon-only (`.tab-list[data-compact]`: oculta título/dot, ✕ solo en la activa).
- **alpha.93 (NO usar constantes para el alto del chrome):** el push de la toolbar (`--oz-toolbar-push`) y el inset de la página se MIDEN del DOM real, no se estiman con `ROW_HEIGHT`. Antes, con 4 filas, el desfase 30px(CSS)/32px(JS) descuadraba el chrome y enterraba la barra de URL bajo el `.tab-container` fijo. Se manda el `insetPx` exacto (borde inferior real de `.topbar .toolbar`) a `oz.chrome.setRows(rows, insetPx)`.

## Omnibox / foco (alpha.94)

Por ADR 0011 el `WebContentsView` de la página se pinta ENCIMA del HTML del chrome y RETIENE el foco de teclado. El omnibox (barra de URL) por eso NO recibía el teclado con una pestaña activa. Igual que todos los modales del WebUI, el input ahora hace `oz.ui.setContentVisible(false)` en `focus` (le cede el teclado al chrome) y `setContentVisible(true)` en `blur`; tras navegar con Enter llama `this.$.url.blur()` para restaurar la vista. Si tocás otro elemento interactivo persistente del chrome y no recibe teclado, aplicale el mismo patrón.

## Gotchas

- Reusa el `<template id="tabtemplate">` heredado del shell (lo mismo que usaba el TabStrip original que iba contra chrome.tabs).
- chrome.windows.\* (minimize/maximize/close) sigue siendo chrome API porque el WebContentsView del browser chrome es una Chrome extension.
- Lazy tabs se renderizan con opacity 0.7 para distinguirlas visualmente.
- `applyRows` corre en el `rAF` post-render (el `clientWidth` necesita un frame tras resetear `innerHTML`) y en cada `resize`.
- Cualquier cambio al CSS de `.tab` (basis/min/max-width, padding, alto de fila) debe quedar en sync con las constantes de `tabstrip-layout.js`.

## Referencias

- Boot: [`ui-webui.md`](ui-webui.md).
- Sidebar par: [`ui-sidebar.md`](ui-sidebar.md).
- IPC: [`ipc-handlers.md`](ipc-handlers.md).
