// OZ Browser — country-locale + fingerprint-handlers smoke test (1.9d).
//
// Cómo correr:
//   cd oz-browser
//   node tests/country-locale.smoketest.js
//
// Cubre:
//   - resolveCountry: códigos válidos comunes (US, ES, JP, BR), case-insensitive,
//     unknown returns null, empty/null inputs handled.
//   - listCountries: returns sorted unique array.
//   - fingerprint-handlers.applyGeoSuggestion via country code (resolves table
//     internally) y via explicit timezone/languages object.
//   - proxy-handlers.assignToIdentity returns geoSuggestion when proxy.country
//     is known.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-cl-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

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

console.log('OZ Browser — country-locale + handlers smoke test')

// ---------- 1. resolveCountry ----------------------------------------------
section('resolveCountry: standard codes')
{
  const { resolveCountry, listCountries } = require('../browser/country-locale.js')
  const us = resolveCountry('US')
  ok('US country=US', us.country === 'US')
  ok('US timezone NY', us.timezone === 'America/New_York')
  ok('US language en-US', us.languages[0] === 'en-US')
  ok('US locale en-US', us.locale === 'en-US')

  const ar = resolveCountry('AR')
  ok('AR Buenos Aires', ar.timezone === 'America/Argentina/Buenos_Aires')
  ok('AR es-AR', ar.languages[0] === 'es-AR')

  const jp = resolveCountry('JP')
  ok('JP Tokyo', jp.timezone === 'Asia/Tokyo')
  ok('JP ja-JP', jp.languages[0] === 'ja-JP')

  // Case-insensitive
  ok('lowercase us', resolveCountry('us').country === 'US')
  ok('mixed-case Br', resolveCountry('Br').country === 'BR')

  // Unknown
  ok('unknown returns null', resolveCountry('XX') === null)
  ok('null returns null', resolveCountry(null) === null)
  ok('empty returns null', resolveCountry('') === null)
  ok('non-string returns null', resolveCountry(123) === null)

  // listCountries
  const all = listCountries()
  ok('listCountries non-empty', all.length > 30)
  ok('listCountries sorted', all[0] < all[all.length - 1])
  ok('listCountries dedupe', all.length === new Set(all).size)
  ok('returned array does not mutate table', listCountries() !== listCountries())
}

// ---------- 2. fingerprint-handlers.applyGeoSuggestion ---------------------
section('fingerprint-handlers.applyGeoSuggestion: country code + explicit')
{
  delete require.cache[require.resolve('../browser/fingerprint-engine.js')]
  delete require.cache[require.resolve('../browser/fingerprint-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  const { FingerprintEngine } = require('../browser/fingerprint-engine.js')
  const { buildFingerprintHandlers } = require('../browser/fingerprint-handlers.js')

  const fe = new FingerprintEngine()
  const fakeIM = {
    get: (id) => (id === 'id-1' ? { id: 'id-1', fingerprintSeed: 'seed-1' } : null),
  }
  const broadcasts = []
  const browser = {
    fingerprintEngine: fe,
    identityManager: fakeIM,
    broadcastToWebUI(channel, payload) {
      broadcasts.push({ channel, payload })
    },
  }
  const h = buildFingerprintHandlers(browser)

  const before = h.get('id-1')
  ok('initial profile has UA', !!before.ua)
  const ua0 = before.ua
  const blueprint0 = before.blueprintId

  // Apply via country code
  const r = h.applyGeoSuggestion('id-1', { country: 'JP' })
  ok('applied via country', r && !r.__error)
  ok('timezone Tokyo', r.timezone === 'Asia/Tokyo')
  ok('language ja-JP', r.languages[0] === 'ja-JP')
  ok('locale ja-JP', r.locale === 'ja-JP')
  ok('UA preserved', r.ua === ua0)
  ok('blueprint preserved', r.blueprintId === blueprint0)
  ok(
    'broadcast fired',
    broadcasts.some((b) => b.channel === 'oz:fingerprint:changed'),
  )

  // Apply via explicit
  const r2 = h.applyGeoSuggestion('id-1', {
    timezone: 'Europe/Berlin',
    languages: ['de-DE', 'de'],
    locale: 'de-DE',
  })
  ok('explicit applied', r2.timezone === 'Europe/Berlin')

  // Unknown country
  const r3 = h.applyGeoSuggestion('id-1', { country: 'XX' })
  ok(
    'unknown country returns __error',
    r3.__error && r3.__error.code === 'UNKNOWN_COUNTRY',
  )

  // Unknown identity
  const r4 = h.applyGeoSuggestion('nope', { country: 'US' })
  ok(
    'unknown identity returns __error',
    r4.__error && r4.__error.code === 'IDENTITY_NOT_FOUND',
  )
}

// ---------- 3. proxy-handlers.assignToIdentity returns geoSuggestion -------
section(
  'proxy-handlers.assignToIdentity: surfaces geoSuggestion when proxy.country known',
)
{
  delete require.cache[require.resolve('../browser/proxy-manager.js')]
  delete require.cache[require.resolve('../browser/proxy-assignment.js')]
  delete require.cache[require.resolve('../browser/proxy-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  const { ProxyManager } = require('../browser/proxy-manager.js')
  const { ProxyAssignment } = require('../browser/proxy-assignment.js')
  const { buildProxyHandlers } = require('../browser/proxy-handlers.js')

  const pm = new ProxyManager()
  const pa = new ProxyAssignment({ proxyManager: pm })
  // Create a proxy WITH a country
  const ar = pm.create({ host: 'ar-pr.example.com', port: 8080, country: 'AR' })
  const us = pm.create({ host: 'us-pr.example.com', port: 8080, country: 'US' })
  const noCountry = pm.create({ host: 'mystery.example.com', port: 8080 })

  // Fake identityManager (proxy-handlers asks for sessions to apply, so we
  // need a stub that does not throw on getSession).
  const fakeIM = {
    get: (id) => ({ id }),
    getSession: () => ({ setProxy: async () => {} }),
  }
  const browser = {
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: fakeIM,
    windows: [],
    broadcastToWebUI() {},
  }
  const h = buildProxyHandlers(browser)

  const r1 = h.assignToIdentity('id-1', ar.id)
  ok('ok', r1.ok === true)
  ok('geoSuggestion present (AR)', r1.geoSuggestion && r1.geoSuggestion.country === 'AR')
  ok(
    'geoSuggestion has correct timezone',
    r1.geoSuggestion.timezone === 'America/Argentina/Buenos_Aires',
  )

  const r2 = h.assignToIdentity('id-2', us.id)
  ok('US suggestion country US', r2.geoSuggestion.country === 'US')
  ok('US timezone NY', r2.geoSuggestion.timezone === 'America/New_York')

  // Proxy without country → no suggestion
  const r3 = h.assignToIdentity('id-3', noCountry.id)
  ok('no suggestion when proxy.country missing', r3.geoSuggestion === null)
  ok('still ok', r3.ok === true)

  // Clear assignment
  const r4 = h.assignToIdentity('id-1', null)
  ok('clear assignment ok', r4.ok === true)
  ok('clear has no suggestion', r4.geoSuggestion === null)

  // assignToWorkspace also returns geoSuggestion
  const r5 = h.assignToWorkspace('ws-1', ar.id)
  ok('workspace geoSuggestion', r5.geoSuggestion && r5.geoSuggestion.country === 'AR')
}

// ---------- Cleanup --------------------------------------------------------
Module._load = originalLoad
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
