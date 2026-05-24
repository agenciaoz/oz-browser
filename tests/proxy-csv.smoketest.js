// OZ Browser — proxy-csv + proxy-providers smoke test (1.8d).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-csv.smoketest.js
//
// Cubre:
//   - parseCsv: header tolerance, missing fields skipped, tags by | or ;.
//   - encodeCsv: round-trip lossless con escapes RFC4180.
//   - expandOxylabs: genera N proxies con sessid sequential + sesstime.
//   - 3 stubs (Bright Data / Smartproxy / IPRoyal) retornan COMING_SOON.
//   - listProviders shape.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-csv-'))
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

console.log('OZ Browser — proxy-csv + providers smoke test')

// ---------- 1. parseCsv basic happy path -----------------------------------
section('parseCsv: standard CSV with all columns')
{
  const { parseCsv } = require('../browser/proxy-csv.js')
  const csv = `protocol,host,port,username,password,tags,country,name
https,a.com,8080,u1,p1,res|us,US,Alpha
socks5,b.com,1080,u2,p2,dc;eu,DE,Beta`
  const r = parseCsv(csv)
  ok('ok', r.ok === true)
  ok('items=2', r.items.length === 2)
  ok('protocol https', r.items[0].protocol === 'https')
  ok('protocol socks5', r.items[1].protocol === 'socks5')
  ok('port number', r.items[0].port === 8080)
  ok('tags via |', r.items[0].tags.length === 2 && r.items[0].tags.includes('res'))
  ok('tags via ;', r.items[1].tags.length === 2 && r.items[1].tags.includes('eu'))
  ok('name preserved', r.items[1].name === 'Beta')
}

// ---------- 2. parseCsv header tolerance -----------------------------------
section('parseCsv: tolerant column order + casing + alias')
{
  const { parseCsv } = require('../browser/proxy-csv.js')
  const csv = `Host,Port,User,Pass,Protocol
1.2.3.4,80,bob,secret,http`
  const r = parseCsv(csv)
  ok('ok despite different order', r.ok === true)
  ok('1 item', r.items.length === 1)
  ok('User alias maps to username', r.items[0].username === 'bob')
  ok('Pass alias maps to password', r.items[0].password === 'secret')
  ok('Protocol normalized lowercase', r.items[0].protocol === 'http')
}

// ---------- 3. parseCsv skips bad rows -------------------------------------
section('parseCsv: rows missing host or port → skipped silently')
{
  const { parseCsv } = require('../browser/proxy-csv.js')
  const csv = `protocol,host,port
https,a.com,80
https,,81
,b.com,
https,c.com,82`
  const r = parseCsv(csv)
  ok('2 valid items', r.items.length === 2)
  ok(
    'a.com survives',
    r.items.some((p) => p.host === 'a.com'),
  )
  ok(
    'c.com survives',
    r.items.some((p) => p.host === 'c.com'),
  )
}

// ---------- 4. parseCsv invalid CSV ----------------------------------------
section('parseCsv: malformed → ok:false with reason')
{
  const { parseCsv } = require('../browser/proxy-csv.js')
  const csv = `host,port
"unterminated string,80
a.com,80`
  const r = parseCsv(csv)
  ok('ok:false on malformed', r.ok === false)
  ok('reason parse-failed', r.reason === 'parse-failed')
}

// ---------- 5. encodeCsv round-trip lossless -------------------------------
section('encodeCsv: round-trip lossless')
{
  const { parseCsv, encodeCsv } = require('../browser/proxy-csv.js')
  const items = [
    {
      protocol: 'https',
      host: 'a.com',
      port: 80,
      username: 'u1',
      password: 'p1',
      tags: ['res', 'us'],
      country: 'US',
      name: 'Alpha',
    },
    {
      protocol: 'socks5',
      host: 'b.com',
      port: 1080,
      username: 'u, with comma',
      password: 'p"with quote',
      tags: ['x'],
      country: null,
      name: '',
    },
  ]
  const csv = encodeCsv(items)
  ok('csv has header', csv.startsWith('protocol,host,port'))
  ok('csv quotes username with comma', csv.includes('"u, with comma"'))
  ok('csv escapes inner quote', csv.includes('"p""with quote"'))
  const back = parseCsv(csv)
  ok('round-trip parse ok', back.ok === true)
  ok('items=2', back.items.length === 2)
  ok('username preserved', back.items[1].username === 'u, with comma')
  ok('password preserved', back.items[1].password === 'p"with quote')
  ok('tag preserved', back.items[0].tags.includes('res'))
}

// ---------- 6. Oxylabs expansion -------------------------------------------
section('expandOxylabs: generates N proxies with sequential sessids')
{
  const { expandOxylabs } = require('../browser/proxy-providers.js')
  const r = expandOxylabs({
    endpoint: 'us-pr.oxylabs.io:10001',
    customer: 'mzewama',
    password: 'secret',
    count: 3,
    country: 'US',
    sesstimeMin: 30,
  })
  ok('ok', r.ok === true)
  ok('items=3', r.items.length === 3)
  ok('host parsed', r.items[0].host === 'us-pr.oxylabs.io')
  ok('port parsed as int', r.items[0].port === 10001)
  ok(
    'username includes customer + cc-us + sessid + sesstime',
    r.items[0].username === 'customer-mzewama-cc-us-sessid-000001-sesstime-30',
  )
  ok('sessid increments', r.items[1].username.includes('sessid-000002'))
  ok('tags include oxylabs + country', r.items[0].tags.includes('oxylabs'))
  ok('name has sessid', r.items[2].name.includes('000003'))
}

// ---------- 7. Oxylabs validation ------------------------------------------
section('expandOxylabs: validation errors')
{
  const { expandOxylabs } = require('../browser/proxy-providers.js')
  ok('missing fields', expandOxylabs({ count: 1 }).__error.code === 'MISSING_FIELDS')
  ok(
    'invalid count 0',
    expandOxylabs({
      endpoint: 'a:1',
      customer: 'c',
      password: 'p',
      count: 0,
    }).__error.code === 'INVALID_COUNT',
  )
  ok(
    'invalid count >1000',
    expandOxylabs({
      endpoint: 'a:1',
      customer: 'c',
      password: 'p',
      count: 1001,
    }).__error.code === 'INVALID_COUNT',
  )
  ok(
    'bad endpoint',
    expandOxylabs({
      endpoint: 'no-port-here',
      customer: 'c',
      password: 'p',
      count: 5,
    }).__error.code === 'INVALID_ENDPOINT',
  )
}

// ---------- 8. Other providers are stubs -----------------------------------
// v2.0.0-alpha.22: Bright Data became real. Smartproxy / IPRoyal remain stubs.
section('listProviders + COMING_SOON for Smartproxy / IPRoyal')
{
  const { listProviders, expandProvider } = require('../browser/proxy-providers.js')
  const ps = listProviders()
  ok('4 providers', ps.length === 4)
  ok('oxylabs available', ps.find((p) => p.id === 'oxylabs').status === 'available')
  ok(
    'brightdata available (v2.0.0-alpha.22)',
    ps.find((p) => p.id === 'brightdata').status === 'available',
  )
  ok(
    'smartproxy coming-soon',
    ps.find((p) => p.id === 'smartproxy').status === 'coming-soon',
  )
  ok('iproyal coming-soon', ps.find((p) => p.id === 'iproyal').status === 'coming-soon')

  const r = expandProvider('smartproxy', {})
  ok('smartproxy returns COMING_SOON', r.__error.code === 'COMING_SOON')

  const r2 = expandProvider('unknown-x', {})
  ok('unknown provider error', r2.__error.code === 'UNKNOWN_PROVIDER')
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
