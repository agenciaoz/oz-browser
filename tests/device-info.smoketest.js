// OZ Browser — Device Info smoke test (Bloque D-1.1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/device-info.smoketest.js
//
// Cubre:
//   - slugifyHostname: casos normales, unicode, vacíos, truncado, símbolos
//   - _shortIdFromUuid: extrae primeros 8 hex chars
//   - _generateUuid: forma RFC 4122 v4
//   - _isValid: rechazos correctos
//   - ensureDeviceInfo: genera + persiste al primer call
//   - ensureDeviceInfo: idempotente — segundo call lee de disco, no regenera
//   - reload: invalida cache y relee
//   - hostname inject: tests determinísticos
//   - JSON corrupto en disco → regenera
//   - Shape inválido en disco → regenera

const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-device-info-'))

const {
  createDeviceInfo,
  slugifyHostname,
  injectHostname,
  DEVICE_INFO_FILENAME,
  SCHEMA_VERSION,
  _shortIdFromUuid,
  _generateUuid,
  _isValid,
} = require('../browser/device-info')

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
    console.error(`  ✗ ${label}`)
    if (detail !== undefined) console.error(`      → ${JSON.stringify(detail)}`)
  }
}

function group(name, fn) {
  console.log(`\n[${name}]`)
  fn()
}

function freshSubdir(name) {
  const dir = path.join(TEST_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- slugifyHostname ----------
group('slugifyHostname', () => {
  ok(
    'apostrophes + caps → slug',
    slugifyHostname("Jose's MacBook Pro") === 'joses-macbook-pro',
  )
  ok(
    'symbols → dashes collapsed',
    slugifyHostname('ALPHA !! NUM 123') === 'alpha-num-123',
  )
  ok('emoji stripped', slugifyHostname('🎉 emoji host 🎉') === 'emoji-host')
  ok('empty → device', slugifyHostname('') === 'device')
  ok('only symbols → device', slugifyHostname('!!!@@@###') === 'device')
  ok('non-string → device', slugifyHostname(undefined) === 'device')
  ok('non-string null → device', slugifyHostname(null) === 'device')
  const long = 'a'.repeat(100)
  const s = slugifyHostname(long)
  ok('truncated to ≤32', s.length <= 32, { len: s.length })
  ok(
    'no trailing dash after truncate',
    !slugifyHostname('a-' + 'b'.repeat(40)).endsWith('-'),
    { slug: slugifyHostname('a-' + 'b'.repeat(40)) },
  )
  ok('diacritics stripped', slugifyHostname('Café del Río') === 'cafe-del-rio')
  ok('multi-dash collapsed', slugifyHostname('a---b___c') === 'a-b-c')
  ok('numbers preserved', slugifyHostname('mac-2024') === 'mac-2024')
})

// ---------- shortId extraction ----------
group('_shortIdFromUuid', () => {
  const id = _shortIdFromUuid('a1b2c3d4-e5f6-7890-abcd-ef0123456789')
  ok('first 8 hex chars', id === 'a1b2c3d4')
  ok('length === 8', id.length === 8)
})

// ---------- UUID generation ----------
group('_generateUuid', () => {
  const u = _generateUuid()
  ok(
    'format with dashes',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u),
  )
  ok('version 4 nibble', u.charAt(14) === '4')
  ok('variant nibble in [89ab]', /[89ab]/.test(u.charAt(19)))
  const u2 = _generateUuid()
  ok('two calls produce different uuids', u !== u2)
})

// ---------- shape validation ----------
group('_isValid', () => {
  ok('rejects null', !_isValid(null))
  ok('rejects empty', !_isValid({}))
  ok(
    'rejects missing uuid',
    !_isValid({ shortId: 'a1b2c3d4', deviceFolder: 'x-a1b2c3d4', schemaVersion: 1 }),
  )
  ok(
    'rejects short shortId',
    !_isValid({
      uuid: 'a'.repeat(36),
      shortId: 'a1b2',
      deviceFolder: 'x',
      schemaVersion: 1,
    }),
  )
  ok(
    'accepts valid shape',
    _isValid({
      uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      shortId: 'a1b2c3d4',
      deviceFolder: 'host-a1b2c3d4',
      schemaVersion: 1,
    }),
  )
})

// ---------- factory: first boot ----------
group('ensureDeviceInfo — first boot', () => {
  injectHostname(() => "Jose's MacBook Pro")
  const dir = freshSubdir('first-boot')
  const di = createDeviceInfo({ userDataDir: dir })
  const info = di.ensureDeviceInfo()
  ok('hostname captured raw', info.hostname === "Jose's MacBook Pro")
  ok('slug derived', info.hostnameSlug === 'joses-macbook-pro')
  ok('shortId 8 chars hex', /^[0-9a-f]{8}$/.test(info.shortId))
  ok(
    'deviceFolder = slug-shortId',
    info.deviceFolder === `joses-macbook-pro-${info.shortId}`,
  )
  ok('schemaVersion set', info.schemaVersion === SCHEMA_VERSION)
  ok('createdAt is ISO', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(info.createdAt))
  // Persisted?
  const filePath = path.join(dir, DEVICE_INFO_FILENAME)
  ok('file persisted', fs.existsSync(filePath))
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  ok('on-disk matches returned', JSON.stringify(onDisk) === JSON.stringify(info))
})

// ---------- factory: idempotent across calls ----------
group('ensureDeviceInfo — idempotent', () => {
  injectHostname(() => 'My-Mac')
  const dir = freshSubdir('idempotent')
  const di1 = createDeviceInfo({ userDataDir: dir })
  const info1 = di1.ensureDeviceInfo()
  // Second factory (simulates reboot): should read from disk, NOT regenerate
  const di2 = createDeviceInfo({ userDataDir: dir })
  const info2 = di2.ensureDeviceInfo()
  ok('uuid stable across reboots', info1.uuid === info2.uuid)
  ok('shortId stable', info1.shortId === info2.shortId)
  ok('deviceFolder stable', info1.deviceFolder === info2.deviceFolder)
  ok('createdAt stable', info1.createdAt === info2.createdAt)
  // Same factory called multiple times → same object (cached)
  const info3 = di1.ensureDeviceInfo()
  ok('cached after first call', info1 === info3)
})

// ---------- factory: getDeviceInfo === ensureDeviceInfo ----------
group('getDeviceInfo + getDeviceFolder', () => {
  injectHostname(() => 'macnam')
  const dir = freshSubdir('accessors')
  const di = createDeviceInfo({ userDataDir: dir })
  const info = di.getDeviceInfo()
  ok('getDeviceInfo auto-ensures', _isValid(info))
  ok('getDeviceFolder = info.deviceFolder', di.getDeviceFolder() === info.deviceFolder)
})

// ---------- factory: reload invalidates cache ----------
group('reload', () => {
  injectHostname(() => 'host-a')
  const dir = freshSubdir('reload')
  const di = createDeviceInfo({ userDataDir: dir })
  const info1 = di.ensureDeviceInfo()
  // Manually corrupt the file (simulating external edit)
  fs.writeFileSync(
    path.join(dir, DEVICE_INFO_FILENAME),
    JSON.stringify({ ...info1, hostname: 'host-modified-externally' }),
  )
  const info2 = di.reload()
  ok('reload picks up external edit', info2.hostname === 'host-modified-externally')
  ok('uuid still stable after reload', info2.uuid === info1.uuid)
})

// ---------- corrupt JSON → regenerate ----------
group('corrupt JSON regen', () => {
  injectHostname(() => 'crashy')
  const dir = freshSubdir('corrupt')
  fs.writeFileSync(path.join(dir, DEVICE_INFO_FILENAME), '{ not valid json :(')
  const di = createDeviceInfo({ userDataDir: dir })
  const info = di.ensureDeviceInfo()
  ok('regenerated despite corruption', _isValid(info))
  ok('slug from injected hostname', info.hostnameSlug === 'crashy')
  // File should now be valid JSON
  const reread = JSON.parse(
    fs.readFileSync(path.join(dir, DEVICE_INFO_FILENAME), 'utf-8'),
  )
  ok('disk file is now valid JSON', _isValid(reread))
})

// ---------- invalid shape → regenerate ----------
group('invalid shape regen', () => {
  injectHostname(() => 'bad-shape-host')
  const dir = freshSubdir('badshape')
  fs.writeFileSync(
    path.join(dir, DEVICE_INFO_FILENAME),
    JSON.stringify({ hello: 'world', schemaVersion: 'not-a-number' }),
  )
  const di = createDeviceInfo({ userDataDir: dir })
  const info = di.ensureDeviceInfo()
  ok('regenerated despite invalid shape', _isValid(info))
  ok('new slug from hostname', info.hostnameSlug === 'bad-shape-host')
})

// ---------- empty hostname fallback ----------
group('empty hostname', () => {
  injectHostname(() => '')
  const dir = freshSubdir('empty-host')
  const di = createDeviceInfo({ userDataDir: dir })
  const info = di.ensureDeviceInfo()
  ok('slug falls back to device', info.hostnameSlug === 'device')
  ok('deviceFolder = device-<id>', info.deviceFolder.startsWith('device-'))
})

// ---------- ensureDeviceInfo: missing userDataDir throws ----------
group('factory validation', () => {
  let threw = false
  try {
    createDeviceInfo({ userDataDir: '' })
  } catch (_) {
    threw = true
  }
  ok('empty userDataDir throws', threw)
  threw = false
  try {
    createDeviceInfo({})
  } catch (_) {
    threw = true
  }
  ok('missing userDataDir throws', threw)
})

// ---------- summary ----------
console.log(`\n${'='.repeat(50)}`)
console.log(`device-info smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f.label}`)
}
// Cleanup TEST_DIR (best effort)
try {
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
} catch (_) {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
