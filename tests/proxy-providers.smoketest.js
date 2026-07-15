// OZ Browser — proxy-providers smoke test (H-2k, v1.1.5).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-providers.smoketest.js
//
// Cubre expandOxylabs() — el único provider con implementación real en v1.
// Los stubs (brightdata/smartproxy/iproyal) retornan COMING_SOON; un check
// rápido confirma el patrón.

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/proxy-providers.js')]
const {
  expandOxylabs,
  expandDecodo,
  expandProvider,
  listProviders,
  PROVIDERS,
} = require('../browser/proxy-providers.js')

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

console.log('OZ Browser — proxy-providers smoke test')

// ============================================================================
console.log('\nexpandOxylabs — validation')
// ============================================================================

ok(
  'missing endpoint → MISSING_FIELDS',
  expandOxylabs({ customer: 'x', password: 'y', count: 1 }).__error.code ===
    'MISSING_FIELDS',
)
ok(
  'missing customer → MISSING_FIELDS',
  expandOxylabs({ endpoint: 'h:1', password: 'y', count: 1 }).__error.code ===
    'MISSING_FIELDS',
)
ok(
  'missing password → MISSING_FIELDS',
  expandOxylabs({ endpoint: 'h:1', customer: 'x', count: 1 }).__error.code ===
    'MISSING_FIELDS',
)
ok(
  'count = 0 → INVALID_COUNT',
  expandOxylabs({ endpoint: 'h:1', customer: 'x', password: 'y', count: 0 }).__error
    .code === 'INVALID_COUNT',
)
ok(
  'count = 1001 → INVALID_COUNT',
  expandOxylabs({ endpoint: 'h:1', customer: 'x', password: 'y', count: 1001 }).__error
    .code === 'INVALID_COUNT',
)
ok(
  'count = "10" string OK (Number coerce)',
  expandOxylabs({ endpoint: 'h:1', customer: 'x', password: 'y', count: '10' }).ok ===
    true,
)
ok(
  'count = 10.5 → INVALID_COUNT (not integer)',
  expandOxylabs({ endpoint: 'h:1', customer: 'x', password: 'y', count: 10.5 }).__error
    .code === 'INVALID_COUNT',
)
ok(
  'bad endpoint (no port) → INVALID_ENDPOINT',
  expandOxylabs({ endpoint: 'oxylabs.io', customer: 'x', password: 'y', count: 1 })
    .__error.code === 'INVALID_ENDPOINT',
)

// ============================================================================
console.log('\nexpandOxylabs — happy path')
// ============================================================================

const happyMin = expandOxylabs({
  endpoint: 'us-pr.oxylabs.io:10001',
  customer: 'mzewama',
  password: 'secret',
  count: 3,
})
ok('happy 3 → ok + 3 items', happyMin.ok && happyMin.items.length === 3)
ok(
  'item 0 host/port parsed',
  happyMin.items[0].host === 'us-pr.oxylabs.io' && happyMin.items[0].port === 10001,
)
ok('item 0 protocol = https', happyMin.items[0].protocol === 'https')
ok(
  'item 0 username has customer + sessid + sesstime',
  /^customer-mzewama-sessid-000001-sesstime-30$/.test(happyMin.items[0].username),
)
ok(
  'item 2 sessid = 000003 (sequential)',
  happyMin.items[2].username.includes('sessid-000003'),
)
ok(
  'tags include oxylabs',
  Array.isArray(happyMin.items[0].tags) && happyMin.items[0].tags.includes('oxylabs'),
)

// ============================================================================
console.log('\nexpandOxylabs — country')
// ============================================================================

const ctry = expandOxylabs({
  endpoint: 'pr.oxylabs.io:7777',
  customer: 'mz',
  password: 's',
  count: 2,
  country: 'AR',
})
ok(
  'country=AR injects cc-ar (lowercase) before sessid',
  /^customer-mz-cc-ar-sessid-/.test(ctry.items[0].username),
)
ok('tags include country', ctry.items[0].tags.includes('AR'))
ok('item.country = AR', ctry.items[0].country === 'AR')
ok('name mentions geo', ctry.items[0].name.includes('AR'))

// ============================================================================
console.log('\nexpandOxylabs — city (H-2k, v1.1.5)')
// ============================================================================

const cityCase = expandOxylabs({
  endpoint: 'pr.oxylabs.io:7777',
  customer: 'mz',
  password: 's',
  count: 1,
  country: 'US',
  city: 'New York',
})
ok(
  'city slugified lowercase + underscore between cc and sessid',
  /^customer-mz-cc-us-city-new_york-sessid-/.test(cityCase.items[0].username),
)
ok('tags include city', cityCase.items[0].tags.includes('New York'))
ok(
  'item.city = "New York" (preserves original casing)',
  cityCase.items[0].city === 'New York',
)
ok('name mentions country/city', cityCase.items[0].name.includes('US/New York'))

const cityNoCountry = expandOxylabs({
  endpoint: 'pr.oxylabs.io:7777',
  customer: 'mz',
  password: 's',
  count: 1,
  city: 'paris',
})
ok(
  'city without country still injects city- segment',
  /^customer-mz-city-paris-sessid-/.test(cityNoCountry.items[0].username),
)

// ============================================================================
console.log('\nexpandOxylabs — sticky toggle')
// ============================================================================

const rotating = expandOxylabs({
  endpoint: 'pr.oxylabs.io:7777',
  customer: 'mz',
  password: 's',
  count: 3,
  country: 'US',
  sticky: false,
})
ok(
  'sticky=false omits sessid + sesstime',
  /^customer-mz-cc-us$/.test(rotating.items[0].username),
)
ok(
  'rotating items all share same username (rotation = backend exit IP swap)',
  rotating.items[0].username === rotating.items[1].username &&
    rotating.items[0].username === rotating.items[2].username,
)
ok(
  'rotating name uses "rot N" suffix',
  /rot 1$/.test(rotating.items[0].name) && /rot 3$/.test(rotating.items[2].name),
)

// ============================================================================
console.log('\nexpandOxylabs — startSessId + sesstimeMin')
// ============================================================================

const withStart = expandOxylabs({
  endpoint: 'pr.oxylabs.io:7777',
  customer: 'mz',
  password: 's',
  count: 2,
  startSessId: 100,
  sesstimeMin: 60,
})
ok(
  'startSessId=100 → first item sessid=000100',
  withStart.items[0].username.includes('sessid-000100'),
)
ok(
  'startSessId=100 + 2 items → second sessid=000101',
  withStart.items[1].username.includes('sessid-000101'),
)
ok('sesstimeMin=60 honored', withStart.items[0].username.includes('sesstime-60'))

// ============================================================================
console.log('\nlistProviders + expandProvider')
// ============================================================================

const provs = listProviders()
ok('listProviders returns 5 providers', Array.isArray(provs) && provs.length === 5)
ok(
  'oxylabs + brightdata + decodo available, smartproxy + iproyal coming-soon',
  provs.find((p) => p.id === 'oxylabs').status === 'available' &&
    provs.find((p) => p.id === 'brightdata').status === 'available' &&
    provs.find((p) => p.id === 'decodo').status === 'available' &&
    provs.filter((p) => p.status === 'coming-soon').length === 2,
)
ok(
  'oxylabs fields include city (added in H-2k)',
  provs.find((p) => p.id === 'oxylabs').fields.some((f) => f.id === 'city'),
)
ok(
  'expandProvider("smartproxy") → COMING_SOON',
  expandProvider('smartproxy', {}).__error.code === 'COMING_SOON',
)
ok(
  'expandProvider("nonsense") → UNKNOWN_PROVIDER',
  expandProvider('nonsense', {}).__error.code === 'UNKNOWN_PROVIDER',
)

// ============================================================================
console.log('\nexpandDecodo — mobile/residential city targeting')
// ============================================================================

ok(
  'missing customer → MISSING_FIELDS',
  expandDecodo({ password: 'y', count: 1 }).__error.code === 'MISSING_FIELDS',
)
ok(
  'missing password → MISSING_FIELDS',
  expandDecodo({ customer: 'x', count: 1 }).__error.code === 'MISSING_FIELDS',
)
ok(
  'count out of range → INVALID_COUNT',
  expandDecodo({ customer: 'x', password: 'y', count: 0 }).__error.code ===
    'INVALID_COUNT',
)

const dec = expandDecodo({
  endpoint: 'gate.decodo.com:10001',
  customer: 'sp2f1ft6in',
  password: 'zocpass',
  count: 10,
  city: 'miami',
})
ok('decodo expands 10 items', dec.ok && dec.items.length === 10)
ok(
  'sequential ports 10001..10010',
  dec.items[0].port === 10001 && dec.items[9].port === 10010,
)
ok(
  'username carries city targeting',
  dec.items[0].username === 'user-sp2f1ft6in-city-miami',
)
ok(
  'shared username across ports (per-port sticky)',
  dec.items[0].username === dec.items[5].username,
)
ok('decodo tag + country/city passthrough', dec.items[0].tags.includes('decodo'))
ok(
  'country-only targeting (no city)',
  expandDecodo({
    customer: 'sp2f1ft6in',
    password: 'p',
    count: 1,
    country: 'US',
  }).items[0].username === 'user-sp2f1ft6in-country-us',
)
ok(
  'expandProvider("decodo") routes to expandDecodo',
  expandProvider('decodo', {
    customer: 'sp2f1ft6in',
    password: 'p',
    count: 1,
    city: 'miami',
  }).ok === true,
)

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
