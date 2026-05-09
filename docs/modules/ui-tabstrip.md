# Módulo `ui-tabstrip`

**Path:** `browser/ui/tabstrip.js`
**Líneas:** 158
**Bloque:** 1.2 ✅

## Qué hace

Top tabstrip de la WebUI. Muestra TODAS las tabs (across all identities) con stripe del color de la identity. Click activa, X cierra, + crea tab en active identity. Botones de navegación (back/forward/reload) y omnibox usan `window.oz.nav`.

## Class `TabStrip`

| Estado          | Descripción                           |
| --------------- | ------------------------------------- |
| `tabs[]`        | Array de tab serializations cacheado. |
| `identities[]`  | Idem identities.                      |
| `activeOzTabId` | Tab actualmente seleccionado.         |

| Método               | Descripción                                               |
| -------------------- | --------------------------------------------------------- |
| `init()`             | Carga inicial via window.oz + subscribe a eventos.        |
| `handleEvent(info)`  | Aplica delta del evento `oz:tabs:updated` al cache local. |
| `handleCreate()`     | + button — abre tab en active identity.                   |
| `render()`           | Re-render completo del tabstrip.                          |
| `renderTabNode(tab)` | DOM de un tab con stripe de color.                        |
| `renderToolbar(tab)` | Actualiza la URL del omnibox.                             |

## Color stripe

```css
boxshadow:
  inset 3px 0 0 0 <identity-color>,
  inset -1px 0 0 0 rgba(0, 0, 0, 0.33);
```

3px stripe a la izquierda del tab con el color de su identity.

## Gotchas

- Reusa el `<template id="tabtemplate">` heredado del shell (lo mismo que usaba el TabStrip original que iba contra chrome.tabs).
- chrome.windows.\* (minimize/maximize/close) sigue siendo chrome API porque el WebContentsView del browser chrome es una Chrome extension.
- Lazy tabs se renderizan con opacity 0.7 para distinguirlas visualmente.

## Referencias

- Boot: [`ui-webui.md`](ui-webui.md).
- Sidebar par: [`ui-sidebar.md`](ui-sidebar.md).
- IPC: [`ipc-handlers.md`](ipc-handlers.md).
