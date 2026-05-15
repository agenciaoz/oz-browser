// OZ Browser — Proxy Importer smoke test (H-2g, v1.1.3).
//
// Cómo correr:
//   cd oz-browser && node tests/proxy-importer.smoketest.js

const {
  buildProxyImporter,
  detectFormat,
  parseProxies,
  parseTxtHostPort,
  parseTxtUrlStyle,
} = require('../browser/proxy-importer')

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

console.log('OZ Browser — proxy-importer smoke test')

// ============================================================
section('detectFormat — recognizes 3 formats + unknown')
// ============================================================
{
  ok('csv with headers', detectFormat('host,port,user,pass\nfoo.com,80,u,p') === 'csv')
  ok(
    'csv extra cols',
    detectFormat('host,port,user,pass,country\nfoo.com,80,u,p,US') === 'csv',
  )
  ok(
    'url-style single line',
    detectFormat('user:pass@us.oxylabs.io:10001') === 'url-style',
  )
  ok(
    'url-style multi line',
    detectFormat('u1:p1@a.com:8080\nu2:p2@b.com:9090') === 'url-style',
  )
  ok('host-port flat', detectFormat('us.oxylabs.io:10001:user:pass') === 'host-port')
  ok('host-port without creds', detectFormat('us.oxylabs.io:10001') === 'host-port')
  ok('empty → unknown', detectFormat('') === 'unknown')
  ok('null → unknown', detectFormat(null) === 'unknown')
  ok('undefined → unknown', detectFormat(undefined) === 'unknown')
  ok('garbage → unknown', detectFormat('this is not a proxy') === 'unknown')
  ok(
    'csv header without host keyword → unknown (no detect)',
    detectFormat('foo,bar,baz\n1,2,3') === 'unknown',
  )
  // Whitespace + lines with only comments
  ok(
    'leading whitespace OK',
    detectFormat('   us.oxylabs.io:10001:u:p   ') === 'host-port',
  )
}

// ============================================================
section('parseTxtHostPort — happy + edge cases')
// ============================================================
{
  const r1 = parseTxtHostPort('us.oxylabs.io:10001:user1:pass1')
  ok('happy 4-field ok', r1.ok === true)
  ok('host parsed', r1.proxy.host === 'us.oxylabs.io')
  ok('port number', r1.proxy.port === 10001)
  ok('username parsed', r1.proxy.username === 'user1')
  ok('password parsed', r1.proxy.password === 'pass1')

  const r2 = parseTxtHostPort('us.example.com:8080')
  ok('2-field (no creds) ok', r2.ok === true && r2.proxy.host === 'us.example.com')
  ok('null username when missing', r2.proxy.username === null)

  const r3 = parseTxtHostPort('us.example.com:8080:u:p:US')
  ok('5-field includes country', r3.ok === true && r3.proxy.country === 'US')

  const r4 = parseTxtHostPort('host:0:u:p')
  ok('port 0 → invalid', r4.ok === false && r4.reason === 'INVALID_PORT')

  const r5 = parseTxtHostPort('host:99999:u:p')
  ok('port 99999 → invalid', r5.ok === false && r5.reason === 'INVALID_PORT')

  const r6 = parseTxtHostPort('host:abc:u:p')
  ok('non-numeric port → invalid', r6.ok === false && r6.reason === 'INVALID_PORT')

  const r7 = parseTxtHostPort('only-one-field')
  ok('1-field → bad format', r7.ok === false && r7.reason === 'BAD_FORMAT')

  const r8 = parseTxtHostPort(':8080:u:p')
  ok('empty host → empty host', r8.ok === false && r8.reason === 'EMPTY_HOST')
}

// ============================================================
section('parseTxtUrlStyle — happy + edge cases')
// ============================================================
{
  const r1 = parseTxtUrlStyle('user1:pass1@us.oxylabs.io:10001')
  ok('happy ok', r1.ok === true)
  ok('host parsed', r1.proxy.host === 'us.oxylabs.io')
  ok('port number', r1.proxy.port === 10001)
  ok('username parsed', r1.proxy.username === 'user1')
  ok('password parsed', r1.proxy.password === 'pass1')

  const r2 = parseTxtUrlStyle('user1:pass1@host:0')
  ok('port 0 → invalid', r2.ok === false && r2.reason === 'INVALID_PORT')

  const r3 = parseTxtUrlStyle('user@host:80')
  ok('missing pass → bad format', r3.ok === false && r3.reason === 'BAD_FORMAT')

  const r4 = parseTxtUrlStyle('no-at-sign')
  ok('no @ → bad format', r4.ok === false && r4.reason === 'BAD_FORMAT')

  const r5 = parseTxtUrlStyle('user:p@a@b:80')
  // Has double @ - regex won't match cleanly
  ok('double @ → bad format', r5.ok === false && r5.reason === 'BAD_FORMAT')
}

// ============================================================
section('parseCsvAll — happy + edge cases')
// ============================================================
{
  const r1 = parseProxies(
    'host,port,user,pass\nus.oxylabs.io,10001,u1,p1\nfr.example.com,8080,u2,p2',
  )
  ok('csv format detected', r1.format === 'csv')
  ok('csv 2 rows parsed', r1.rows.length === 2)
  ok('csv first row valid', r1.rows[0].ok === true)
  ok('csv first row line 2', r1.rows[0].row === 2)
  ok('csv host parsed', r1.rows[0].proxy.host === 'us.oxylabs.io')
  ok('csv summary valid=2', r1.summary.valid === 2)

  const r2 = parseProxies('host,port,user,pass\n,8080,u,p\nus.com,abc,u,p\nus.com,80,u,p')
  ok('csv invalid host row marked', r2.rows[0].ok === false)
  ok('csv invalid port row marked', r2.rows[1].ok === false)
  ok('csv valid row in summary', r2.summary.valid === 1)
  ok('csv invalid in summary', r2.summary.invalid === 2)

  const r3 = parseProxies('host,port,user,pass,country,label\nus.com,80,u,p,US,my-proxy')
  ok('csv extra cols ok', r3.rows[0].ok === true)
  ok('csv country parsed', r3.rows[0].proxy.country === 'US')
  ok('csv label parsed', r3.rows[0].proxy.label === 'my-proxy')
}

// ============================================================
section('parseProxies dispatcher — text → rows + summary')
// ============================================================
{
  const r1 = parseProxies('us.example.com:8080:u:p\nfr.example.com:9090:u2:p2')
  ok('detects host-port', r1.format === 'host-port')
  ok('parses 2 rows', r1.rows.length === 2 && r1.summary.valid === 2)
  ok('row 1 line 1', r1.rows[0].row === 1)
  ok('row 2 line 2', r1.rows[1].row === 2)

  const r2 = parseProxies('# comment\n\nus.example.com:8080:u:p')
  ok('skips comments + blank lines', r2.rows.length === 1)
  ok('row preserves true line number', r2.rows[0].row === 3)

  const r3 = parseProxies('u:p@a:80\nu2:p2@b:90')
  ok('detects url-style', r3.format === 'url-style')
  ok('url-style parses 2', r3.rows.length === 2 && r3.summary.valid === 2)

  const r4 = parseProxies('total garbage')
  ok('garbage → unknown format', r4.format === 'unknown')
  ok('garbage → empty rows', r4.rows.length === 0)

  const r5 = parseProxies('us.example.com:bad:u:p\nus.example.com:80:u:p')
  ok('mixed validity in same paste', r5.summary.valid === 1 && r5.summary.invalid === 1)
}

// ============================================================
section('importBatch — calls proxyManager.create per valid, skips invalid')
// ============================================================
{
  const calls = []
  const pm = {
    create: (opts) => {
      calls.push(opts)
      if (opts.host === 'evil.com') return { __error: { code: 'INVALID_HOST' } }
      return { id: 'p-' + calls.length, ...opts }
    },
  }
  const imp = buildProxyImporter({ proxyManager: pm })
  const rows = [
    {
      row: 1,
      ok: true,
      proxy: { host: 'a.com', port: 80, username: 'u', password: 'p' },
    },
    { row: 2, ok: false, reason: 'INVALID_PORT' },
    {
      row: 3,
      ok: true,
      proxy: { host: 'b.com', port: 90, username: 'u', password: 'p' },
    },
    {
      row: 4,
      ok: true,
      proxy: { host: 'evil.com', port: 666, username: 'u', password: 'p' },
    },
  ]
  const r = imp.importBatch(rows)
  ok('top-level ok', r.ok === true)
  ok('added counted correctly', r.added === 2)
  ok('failed length 2', r.failed.length === 2)
  ok('failed includes invalid row reason', r.failed[0].reason === 'INVALID_PORT')
  ok('failed includes pm error code', r.failed[1].reason === 'INVALID_HOST')
  ok('proxyManager.create called 3 times (valid rows only)', calls.length === 3)
  ok('host forwarded', calls[0].host === 'a.com')
  ok('protocol default https', calls[0].protocol === 'https')
  ok('addedIds carry row + id', r.addedIds[0].row === 1 && r.addedIds[0].id === 'p-1')
}

// ============================================================
section('importBatch — defensive empty / null / only invalid')
// ============================================================
{
  const pm = { create: () => ({ id: 'never' }) }
  const imp = buildProxyImporter({ proxyManager: pm })
  const r1 = imp.importBatch([])
  ok('empty rows ok', r1.ok === true && r1.added === 0)
  const r2 = imp.importBatch(undefined)
  ok('undefined defensive', r2.ok === true && r2.added === 0)
  const r3 = imp.importBatch([
    { row: 1, ok: false, reason: 'EMPTY_HOST' },
    { row: 2, ok: false, reason: 'INVALID_PORT' },
  ])
  ok('only-invalid → 0 added, 2 failed', r3.added === 0 && r3.failed.length === 2)
}

// ============================================================
section('factory requires proxyManager')
// ============================================================
{
  let threw = false
  try {
    buildProxyImporter({})
  } catch (_e) {
    threw = true
  }
  ok('throws when proxyManager missing', threw === true)
}

setTimeout(() => {
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
}, 50)
