// OZ Browser — Tabstrip layout math (multi-row + reorder). Pure, dual-export.
//
// Lógica testeable (sin DOM) que comparte el renderer (tabstrip.js) y el main
// (tabs.js / window-manager para el inset dinámico del contenido). Cubre:
//   - moveItem(arr, from, to)      → reordenar una lista (drag-and-drop).
//   - clampMaxRows(v)              → tope de filas válido (1..MAX_ROWS, def 3).
//   - rowCountFor(opts)            → cuántas filas ocupa el tabstrip ahora.
//   - chromeTopInset(opts)         → alto del chrome superior según las filas
//                                    (para que el contenido no tape las filas).
//
// El tab strip por defecto es 1 fila; "auto-expand con tope": crece a 2..maxRows
// SOLO cuando las tabs llegarían por debajo de `minTabWidth`. Nunca roba alto
// vertical de más cuando hay pocas tabs.
//
// ADR: 0005 (modular). UI: webui.html (.tab-list flex-wrap) + tabstrip.js.

;(function () {
  'use strict'

  const MAX_ROWS = 3 // tope duro del feature (1..3)
  const ROW_HEIGHT = 32 // alto de una fila de tabs en px (sync con CSS .tab)
  const BASE_TOOLBAR_HEIGHT = 64 // chrome superior con 1 fila (sync tabs.js)

  /**
   * Devuelve una copia de `arr` con el elemento en `from` movido a `to`.
   * Clampa índices fuera de rango; no-op si son iguales o el array es chico.
   *
   * @template T
   * @param {T[]} arr
   * @param {number} from
   * @param {number} to
   * @returns {T[]}
   */
  function moveItem(arr, from, to) {
    if (!Array.isArray(arr) || arr.length < 2)
      return Array.isArray(arr) ? arr.slice() : []
    const n = arr.length
    let f = _int(from)
    let t = _int(to)
    if (f < 0) f = 0
    if (f > n - 1) f = n - 1
    if (t < 0) t = 0
    if (t > n - 1) t = n - 1
    if (f === t) return arr.slice()
    const copy = arr.slice()
    const [item] = copy.splice(f, 1)
    copy.splice(t, 0, item)
    return copy
  }

  /** Tope de filas válido: entero en [1, MAX_ROWS], default 3 ante basura. */
  function clampMaxRows(v) {
    const n = _int(v)
    if (!Number.isFinite(n) || n < 1) return MAX_ROWS
    return Math.min(MAX_ROWS, n)
  }

  /**
   * Filas que ocupa el tabstrip para `count` tabs en un ancho `containerWidth`,
   * sin que ninguna tab baje de `minTabWidth`, hasta `maxRows`.
   *
   * @param {object} opts
   * @param {number} opts.count           cantidad de tabs.
   * @param {number} opts.containerWidth  ancho disponible del tab-list (px).
   * @param {number} [opts.minTabWidth=120]
   * @param {number} [opts.maxRows=3]
   * @returns {number} filas en [1, maxRows]
   */
  function rowCountFor(opts) {
    const o = opts || {}
    const count = Math.max(0, _int(o.count))
    const width = _num(o.containerWidth)
    const minTab = _num(o.minTabWidth, 120)
    const maxRows = clampMaxRows(o.maxRows == null ? MAX_ROWS : o.maxRows)
    if (count <= 0 || !(width > 0) || !(minTab > 0)) return 1
    const perRow = Math.max(1, Math.floor(width / minTab))
    const needed = Math.ceil(count / perRow)
    return Math.min(maxRows, Math.max(1, needed))
  }

  /**
   * Alto del chrome superior (px) para `rows` filas. Con 1 fila = base; cada
   * fila extra suma `rowHeight`. Es el `y` (top inset) del WebContentsView de
   * la página para que las filas extra no queden tapadas.
   *
   * @param {object} opts
   * @param {number} opts.rows
   * @param {number} [opts.rowHeight=32]
   * @param {number} [opts.baseToolbarHeight=64]
   * @returns {number}
   */
  function chromeTopInset(opts) {
    const o = opts || {}
    const rows = Math.max(1, _int(o.rows, 1))
    const rowH = _num(o.rowHeight, ROW_HEIGHT)
    const base = _num(o.baseToolbarHeight, BASE_TOOLBAR_HEIGHT)
    return Math.round(base + (rows - 1) * rowH)
  }

  function _int(v, fallback = 0) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : fallback
  }
  function _num(v, fallback = 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }

  const api = {
    moveItem,
    clampMaxRows,
    rowCountFor,
    chromeTopInset,
    MAX_ROWS,
    ROW_HEIGHT,
    BASE_TOOLBAR_HEIGHT,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.TabstripLayout = api
  }
})()
