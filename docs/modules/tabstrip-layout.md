# Módulo `tabstrip-layout`

**Path:** `browser/ui/tabstrip-layout.js`
**Líneas:** ~143
**Bloque:** tabs multi-fila + drag-reorder

## Qué hace

Lógica matemática PURA (sin DOM) del tabstrip multi-fila + reorder, compartida por el renderer (`tabstrip.js`) y el main (`tabs.js`/window-manager para el inset dinámico). El tab strip es 1 fila por defecto y hace "auto-expand con tope": crece a 2..maxRows SOLO cuando las tabs caerían por debajo de `minTabWidth`. Dual-export (node + `window.OZ.TabstripLayout`).

## Exporta / API

| Función                                           | Descripción                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `moveItem(arr, from, to)`                         | Copia de `arr` con el elemento movido (drag-and-drop); clampa índices.    |
| `dropTargetIndex(fromIndex, targetIndex, side)`   | Mapea el slot visual (`before`/`after`) al índice de `moveItem`.          |
| `clampMaxRows(v)`                                 | Tope de filas válido en `[1, MAX_ROWS]` (default 3).                      |
| `rowCountFor(opts)`                               | Filas que ocupa el tabstrip para `count` tabs sin bajar de `minTabWidth`. |
| `chromeTopInset(opts)`                            | Alto del chrome superior (px) según las filas (top inset del contenido).  |
| `MAX_ROWS` / `ROW_HEIGHT` / `BASE_TOOLBAR_HEIGHT` | Constantes (3 / 32 / 64).                                                 |

## IPC / MCP

No registra IPC directamente (lógica pura). El reorder se aplica vía IPC `oz:tabs:reorder` y el tool MCP `oz.tabs.reorder` (en `tabs.js`/`tab-ipc-setup.js`); el inset dinámico via `oz:chrome:setRows`.

## Gotchas

- Dual-export: node y browser global.
- `rowCountFor` devuelve 1 ante count ≤ 0 o ancho/minTab inválidos; `perRow = floor(width/minTab)`.
- `chromeTopInset`: 1 fila = base (64); cada fila extra suma `rowHeight` (32).
- `dropTargetIndex` compensa -1 cuando el item se mueve de izquierda a derecha (remover primero corre los índices).
- ROW_HEIGHT/BASE_TOOLBAR_HEIGHT deben quedar sincronizados con el CSS de webui.html y tabs.js.
- ADR 0005 (modular).
