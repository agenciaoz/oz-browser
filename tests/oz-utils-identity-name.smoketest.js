// OZ Browser — oz-utils.identityName smoke test (alpha.115).
//
//   node tests/oz-utils-identity-name.smoketest.js
//
// Verifica el fallback a la identity Default cuando un tab tiene un identityId
// que no resuelve (identity borrada / tab sin binding). oz-utils.js es un IIFE
// que se cuelga de window.OZ.utils; lo cargamos con un window/global fake.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(
  path.join(__dirname, '..', 'browser', 'ui', 'oz-utils.js'),
  'utf-8',
)
const sandbox = { window: {} }
sandbox.window.window = sandbox.window
vm.createContext(sandbox)
vm.runInContext(src, sandbox)
const { identityName } = sandbox.window.OZ.utils

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log('  ✓ ' + name)
}

console.log('oz-utils.identityName smoke test')

const ids = [
  { id: 'default', name: 'Default', isDefault: true },
  { id: 'ig', name: 'Contexto IG' },
]

ok('resuelve por id', identityName(ids, 'ig') === 'Contexto IG')
ok('id default', identityName(ids, 'default') === 'Default')
ok(
  'id borrado → cae a Default (no "Unknown")',
  identityName(ids, 'id-borrado-123') === 'Default',
)
ok('identityId null → cae a Default', identityName(ids, null) === 'Default')
ok(
  'sin Default en la lista → "Unknown"',
  identityName([{ id: 'ig', name: 'IG' }], 'x') === 'Unknown',
)
ok('lista vacía → "Unknown"', identityName([], 'x') === 'Unknown')
ok('no-array defensivo → "Unknown"', identityName(null, 'x') === 'Unknown')

console.log(`\n=== ${passed} passed · 0 failed ===`)
process.exit(0)
