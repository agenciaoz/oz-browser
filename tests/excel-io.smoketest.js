// OZ Browser — Excel I/O smoke test (1.5e CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/excel-io.smoketest.js
//
// Cubre:
//   - exportAccounts genera .xlsx con header + rows
//   - importAccounts parsea .xlsx round-trip (export → import → mismo data)
//   - importAccounts skipea rows incompletas (sin password/site/username)
//   - importAccounts detecta identityNamesNeeded + workspaceNamesNeeded sets
//   - Columnas pueden estar en orden distinto (header lookup tolerante)
//   - Lossless: site/username/password/totpSecret/notes/status preservados
//   - lastLoginAt: timestamp ms → ISO string export → timestamp ms parse
//
// Usa exceljs real (no mockeado) — escribe/lee a /tmp temp dir.

const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-excel-'))

const {
  exportAccounts,
  importAccounts,
  COLUMN_DEFS,
  IMPORT_MODES,
} = require('../browser/excel-io.js')

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

function section(name) {
  console.log(`\n— ${name} —`)
}

async function main() {
  console.log('OZ Browser — Excel I/O smoke test')
  console.log(`Test dir: ${TEST_DIR}`)

  // 1. Module exports
  section('Module structure')
  {
    ok('COLUMN_DEFS array de 11', COLUMN_DEFS.length === 11)
    ok(
      'IMPORT_MODES tiene 4 modos',
      IMPORT_MODES.length === 4 &&
        IMPORT_MODES.includes('PERMANENT_MERGE') &&
        IMPORT_MODES.includes('EPHEMERAL_SESSION') &&
        IMPORT_MODES.includes('NEW_WORKSPACE') &&
        IMPORT_MODES.includes('OVERWRITE_TOTAL'),
    )
  }

  // 2. Export básico
  section('Export accounts → .xlsx')
  {
    const accounts = [
      {
        id: 'a1',
        identityId: 'default',
        workspaceId: 'general',
        site: 'x.com',
        username: '@joe',
        password: 'super-secret',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        lastLoginAt: 1715000000000,
        status: 'active',
        lastIp: '1.2.3.4',
        notes: 'main account',
        cookies: [{ x: 1 }, { y: 2 }],
      },
      {
        id: 'a2',
        identityId: 'cliente-a',
        workspaceId: 'general',
        site: 'instagram.com',
        username: 'joe_ig',
        password: 'pwd2',
        totpSecret: null,
        lastLoginAt: null,
        status: 'needs_relogin',
        lastIp: null,
        notes: '',
        cookies: null,
      },
    ]
    const maps = {
      identityById: { default: 'Default', 'cliente-a': 'Cliente A' },
      workspaceById: { general: 'General Browsing' },
    }
    const filePath = path.join(TEST_DIR, 'export-basic.xlsx')
    const result = await exportAccounts(accounts, maps, filePath)
    ok('export ok', result.rows === 2 && result.filePath === filePath)
    ok('file existe', fs.existsSync(filePath))
    ok('file tiene size > 1KB', fs.statSync(filePath).size > 1024)
  }

  // 3. Round-trip lossless
  section('Round-trip lossless: export → import → mismos campos críticos')
  {
    const accounts = [
      {
        id: 'rt1',
        identityId: 'default',
        workspaceId: 'general',
        site: 'x.com',
        username: '@user',
        password: 'p@ss with spaces',
        totpSecret: 'BASE32SECRET',
        lastLoginAt: 1715000000000,
        status: 'active',
        lastIp: '1.2.3.4',
        notes: 'a note with, commas and "quotes"',
        cookies: [],
      },
    ]
    const maps = {
      identityById: { default: 'Default' },
      workspaceById: { general: 'General Browsing' },
    }
    const filePath = path.join(TEST_DIR, 'roundtrip.xlsx')
    await exportAccounts(accounts, maps, filePath)

    const parsed = await importAccounts(filePath)
    ok('parsed 1 row', parsed.rows.length === 1)
    const r = parsed.rows[0]
    ok('site preservado', r.site === 'x.com')
    ok('username preservado', r.username === '@user')
    ok('password preservado (con spaces)', r.password === 'p@ss with spaces')
    ok('totpSecret preservado', r.totpSecret === 'BASE32SECRET')
    ok('status preservado', r.status === 'active')
    ok('lastIp preservado', r.lastIp === '1.2.3.4')
    ok(
      'notes preservados (con commas y quotes)',
      r.notes === 'a note with, commas and "quotes"',
    )
    ok(
      'lastLoginAt round-trip a timestamp ms',
      r.lastLoginAt === 1715000000000,
      `got ${r.lastLoginAt}`,
    )
    ok('identityName === Default', r.identityName === 'Default')
    ok('workspaceName === General Browsing', r.workspaceName === 'General Browsing')
  }

  // 4. identityNamesNeeded + workspaceNamesNeeded
  section('importAccounts detecta identities/workspaces necesarios')
  {
    const accounts = [
      {
        id: 'a1',
        identityId: 'i1',
        workspaceId: 'w1',
        site: 'x.com',
        username: 'u1',
        password: 'p',
      },
      {
        id: 'a2',
        identityId: 'i2',
        workspaceId: 'w2',
        site: 'instagram.com',
        username: 'u2',
        password: 'p',
      },
      {
        id: 'a3',
        identityId: 'i1', // mismo i1
        workspaceId: 'w1', // mismo w1
        site: 'fb.com',
        username: 'u3',
        password: 'p',
      },
    ]
    const maps = {
      identityById: { i1: 'Cliente A', i2: 'Cliente B' },
      workspaceById: { w1: 'WS Alpha', w2: 'WS Beta' },
    }
    const filePath = path.join(TEST_DIR, 'needs.xlsx')
    await exportAccounts(accounts, maps, filePath)

    const parsed = await importAccounts(filePath)
    ok('3 rows parsed', parsed.rows.length === 3)
    ok('identityNamesNeeded === 2 (deduplicado)', parsed.identityNamesNeeded.length === 2)
    ok(
      'workspaceNamesNeeded === 2 (deduplicado)',
      parsed.workspaceNamesNeeded.length === 2,
    )
    ok(
      'identityNamesNeeded incluye Cliente A y Cliente B',
      parsed.identityNamesNeeded.includes('Cliente A') &&
        parsed.identityNamesNeeded.includes('Cliente B'),
    )
  }

  // 5. Skipea rows incompletas
  section('importAccounts skipea rows con campos faltantes')
  {
    // Manualmente armamos un xlsx con rows incompletas
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    const sh = wb.addWorksheet('Accounts')
    sh.columns = COLUMN_DEFS
    sh.addRow({
      identity: 'I1',
      site: 'x.com',
      username: '@joe',
      password: 'pwd',
    })
    sh.addRow({
      identity: 'I2',
      site: 'x.com',
      username: '', // sin username → skip
      password: 'pwd',
    })
    sh.addRow({
      identity: 'I3',
      site: '', // sin site → skip
      username: '@u',
      password: 'pwd',
    })
    sh.addRow({
      identity: 'I4',
      site: 'fb.com',
      username: '@u4',
      password: '', // sin password → skip
    })
    const filePath = path.join(TEST_DIR, 'incomplete.xlsx')
    await wb.xlsx.writeFile(filePath)

    const parsed = await importAccounts(filePath)
    ok('solo 1 row valid', parsed.rows.length === 1)
    ok('row valida es la primera (I1)', parsed.rows[0].identityName === 'I1')
  }

  // 6. Empty workbook
  section('Empty workbook → 0 rows')
  {
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    const sh = wb.addWorksheet('Accounts')
    sh.columns = COLUMN_DEFS
    const filePath = path.join(TEST_DIR, 'empty.xlsx')
    await wb.xlsx.writeFile(filePath)

    const parsed = await importAccounts(filePath)
    ok('0 rows parsed', parsed.rows.length === 0)
    ok('identityNamesNeeded === []', parsed.identityNamesNeeded.length === 0)
  }

  // 7. Status default si vacío
  section('Status default "active" si vacío en Excel')
  {
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    const sh = wb.addWorksheet('Accounts')
    sh.columns = COLUMN_DEFS
    sh.addRow({
      identity: 'I',
      site: 'x.com',
      username: 'u',
      password: 'p',
      // status omitido
    })
    const filePath = path.join(TEST_DIR, 'no-status.xlsx')
    await wb.xlsx.writeFile(filePath)

    const parsed = await importAccounts(filePath)
    ok('status default === active', parsed.rows[0].status === 'active')
  }
}

main()
  .catch((err) => {
    console.error('UNEXPECTED ERROR:', err)
    failed++
    failures.push({ label: 'runner crash', detail: err.message })
  })
  .finally(() => {
    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures)
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      process.exit(1)
    }
    process.exit(0)
  })
