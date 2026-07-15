// OZ Browser — Excel I/O para accounts (1.5e CORE).
//
// Doc: docs/modules/excel-io.md
// ADR: docs/architecture/0008-account-vault-encryption.md (xlsx CVEs → exceljs)
// Bloque: 1.5e
//
// Export/import .xlsx con exceljs (pre-instalado, libre de CVEs vs xlsx
// community que tiene CVE-2023-30533 + CVE-2024-22363 sin patch).
//
// Columnas v1 (orden fijo):
//   Workspace | Identity | Site | Username | Password | 2FA Secret |
//   Last Login | Status | Cookies Count | Last IP | Notes
//
// Round-trip lossless: export → manda a oficina externa → editan/limpian →
// devuelven Excel → import en OVERWRITE_TOTAL → estado idéntico al
// que vino del Excel.
//
// 4 modos de import (decisión Jose original del plan):
//   - PERMANENT_MERGE: agrega/actualiza accounts manteniendo lo que YA HAY.
//   - EPHEMERAL_SESSION: crea sessions in-memory, todo se descarta al cerrar.
//     (1.5e v1 lo soporta como flag — la lógica de no-persist requiere
//     modificar el vault, lo dejamos pendiente para 1.5f UI; el handler
//     devuelve la lista parseada sin persistir).
//   - NEW_WORKSPACE: crea workspace nuevo dedicado, sin tocar existentes.
//   - OVERWRITE_TOTAL: reemplaza TODO el vault con el contenido del Excel.
//     Snapshot al Time Machine antes (1.6 — por ahora solo flag warning).

const ExcelJS = require('exceljs')
const log = require('./logger')

const COLUMN_DEFS = [
  { key: 'workspace', header: 'Workspace', width: 18 },
  { key: 'identity', header: 'Identity', width: 18 },
  { key: 'site', header: 'Site', width: 22 },
  { key: 'username', header: 'Username', width: 22 },
  { key: 'password', header: 'Password', width: 24 },
  { key: 'totpSecret', header: '2FA Secret', width: 22 },
  { key: 'lastLoginAt', header: 'Last Login', width: 18 },
  { key: 'status', header: 'Status', width: 14 },
  { key: 'cookiesCount', header: 'Cookies Count', width: 12 },
  { key: 'lastIp', header: 'Last IP', width: 16 },
  { key: 'notes', header: 'Notes', width: 30 },
]

const IMPORT_MODES = [
  'PERMANENT_MERGE',
  'EPHEMERAL_SESSION',
  'NEW_WORKSPACE',
  'OVERWRITE_TOTAL',
]

/**
 * Export accounts to .xlsx file.
 *
 * @param {array} accounts - vault accounts (decrypted, plaintext password)
 * @param {object} maps - { identityById, workspaceById } — for resolving names
 * @param {string} filePath - where to write the .xlsx
 * @returns {Promise<{rows, filePath}>}
 */
async function exportAccounts(accounts, maps, filePath) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'OZ Browser'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet('Accounts')
  sheet.columns = COLUMN_DEFS

  // Header row styling
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F1F2E' },
  }
  headerRow.font.color = { argb: 'FFFFFFFF' }

  for (const a of accounts) {
    const identityName =
      (maps.identityById && maps.identityById[a.identityId]) || a.identityId || ''
    const workspaceName =
      (maps.workspaceById && maps.workspaceById[a.workspaceId]) || a.workspaceId || ''
    const cookiesCount = Array.isArray(a.cookies) ? a.cookies.length : 0
    const lastLoginIso = a.lastLoginAt ? new Date(a.lastLoginAt).toISOString() : ''
    sheet.addRow({
      workspace: workspaceName,
      identity: identityName,
      site: a.site || '',
      username: a.username || '',
      password: a.password || '',
      totpSecret: a.totpSecret || '',
      lastLoginAt: lastLoginIso,
      status: a.status || 'active',
      cookiesCount,
      lastIp: a.lastIp || '',
      notes: a.notes || '',
    })
  }

  await workbook.xlsx.writeFile(filePath)
  log.info('excel-io', 'export ok', {
    filePath,
    rows: accounts.length,
  })
  return { rows: accounts.length, filePath }
}

/**
 * Import accounts from .xlsx. Returns parsed rows + lists of identity/
 * workspace names that need to be resolved/created by the caller. Caller
 * decides what to do with them based on the import mode.
 *
 * @param {string} filePath
 * @returns {Promise<{rows, identityNamesNeeded, workspaceNamesNeeded}>}
 */
async function importAccounts(filePath) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.worksheets[0]
  if (!sheet) {
    throw new Error('Excel file has no worksheets')
  }

  // Detect column indices by header name (tolerates reordered columns).
  const headerRow = sheet.getRow(1)
  const colByKey = {}
  for (const col of COLUMN_DEFS) {
    for (let i = 1; i <= sheet.columnCount; i++) {
      const cellValue = headerRow.getCell(i).value
      if (
        cellValue &&
        String(cellValue).trim().toLowerCase() === col.header.toLowerCase()
      ) {
        colByKey[col.key] = i
        break
      }
    }
  }

  const rows = []
  const identityNamesNeeded = new Set()
  const workspaceNamesNeeded = new Set()

  for (let rowIdx = 2; rowIdx <= sheet.rowCount; rowIdx++) {
    const row = sheet.getRow(rowIdx)
    const get = (key) => {
      const idx = colByKey[key]
      if (!idx) return null
      const v = row.getCell(idx).value
      if (v === null || v === undefined) return null
      // exceljs may return rich-text objects, formula objects, dates, etc.
      if (typeof v === 'object' && v.text) return String(v.text)
      if (v instanceof Date) return v.toISOString()
      return String(v)
    }

    const username = get('username')
    const password = get('password')
    const site = get('site')
    if (!username || !password || !site) continue // skip incomplete rows

    const identityName = get('identity') || 'Default'
    const workspaceName = get('workspace') || ''

    if (identityName) identityNamesNeeded.add(identityName)
    if (workspaceName) workspaceNamesNeeded.add(workspaceName)

    const lastLoginStr = get('lastLoginAt')
    const lastLoginAt = lastLoginStr ? Date.parse(lastLoginStr) || null : null

    rows.push({
      identityName,
      workspaceName: workspaceName || null,
      site,
      username,
      password,
      totpSecret: get('totpSecret') || null,
      lastLoginAt,
      status: get('status') || 'active',
      lastIp: get('lastIp') || null,
      notes: get('notes') || '',
    })
  }

  log.info('excel-io', 'import parsed ok', {
    filePath,
    rows: rows.length,
    identityNamesNeeded: identityNamesNeeded.size,
    workspaceNamesNeeded: workspaceNamesNeeded.size,
  })

  return {
    rows,
    identityNamesNeeded: Array.from(identityNamesNeeded),
    workspaceNamesNeeded: Array.from(workspaceNamesNeeded),
  }
}

/**
 * Read the first worksheet of an .xlsx into a raw matrix (array of arrays,
 * row 0 = headers). Generic — used by the Publishing plan import (E5), which
 * maps headers itself via ui/publishing-plan.js. exceljs rich cells are
 * flattened to strings; empty cells become ''.
 * @param {string} filePath
 * @returns {Promise<Array<Array<string>>>}
 */
async function readSheetMatrix(filePath) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('Excel file has no worksheets')
  const flat = (v) => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object' && v.text) return String(v.text)
    if (v instanceof Date) return v.toISOString()
    return String(v)
  }
  const matrix = []
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r)
    const cells = []
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(flat(row.getCell(c).value))
    matrix.push(cells)
  }
  return matrix
}

module.exports = {
  exportAccounts,
  importAccounts,
  readSheetMatrix,
  COLUMN_DEFS,
  IMPORT_MODES,
}
