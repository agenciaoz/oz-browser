# Módulo `tabstrip-layout`

**Path:** `browser/ui/tabstrip-layout.js`
**Líneas:** ~193
**Bloque:** tabs multi-fila + drag-reorder

## Qué hace

Lógica matemática PURA (sin DOM) del tabstrip multi-fila + reorder, compartida por el renderer (`tabstrip.js`) y el main (`tabs.js`/window-manager para el inset dinámico). Dual-export (node + `window.OZ.TabstripLayout`).

Modelo de layout (estilo Chrome, desde alpha.92): el tabstrip crece hasta un **tope duro de `MAX_ROWS` filas (4)**. `tabLayout()` arranca del ancho cómodo `PREFERRED_TAB_WIDTH` (192px ≈ 12rem) y, si a ese ancho las tabs necesitarían más de `maxRows` filas, las **achica lo justo** para que TODAS entren dentro del tope — hasta el piso clickeable `HARD_MIN_TAB` (32px, favicon-only). Nunca apila filas infinitas ni esconde tabs detrás de la página.

### Por qué `tabLayout` fija SIEMPRE un ancho (gotcha central)

El `flex-wrap` del CSS decide el salto de fila usando el **flex-basis**, NO el `min-width`. El modelo viejo (≤ alpha.91) dejaba `basis: 12rem` y contaba filas asumiendo que las tabs se achicaban a `minTabWidth` (120) antes de envolver — falso: envolvían a 192px sin achicarse → muchas más filas que el tope (bug "no hay límite de filas"). Por eso ahora el renderer aplica `tabWidth` como `flex-basis` (y `min-width`): así el ancho con el que el navegador envuelve es exactamente el que calculamos.

## Exporta / API

| Función                                         | Descripción                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `moveItem(arr, from, to)`                       | Copia de `arr` con el elemento movido (drag-and-drop); clampa índices.                                                                      |
| `dropTargetIndex(fromIndex, targetIndex, side)` | Mapea el slot visual (`before`/`after`) al índice de `moveItem`.                                                                            |
| `clampMaxRows(v)`                               | Tope de filas válido en `[1, MAX_ROWS]` (default `MAX_ROWS`).                                                                               |
| `tabLayout(opts)`                               | `{rows, tabWidth, compact}` — filas, ancho a fijar (px) y si va en modo compacto (favicon-only).                                            |
| `rowCountFor(opts)`                             | Compat: filas que ocupa el tabstrip. Delega en `tabLayout(opts).rows`.                                                                      |
| `chromeTopInset(opts)`                          | Alto del chrome superior (px) según las filas (top inset del contenido).                                                                    |
| Constantes                                      | `MAX_ROWS` (4), `ROW_HEIGHT` (32), `BASE_TOOLBAR_HEIGHT` (64), `HARD_MIN_TAB` (32), `COMPACT_TAB_WIDTH` (100), `PREFERRED_TAB_WIDTH` (192). |

### `tabLayout(opts)`

| Opt               | Default                     | Descripción                                                    |
| ----------------- | --------------------------- | -------------------------------------------------------------- |
| `count`           | —                           | Cantidad de tabs.                                              |
| `containerWidth`  | —                           | Ancho disponible para las tabs (px). El renderer mide estable. |
| `preferredWidth`  | `192` (alias `minTabWidth`) | Ancho cómodo de arranque.                                      |
| `hardMinTabWidth` | `32`                        | Piso absoluto al achicar.                                      |
| `maxRows`         | `MAX_ROWS` (4)              | Tope duro de filas.                                            |

Devuelve `tabWidth: null` solo cuando no hay tabs o el ancho es 0 (el renderer cae al default cómodo). `compact` es `true` cuando `tabWidth < COMPACT_TAB_WIDTH` (100): el CSS oculta título/dot y deja solo el favicon (el ✕ queda en la tab activa).

## IPC / MCP

No registra IPC directamente (lógica pura). El reorder se aplica vía IPC `oz:tabs:reorder` y el tool MCP `oz.tabs.reorder` (en `tabs.js`/`tab-ipc-setup.js`); el inset dinámico via `oz:chrome:setRows`.

## Gotchas

- Dual-export: node y browser global.
- **El renderer DEBE fijar `tabWidth` como `flex-basis` y `min-width`** (vars `--oz-tab-basis` / `--oz-tab-min`). Si no, el wrap del CSS no coincide con el cálculo y reaparecen filas de más (bug alpha.91).
- `tabLayout` calcula el nº de filas con el MISMO ancho con el que el CSS envuelve; el segundo paso (achicar) garantiza `rows ≤ maxRows`.
- `compact` (`tabWidth < 100`): modo favicon-only en CSS (`.tab-list[data-compact]`). Piso 32px ≈ favicon + franja de identidad.
- `tabWidth: null` ante count ≤ 0 o ancho/fit inválidos.
- `chromeTopInset`: 1 fila = base (64); cada fila extra suma `rowHeight` (32).
- `dropTargetIndex` compensa -1 cuando el item se mueve de izquierda a derecha (remover primero corre los índices).
- `ROW_HEIGHT`/`BASE_TOOLBAR_HEIGHT`/`PREFERRED_TAB_WIDTH` deben quedar sincronizados con el CSS de webui.html (`--oz-tab-row-h`, `.tab` basis/max-width) y tabs.js.
- El tope de filas es configurable vía setting `tabStrip.maxRows` (clampeado a `[1, MAX_ROWS]` por `clampMaxRows`).
- ADR 0005 (modular).
