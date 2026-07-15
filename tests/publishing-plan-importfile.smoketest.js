// OZ Browser — Publishing E5 importFile smoke test (v2.0.0-alpha.104).
//   node tests/publishing-plan-importfile.smoketest.js
//
// Cubre: excel-io.readSheetMatrix (round-trip real .xlsx → matriz) y que la
// matriz resultante alimenta la lógica pura de publishing-plan (parse → drafts).

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp' } }
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

const os = require('os')
const path = require('path')
const fs = require('fs')
const ExcelJS = require('exceljs')
const { readSheetMatrix } = require('../browser/excel-io')
const P = require('../browser/ui/publishing-plan')

let passed = 0
let failed = 0
const failures = []
function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

console.log('OZ Browser — publishing plan importFile smoke test\n')
;(async () => {
  // Build a small .xlsx with the plan headers.
  const tmp = path.join(os.tmpdir(), `oz-plan-${Date.now()}.xlsx`)
  const wb = new ExcelJS.Workbook()
  const sh = wb.addWorksheet('Plan')
  sh.addRow(['date', 'platform', 'caption', 'media', 'identities'])
  sh.addRow(['2026-08-01', 'ig', 'Hola mundo', '/tmp/a.jpg', 'id1; id2'])
  sh.addRow(['', 'x', 'Solo texto', '', 'id3'])
  sh.addRow(['', 'noexiste', 'plataforma mala', '', 'id4']) // → error
  await wb.xlsx.writeFile(tmp)

  const matrix = await readSheetMatrix(tmp)
  ok(
    'readSheetMatrix devuelve array de filas',
    Array.isArray(matrix) && matrix.length === 4,
  )
  ok('fila 0 = headers', matrix[0][0] === 'date' && matrix[0][1] === 'platform')
  ok('celda vacía → ""', matrix[2][0] === '')

  const rows = P.matrixToPlanRows(matrix)
  ok('matrixToPlanRows mapea 3 filas de datos', rows.length === 3)

  const { publications, errors } = P.parsePlanRows(rows)
  ok(
    '2 publicaciones válidas (ig + x)',
    publications.length === 2,
    `got ${publications.length}`,
  )
  ok('1 error (plataforma inválida)', errors.length === 1, `got ${errors.length}`)
  ok(
    'todas arrancan en draft',
    publications.every((p) => p.status === 'draft'),
  )
  ok(
    'ig mapea identities split',
    publications[0].platform === 'instagram' && publications[0].identities.length === 2,
  )

  try {
    fs.unlinkSync(tmp)
  } catch (_e) {
    /* ignore */
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  process.exit(0)
})()
