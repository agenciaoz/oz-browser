// OZ Browser — proxy-providers Bright Data smoke test (v2.0.0-alpha.22).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-providers-brightdata.smoketest.js
//
// Cubre expandBrightData() — el segundo provider real (después de Oxylabs).
// Pattern: brd-customer-X-zone-Y[-country-cc][-city-slug][-session-NNNNNN]

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/proxy-providers.js')]
const {
  expandBrightData,
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

console.log('OZ Browser — proxy-providers Bright Data smoke test')

// ============================================================================
console.log('\nexpandBrightData — validation')
// ============================================================================

ok(
  'missing customer → MISSING_FIELDS',
  expandBrightData({ password: 'p', zone: 'z', count: 1 }).__error.code ===
    'MISSING_FIELDS',
)
ok(
  'missing password → MISSING_FIELDS',
  expandBrightData({ customer: 'c', zone: 'z', count: 1 }).__error.code ===
    'MISSING_FIELDS',
)
ok(
  'missing zone → MISSING_FIELDS',
  expandBrightData({ customer: 'c', password: 'p', count: 1 }).__error.code ===
    'MISSING_FIELDS',
)
ok(
  'count = 0 → INVALID_COUNT',
  expandBrightData({ customer: 'c', password: 'p', zone: 'z', count: 0 }).__error.code ===
    'INVALID_COUNT',
)
ok(
  'count = 1001 → INVALID_COUNT',
  expandBrightData({ customer: 'c', password: 'p', zone: 'z', count: 1001 }).__error
    .code === 'INVALID_COUNT',
)
ok(
  'count = "10" string OK (Number coerce)',
  expandBrightData({ customer: 'c', password: 'p', zone: 'z', count: '10' }).ok === true,
)
ok(
  'count = 5.5 → INVALID_COUNT (not integer)',
  expandBrightData({ customer: 'c', password: 'p', zone: 'z', count: 5.5 }).__error
    .code === 'INVALID_COUNT',
)
ok(
  'malformed endpoint → INVALID_ENDPOINT',
  expandBrightData({
    endpoint: 'no-port-here',
    customer: 'c',
    password: 'p',
    zone: 'z',
    count: 1,
  }).__error.code === 'INVALID_ENDPOINT',
)

// ============================================================================
console.log('\nexpandBrightData — happy path (sticky)')
// ============================================================================

const happy = expandBrightData({
  customer: 'hl_abc',
  password: 'sekret',
  zone: 'residential-1',
  count: 5,
})
ok('happy 5 → ok + 5 items', happy.ok && happy.items.length === 5)
ok(
  'default endpoint = brd.superproxy.io:22225',
  happy.items[0].host === 'brd.superproxy.io' && happy.items[0].port === 22225,
)
ok('protocol = http', happy.items[0].protocol === 'http')
ok(
  'item 0 username has brd-customer + zone + session-000001',
  /^brd-customer-hl_abc-zone-residential-1-session-000001$/.test(happy.items[0].username),
)
ok(
  'item 4 sessid = 000005 (sequential)',
  happy.items[4].username.includes('session-000005'),
)
ok('password copied verbatim', happy.items[0].password === 'sekret')
ok(
  'tags include brightdata + zone',
  happy.items[0].tags.includes('brightdata') &&
    happy.items[0].tags.includes('residential-1'),
)

// ============================================================================
console.log('\nexpandBrightData — sticky OFF (rotating)')
// ============================================================================

const rot = expandBrightData({
  customer: 'c',
  password: 'p',
  zone: 'z',
  count: 3,
  sticky: false,
})
ok(
  'sticky=false omits -session- token',
  /^brd-customer-c-zone-z$/.test(rot.items[0].username),
)
ok(
  'rotating items share same username (rotation = backend exit IP swap)',
  rot.items[0].username === rot.items[1].username &&
    rot.items[1].username === rot.items[2].username,
)
ok(
  'rotating name uses "rot N" suffix',
  /rot 1$/.test(rot.items[0].name) && /rot 3$/.test(rot.items[2].name),
)

// ============================================================================
console.log('\nexpandBrightData — country + city')
// ============================================================================

const geo = expandBrightData({
  customer: 'c',
  password: 'p',
  zone: 'res',
  count: 1,
  country: 'US',
  city: 'New York',
})
ok(
  'country=US + city slugified → -country-us-city-new_york-session-',
  /^brd-customer-c-zone-res-country-us-city-new_york-session-/.test(
    geo.items[0].username,
  ),
)
ok('tags include US', geo.items[0].tags.includes('US'))
ok('tags include city', geo.items[0].tags.includes('New York'))
ok('item.country preserved', geo.items[0].country === 'US')
ok('item.city preserves original case', geo.items[0].city === 'New York')
ok('name mentions country/city', geo.items[0].name.includes('US/New York'))

const ctryOnly = expandBrightData({
  customer: 'c',
  password: 'p',
  zone: 'res',
  count: 1,
  country: 'AR',
})
ok(
  'country only → -country-ar-session- (no -city-)',
  /^brd-customer-c-zone-res-country-ar-session-/.test(ctryOnly.items[0].username) &&
    !ctryOnly.items[0].username.includes('-city-'),
)

// ============================================================================
console.log('\nexpandBrightData — custom endpoint + startSessId')
// ============================================================================

const cust = expandBrightData({
  endpoint: 'edge.example.com:9000',
  customer: 'c',
  password: 'p',
  zone: 'isp',
  count: 2,
  startSessId: 50,
})
ok(
  'custom endpoint parsed',
  cust.items[0].host === 'edge.example.com' && cust.items[0].port === 9000,
)
ok(
  'startSessId=50 → first sessid=000050',
  cust.items[0].username.includes('session-000050'),
)
ok(
  'startSessId=50 + 2 items → second sessid=000051',
  cust.items[1].username.includes('session-000051'),
)

// ============================================================================
console.log('\nPROVIDERS registry + listProviders')
// ============================================================================

ok(
  'PROVIDERS.brightdata.status === "available" (no longer coming-soon)',
  PROVIDERS.brightdata.status === 'available',
)
ok(
  'PROVIDERS.brightdata.fields contains zone',
  PROVIDERS.brightdata.fields.some((f) => f.id === 'zone'),
)
ok(
  'PROVIDERS.brightdata.fields contains password marked type=password',
  PROVIDERS.brightdata.fields.some((f) => f.id === 'password' && f.type === 'password'),
)
const provs = listProviders()
ok(
  'listProviders shows brightdata as available',
  provs.find((p) => p.id === 'brightdata').status === 'available',
)
ok(
  '3 providers available, 2 coming-soon',
  provs.filter((p) => p.status === 'available').length === 3 &&
    provs.filter((p) => p.status === 'coming-soon').length === 2,
)
ok(
  'expandProvider("brightdata") routes to expandBrightData (no longer COMING_SOON)',
  expandProvider('brightdata', {
    customer: 'c',
    password: 'p',
    zone: 'z',
    count: 1,
  }).ok === true,
)
ok(
  'smartproxy + iproyal still COMING_SOON',
  expandProvider('smartproxy', {}).__error.code === 'COMING_SOON' &&
    expandProvider('iproyal', {}).__error.code === 'COMING_SOON',
)

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
