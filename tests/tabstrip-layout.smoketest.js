// OZ Browser — tabstrip-layout smoke test (multi-row + reorder math).
//
// Run:
//   cd oz-browser
//   node tests/tabstrip-layout.smoketest.js

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/ui/tabstrip-layout.js')]
const L = require(path.join('..', 'browser', 'ui', 'tabstrip-layout.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('tabstrip-layout smoke test')

// ---- moveItem (drag-and-drop reorder) --------------------------------------

ok('moveItem: moves forward and backward', () => {
  assert.deepStrictEqual(L.moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepStrictEqual(L.moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c'])
})

ok('moveItem: no-op when from===to; returns a copy', () => {
  const src = ['a', 'b', 'c']
  const out = L.moveItem(src, 1, 1)
  assert.deepStrictEqual(out, src)
  assert.notStrictEqual(out, src, 'is a copy, not the same ref')
})

ok('moveItem: clamps out-of-range indices', () => {
  assert.deepStrictEqual(L.moveItem(['a', 'b', 'c'], -5, 99), ['b', 'c', 'a'])
})

ok('moveItem: tolerates tiny/garbage arrays', () => {
  assert.deepStrictEqual(L.moveItem([], 0, 1), [])
  assert.deepStrictEqual(L.moveItem(['x'], 0, 0), ['x'])
  assert.deepStrictEqual(L.moveItem(null, 0, 1), [])
})

// ---- dropTargetIndex (drag-and-drop insertion math) ------------------------

ok('dropTargetIndex + moveItem land where the indicator shows', () => {
  const tabs = ['a', 'b', 'c', 'd'] // indices 0..3
  // Drag 'a' (0) to AFTER 'c' (2) → expected ['b','c','a','d']
  let to = L.dropTargetIndex(0, 2, 'after')
  assert.deepStrictEqual(L.moveItem(tabs, 0, to), ['b', 'c', 'a', 'd'])
  // Drag 'd' (3) to BEFORE 'b' (1) → expected ['a','d','b','c']
  to = L.dropTargetIndex(3, 1, 'before')
  assert.deepStrictEqual(L.moveItem(tabs, 3, to), ['a', 'd', 'b', 'c'])
  // Drag 'b' (1) to BEFORE 'a' (0) → expected ['b','a','c','d']
  to = L.dropTargetIndex(1, 0, 'before')
  assert.deepStrictEqual(L.moveItem(tabs, 1, to), ['b', 'a', 'c', 'd'])
  // Drag 'a' (0) to AFTER 'd' (3) → expected ['b','c','d','a']
  to = L.dropTargetIndex(0, 3, 'after')
  assert.deepStrictEqual(L.moveItem(tabs, 0, to), ['b', 'c', 'd', 'a'])
})

// ---- clampMaxRows -----------------------------------------------------------

ok('clampMaxRows: 1..MAX_ROWS, default on junk', () => {
  assert.strictEqual(L.clampMaxRows(1), 1)
  assert.strictEqual(L.clampMaxRows(2), 2)
  assert.strictEqual(L.clampMaxRows(3), 3)
  assert.strictEqual(L.clampMaxRows(9), L.MAX_ROWS)
  assert.strictEqual(L.clampMaxRows(0), L.MAX_ROWS)
  assert.strictEqual(L.clampMaxRows('x'), L.MAX_ROWS)
})

// ---- rowCountFor (auto-expand with cap) ------------------------------------

ok('rowCountFor: 1 row when tabs fit at min width', () => {
  // 1200px / 120 min = 10 per row; 8 tabs → 1 row
  assert.strictEqual(
    L.rowCountFor({ count: 8, containerWidth: 1200, minTabWidth: 120 }),
    1,
  )
})

ok('rowCountFor: expands to 2 then 3 as tabs grow', () => {
  // 1200/120 = 10 per row. 15 tabs → ceil(15/10)=2 rows.
  assert.strictEqual(
    L.rowCountFor({ count: 15, containerWidth: 1200, minTabWidth: 120 }),
    2,
  )
  // 25 tabs → ceil(25/10)=3 rows.
  assert.strictEqual(
    L.rowCountFor({ count: 25, containerWidth: 1200, minTabWidth: 120 }),
    3,
  )
})

ok('rowCountFor: never exceeds the cap (maxRows)', () => {
  // 100 tabs would need 10 rows, but cap is 3.
  assert.strictEqual(
    L.rowCountFor({ count: 100, containerWidth: 1200, minTabWidth: 120, maxRows: 3 }),
    3,
  )
  // explicit cap of 2 honored
  assert.strictEqual(
    L.rowCountFor({ count: 100, containerWidth: 1200, minTabWidth: 120, maxRows: 2 }),
    2,
  )
})

ok('rowCountFor: degenerate inputs → 1 row', () => {
  assert.strictEqual(L.rowCountFor({ count: 0, containerWidth: 1200 }), 1)
  assert.strictEqual(L.rowCountFor({ count: 5, containerWidth: 0 }), 1)
})

ok('MAX_ROWS is 4', () => {
  assert.strictEqual(L.MAX_ROWS, 4)
  assert.strictEqual(L.clampMaxRows(99), 4)
})

// ---- tabLayout (shrink-to-fit cuando satura) --------------------------------

ok('tabLayout: holgura → tabWidth null (deja achicar al flex)', () => {
  // 8 tabs entran en 1 fila a 120px (perRow=10) → sin ancho fijo.
  assert.deepStrictEqual(
    L.tabLayout({ count: 8, containerWidth: 1200, minTabWidth: 120 }),
    { rows: 1, tabWidth: null, compact: false },
  )
  // 25 tabs → 3 filas, todavía dentro del tope de 4 → sin ancho fijo.
  assert.deepStrictEqual(
    L.tabLayout({ count: 25, containerWidth: 1200, minTabWidth: 120 }),
    { rows: 3, tabWidth: null, compact: false },
  )
})

ok('tabLayout: saturación → achica las tabs y respeta tope de filas', () => {
  // 60 tabs en 1200px: a 120px entrarían 10/fila = 6 filas > 4 → satura.
  const r = L.tabLayout({ count: 60, containerWidth: 1200, minTabWidth: 120, maxRows: 4 })
  assert.ok(r.rows <= 4, 'no excede el tope de filas')
  assert.ok(r.tabWidth != null && r.tabWidth < 120, 'fija un ancho menor al piso cómodo')
  // El ancho fijado debe permitir meter las 60 en ≤4 filas.
  const perRow = Math.floor(1200 / r.tabWidth)
  assert.ok(Math.ceil(60 / perRow) <= 4, 'todas entran dentro del tope')
})

ok('tabLayout: muchísimas tabs → compacto (favicon-only) en el piso', () => {
  // 500 tabs: imposible legible; el ancho se clava en el piso y entra compacto.
  const r = L.tabLayout({ count: 500, containerWidth: 1200, maxRows: 4 })
  assert.strictEqual(r.tabWidth, L.HARD_MIN_TAB)
  assert.strictEqual(r.compact, true)
})

ok('tabLayout: saturación leve no necesariamente es compacta', () => {
  // 50 tabs en 1200px, 4 filas → perRowNeeded=13, shrunk=floor(1200/13)=92 < 100
  // (compacto). 44 tabs → perRowNeeded=11, shrunk=109 ≥ 100 → NO compacto.
  const mild = L.tabLayout({
    count: 44,
    containerWidth: 1200,
    minTabWidth: 120,
    maxRows: 4,
  })
  assert.ok(mild.tabWidth != null && mild.tabWidth >= L.COMPACT_TAB_WIDTH)
  assert.strictEqual(mild.compact, false)
})

ok('tabLayout: degenerados → 1 fila, sin ancho fijo', () => {
  assert.deepStrictEqual(L.tabLayout({ count: 0, containerWidth: 1200 }), {
    rows: 1,
    tabWidth: null,
    compact: false,
  })
  assert.deepStrictEqual(L.tabLayout({ count: 5, containerWidth: 0 }), {
    rows: 1,
    tabWidth: null,
    compact: false,
  })
})

// ---- chromeTopInset ---------------------------------------------------------

ok('chromeTopInset: base for 1 row, +rowHeight per extra row', () => {
  assert.strictEqual(L.chromeTopInset({ rows: 1 }), L.BASE_TOOLBAR_HEIGHT)
  assert.strictEqual(L.chromeTopInset({ rows: 2 }), L.BASE_TOOLBAR_HEIGHT + L.ROW_HEIGHT)
  assert.strictEqual(
    L.chromeTopInset({ rows: 3 }),
    L.BASE_TOOLBAR_HEIGHT + 2 * L.ROW_HEIGHT,
  )
})

ok('chromeTopInset: custom row height', () => {
  assert.strictEqual(
    L.chromeTopInset({ rows: 3, rowHeight: 30, baseToolbarHeight: 60 }),
    60 + 2 * 30,
  )
})

console.log(`\n✓ tabstrip-layout: ${passed} checks passed`)
