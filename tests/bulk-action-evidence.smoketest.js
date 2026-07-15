// OZ Browser — bulk-action-evidence smoke test (v2.0.0-alpha.105).
//   node tests/bulk-action-evidence.smoketest.js

const os = require('os')
const path = require('path')
const fs = require('fs')
const { captureEvidence } = require('../browser/bulk-action-evidence')

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

console.log('OZ Browser — bulk-action-evidence smoke test\n')

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-ev-'))
const electron = { app: { getPath: () => tmpBase } }

// Fake window whose capturePage returns a fake image with toPNG().
function fakeWin() {
  return {
    webContents: {
      capturePage: async () => ({ toPNG: () => Buffer.from('PNGDATA') }),
    },
  }
}
;(async () => {
  // Happy path: writes a PNG under userData/publish-evidence and returns path.
  const r = await captureEvidence(fakeWin(), {
    identityId: 'id-1',
    actionId: 'ig_post',
    electron,
  })
  ok('devuelve evidencePath', !!r.evidencePath, JSON.stringify(r))
  ok('el archivo existe en disco', r.evidencePath && fs.existsSync(r.evidencePath))
  ok(
    'está bajo publish-evidence/',
    r.evidencePath && r.evidencePath.includes('publish-evidence'),
  )
  ok(
    'nombre incluye actionId',
    r.evidencePath && path.basename(r.evidencePath).includes('ig_post'),
  )

  // Best-effort: si capturePage falla, NO tira y devuelve {} (no rompe el post).
  const bad = {
    webContents: {
      capturePage: async () => {
        throw new Error('boom')
      },
    },
  }
  const r2 = await captureEvidence(bad, { identityId: 'x', actionId: 'x_post', electron })
  ok('captura fallida → {} sin throw', r2 && r2.evidencePath === undefined)

  // win sin webContents → tampoco tira.
  const r3 = await captureEvidence({}, { actionId: 'fb_post', electron })
  ok('win inválido → {} sin throw', r3 && r3.evidencePath === undefined)

  try {
    fs.rmSync(tmpBase, { recursive: true, force: true })
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
