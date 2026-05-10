// URL normalize smoke test — hotfix post-Etapa-3d.
//
// Cubre el bug que Jose reportó: tipear "x.com" en el omnibox no navegaba
// porque webContents.loadURL falla con ERR_INVALID_ARGUMENT sin scheme.

const assert = require('assert')
const { normalizeOmniboxInput } = require('../browser/url-normalize')

let run = 0,
  passed = 0
function test(name, fn) {
  run++
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
  }
}

console.log('\n[url-normalize] tests\n')

console.log('[empty / invalid]')
test('null on empty string', () => assert.strictEqual(normalizeOmniboxInput(''), null))
test('null on whitespace only', () =>
  assert.strictEqual(normalizeOmniboxInput('   \t\n'), null))
test('null on undefined', () =>
  assert.strictEqual(normalizeOmniboxInput(undefined), null))
test('null on number', () => assert.strictEqual(normalizeOmniboxInput(42), null))

console.log('\n[passes scheme through]')
test('https URL passes through', () =>
  assert.strictEqual(normalizeOmniboxInput('https://x.com'), 'https://x.com'))
test('http URL passes through', () =>
  assert.strictEqual(normalizeOmniboxInput('http://example.com'), 'http://example.com'))
test('https with path + query', () =>
  assert.strictEqual(
    normalizeOmniboxInput('https://github.com/agenciaoz/oz-browser?ref=main'),
    'https://github.com/agenciaoz/oz-browser?ref=main',
  ))
test('file:// passes through', () =>
  assert.strictEqual(
    normalizeOmniboxInput('file:///Users/jose/test.html'),
    'file:///Users/jose/test.html',
  ))
test('chrome:// passes through', () =>
  assert.strictEqual(normalizeOmniboxInput('chrome://settings'), 'chrome://settings'))
test('about:blank passes through', () =>
  assert.strictEqual(normalizeOmniboxInput('about:blank'), 'about:blank'))
test('view-source: passes through', () =>
  assert.strictEqual(
    normalizeOmniboxInput('view-source:https://x.com'),
    'view-source:https://x.com',
  ))
test('ftp:// passes through', () =>
  assert.strictEqual(
    normalizeOmniboxInput('ftp://files.example.com'),
    'ftp://files.example.com',
  ))
test('trims whitespace before scheme check', () =>
  assert.strictEqual(normalizeOmniboxInput('  https://x.com  '), 'https://x.com'))

console.log('\n[domain-like → prepend https://]')
test('bare domain → https://', () =>
  assert.strictEqual(normalizeOmniboxInput('x.com'), 'https://x.com'))
test('subdomain → https://', () =>
  assert.strictEqual(normalizeOmniboxInput('mail.google.com'), 'https://mail.google.com'))
test('domain with path → https://', () =>
  assert.strictEqual(
    normalizeOmniboxInput('github.com/agenciaoz/oz-browser'),
    'https://github.com/agenciaoz/oz-browser',
  ))
test('domain with port → https://', () =>
  assert.strictEqual(normalizeOmniboxInput('localhost:9223'), 'https://localhost:9223'))
test('localhost bare → https://', () =>
  assert.strictEqual(normalizeOmniboxInput('localhost'), 'https://localhost'))
test('IPv4 with port → https://', () =>
  assert.strictEqual(normalizeOmniboxInput('127.0.0.1:9223'), 'https://127.0.0.1:9223'))
test('IPv4 bare → https://', () =>
  assert.strictEqual(normalizeOmniboxInput('192.168.1.1'), 'https://192.168.1.1'))
test('domain with hyphen → https://', () =>
  assert.strictEqual(
    normalizeOmniboxInput('my-app.example.com'),
    'https://my-app.example.com',
  ))
test('domain with query string → https://', () =>
  assert.strictEqual(
    normalizeOmniboxInput('google.com?q=test'),
    'https://google.com?q=test',
  ))

console.log('\n[search query → google]')
test('plain text → google search', () =>
  assert.strictEqual(
    normalizeOmniboxInput('best electron tutorial'),
    'https://www.google.com/search?q=best%20electron%20tutorial',
  ))
test('single word → google search', () =>
  assert.strictEqual(
    normalizeOmniboxInput('electron'),
    'https://www.google.com/search?q=electron',
  ))
test('text with special chars URL-encoded', () =>
  assert.strictEqual(
    normalizeOmniboxInput('how to use & or |'),
    'https://www.google.com/search?q=how%20to%20use%20%26%20or%20%7C',
  ))
test('text with emoji URL-encoded', () =>
  assert.strictEqual(
    normalizeOmniboxInput('🚀 launch'),
    'https://www.google.com/search?q=%F0%9F%9A%80%20launch',
  ))

console.log('\n[edge cases]')
test('TLD-only string treated as search (no dot)', () =>
  assert.strictEqual(normalizeOmniboxInput('com'), 'https://www.google.com/search?q=com'))
test('domain with trailing dot (rare but valid) → search (no match)', () =>
  // Domains like "example.com." are technically valid (root) but rare from user
  // input. We treat trailing-dot as search query — false negative, acceptable.
  assert.strictEqual(
    normalizeOmniboxInput('example.com.'),
    'https://www.google.com/search?q=example.com.',
  ))
test('user typing partial URL (typo "htps://x.com") → search', () =>
  // No scheme match (htps:// not http/https), no domain match (htps://x.com
  // has scheme-like prefix that fails domain regex), goes to search.
  assert.strictEqual(
    normalizeOmniboxInput('htps://x.com'),
    'https://www.google.com/search?q=htps%3A%2F%2Fx.com',
  ))

console.log(`\n[url-normalize] ${passed}/${run} passed\n`)
process.exit(passed === run ? 0 : 1)
