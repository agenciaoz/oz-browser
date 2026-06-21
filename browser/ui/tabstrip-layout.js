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

  const MAX_ROWS = 4 // tope duro del feature (1..4)
  const ROW_HEIGHT = 32 // alto de una fila de tabs en px (sync con CSS .tab)
  const BASE_TOOLBAR_HEIGHT = 64 // chrome superior con 1 fila (sync tabs.js)
  // Piso absoluto del ancho de una tab (px). Cuando hay tantas tabs que ni a
  // `minTabWidth` entran en `maxRows`, las tabs se ACHICAN hasta este piso —
  // estilo Chrome: queda solo el favicon (+ la franja de identidad) y entran
  // muchas más antes de tocar el tope de filas.
  const HARD_MIN_TAB = 32
  // Por debajo de este ancho el título no es legible → modo compacto: ocultar
  // título/dot, dejar solo el favicon (el ✕ queda solo en la tab activa).
  const COMPACT_TAB_WIDTH = 100

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

  /**
   * Mapea el slot de inserción visual de un drag (antes/después de la tab
   * objetivo) al índice `to` que espera moveItem(). Cuando el item se mueve
   * de izquierda a derecha, removerlo primero corre los índices uno a la
   * izquierda → se compensa con -1.
   *
   * @param {number} fromIndex    índice actual de la tab arrastrada.
   * @param {number} targetIndex  índice de la tab sobre la que se suelta.
   * @param {'before'|'after'} side
   * @returns {number} índice destino para moveItem.
   */
  function dropTargetIndex(fromIndex, targetIndex, side) {
    const f = _int(fromIndex)
    const t = _int(targetIndex)
    const insert = side === 'after' ? t + 1 : t
    return insert > f ? insert - 1 : insert
  }

  /** Tope de filas válido: entero en [1, MAX_ROWS], default 3 ante basura. */
  function clampMaxRows(v) {
    const n = _int(v)
    if (!Number.isFinite(n) || n < 1) return MAX_ROWS
    return Math.min(MAX_ROWS, n)
  }

  /**
   * Layout completo del tabstrip: cuántas filas y qué ancho fijar por tab.
   *
   * Dos regímenes:
   *  1. Holgura: las tabs entran en ≤ `maxRows` filas sin bajar de `minTabWidth`.
   *     → `tabWidth: null` (el CSS achica de su ancho natural a `minTabWidth` y
   *     recién ahí envuelve; comportamiento histórico).
   *  2. Saturación: hay tantas tabs que ni a `minTabWidth` entran en `maxRows`.
   *     → se ACHICAN todas a un ancho fijo (`tabWidth` px) para que TODAS entren
   *     dentro del tope de filas, hasta el piso `hardMinTabWidth`. Esto evita que
   *     las tabs sobrantes envuelvan a filas que quedan tapadas por la página.
   *
   * @param {object} opts
   * @param {number} opts.count            cantidad de tabs.
   * @param {number} opts.containerWidth   ancho disponible del tab-list (px).
   * @param {number} [opts.minTabWidth=120] piso "cómodo" antes de envolver.
   * @param {number} [opts.hardMinTabWidth=54] piso absoluto al achicar.
   * @param {number} [opts.maxRows=4]
   * @returns {{rows:number, tabWidth:number|null, compact:boolean}}
   */
  function tabLayout(opts) {
    const o = opts || {}
    const count = Math.max(0, _int(o.count))
    const width = _num(o.containerWidth)
    const minTab = _num(o.minTabWidth, 120)
    const hardMin = _num(o.hardMinTabWidth, HARD_MIN_TAB)
    const maxRows = clampMaxRows(o.maxRows == null ? MAX_ROWS : o.maxRows)
    if (count <= 0 || !(width > 0) || !(minTab > 0)) {
      return { rows: 1, tabWidth: null, compact: false }
    }
    const perRowAtFloor = Math.max(1, Math.floor(width / minTab))
    const neededRows = Math.ceil(count / perRowAtFloor)
    if (neededRows <= maxRows) {
      // Entran con holgura: dejá que el flex achique naturalmente.
      return { rows: Math.max(1, neededRows), tabWidth: null, compact: false }
    }
    // Saturación: fijá un ancho achicado para meter todo en `maxRows` filas.
    const perRowNeeded = Math.ceil(count / maxRows)
    const shrunk = Math.max(hardMin, Math.floor(width / perRowNeeded))
    const perRowActual = Math.max(1, Math.floor(width / shrunk))
    const rows = Math.min(maxRows, Math.max(1, Math.ceil(count / perRowActual)))
    return { rows, tabWidth: shrunk, compact: shrunk < COMPACT_TAB_WIDTH }
  }

  /**
   * Filas que ocupa el tabstrip (compat). Delega en {@link tabLayout}.
   * @param {object} opts  ver tabLayout.
   * @returns {number} filas en [1, maxRows]
   */
  function rowCountFor(opts) {
    return tabLayout(opts).rows
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
    dropTargetIndex,
    clampMaxRows,
    tabLayout,
    rowCountFor,
    chromeTopInset,
    MAX_ROWS,
    ROW_HEIGHT,
    BASE_TOOLBAR_HEIGHT,
    HARD_MIN_TAB,
    COMPACT_TAB_WIDTH,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.TabstripLayout = api
  }
})()
