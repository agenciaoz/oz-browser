// OZ Browser — fingerprint-engine smoke test (1.9a).
//
// Cómo correr:
//   cd oz-browser
//   node tests/fingerprint-engine.smoketest.js
//
// Cubre:
//   - buildProfile determinístico: mismo seed → mismo perfil siempre.
//   - Diversidad: distintos seeds → distintos perfiles (UA, screen, locale).
//   - Coherencia: blueprint elegido genera UA + WebGL + platform consistentes
//     (un Mac NO tiene UA Windows).
//   - 11 vectores presentes en el output.
//   - Persistence round-trip via FingerprintEngine class.
//   - regenerate() crea nuevo perfil + persiste.
//   - applyGeoSuggestion muta solo locale fields, no UA/screen.
//   - remove cleans cache.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-fp-'))
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

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/fingerprint-engine.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  return require('../browser/fingerprint-engine.js')
}

console.log('OZ Browser — fingerprint-engine smoke test')

// ---------- 1. determinism ------------------------------------------------
section('buildProfile: determinístico — mismo seed siempre igual')
{
  const { buildProfile } = freshSetup()
  const seed = 'abcdef0123456789'
  const a = buildProfile(seed)
  const b = buildProfile(seed)
  ok('UA igual', a.ua === b.ua)
  ok('blueprintId igual', a.blueprintId === b.blueprintId)
  ok('platform igual', a.platform === b.platform)
  ok('hardwareConcurrency igual', a.hardwareConcurrency === b.hardwareConcurrency)
  ok('deviceMemory igual', a.deviceMemory === b.deviceMemory)
  ok('locale igual', a.locale === b.locale)
  ok('timezone igual', a.timezone === b.timezone)
  ok('languages igual', JSON.stringify(a.languages) === JSON.stringify(b.languages))
  ok('screen igual', JSON.stringify(a.screen) === JSON.stringify(b.screen))
  ok('webgl igual', JSON.stringify(a.webgl) === JSON.stringify(b.webgl))
  ok('canvasNoiseSeed igual', a.canvasNoiseSeed === b.canvasNoiseSeed)
}

// ---------- 2. diversity ---------------------------------------------------
section('buildProfile: diversity — distintos seeds → distintos perfiles')
{
  const { buildProfile } = freshSetup()
  const profiles = []
  for (let i = 0; i < 20; i++) profiles.push(buildProfile(`seed-${i}`))
  const uas = new Set(profiles.map((p) => p.ua))
  const blueprints = new Set(profiles.map((p) => p.blueprintId))
  const screens = new Set(profiles.map((p) => `${p.screen.width}x${p.screen.height}`))
  const locales = new Set(profiles.map((p) => p.locale))
  ok('al menos 3 UAs distintos en 20 seeds', uas.size >= 3)
  ok('al menos 3 blueprints distintos', blueprints.size >= 3)
  ok('al menos 3 screen sizes distintos', screens.size >= 3)
  ok('al menos 3 locales distintos', locales.size >= 3)
}

// ---------- 3. coherencia ---------------------------------------------------
section('buildProfile: coherencia — Mac NO tiene UA Windows, etc')
{
  const { buildProfile, BLUEPRINTS } = freshSetup()
  const seedsToCheck = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']
  for (const seed of seedsToCheck) {
    const p = buildProfile(seed)
    const bp = BLUEPRINTS.find((b) => b.id === p.blueprintId)
    ok(`${seed}: UA matches blueprint`, p.ua === bp.ua, `expected ${bp.ua}, got ${p.ua}`)
    ok(`${seed}: platform matches`, p.platform === bp.platform)
    if (bp.platform === 'MacIntel') {
      ok(`${seed}: Mac → no Windows in UA`, !p.ua.includes('Windows'))
      ok(`${seed}: Mac → no Linux in UA`, !p.ua.includes('Linux'))
    }
    if (bp.platform === 'Win32') {
      ok(`${seed}: Win32 → no Mac in UA`, !p.ua.includes('Macintosh'))
    }
    if (bp.platform === 'Linux x86_64') {
      ok(`${seed}: Linux → no Windows`, !p.ua.includes('Windows'))
    }
    // WebGL renderer should be in the blueprint's renderer pool
    ok(
      `${seed}: webgl renderer in blueprint pool`,
      bp.webgl.rendererOptions.includes(p.webgl.renderer),
    )
  }
}

// ---------- 4. all 11 vectors present --------------------------------------
section('buildProfile: 11 vectores presentes en el output')
{
  const { buildProfile } = freshSetup()
  const p = buildProfile('check-vectors')
  ok('1. ua', typeof p.ua === 'string')
  ok('1b. platform', typeof p.platform === 'string')
  ok('1c. appVersion', typeof p.appVersion === 'string')
  ok('2. hardwareConcurrency', typeof p.hardwareConcurrency === 'number')
  ok('3. deviceMemory', typeof p.deviceMemory === 'number')
  ok('4. languages', Array.isArray(p.languages) && p.languages.length > 0)
  ok('4b. language', typeof p.language === 'string')
  ok('5. screen', p.screen && typeof p.screen.width === 'number')
  ok('5b. devicePixelRatio', typeof p.devicePixelRatio === 'number')
  ok('6. timezone', typeof p.timezone === 'string')
  ok('7. plugins', Array.isArray(p.plugins) && p.plugins.length >= 4)
  ok('8. battery', p.battery && typeof p.battery.level === 'number')
  ok('9. speechVoices', Array.isArray(p.speechVoices) && p.speechVoices.length > 0)
  ok('10. canvasNoiseSeed', typeof p.canvasNoiseSeed === 'number')
  ok('11. webgl.vendor + renderer', !!p.webgl.vendor && !!p.webgl.renderer)
}

// ---------- 5. validation --------------------------------------------------
section('buildProfile: validación')
{
  const { buildProfile } = freshSetup()
  let threw = false
  try {
    buildProfile()
  } catch (e) {
    threw = e.message.includes('seed required')
  }
  ok('falla sin seed', threw)
}

// ---------- 6. FingerprintEngine class -------------------------------------
section('FingerprintEngine: getOrCreate + persist + reload')
{
  const { FingerprintEngine } = freshSetup()
  const fe = new FingerprintEngine()
  const p1 = fe.getOrCreate('id-1', 'seed-1')
  ok('getOrCreate returns profile', !!p1.ua)
  const p1b = fe.getOrCreate('id-1', 'seed-different') // seed ignored on cache hit
  ok('cache hit returns same UA', p1.ua === p1b.ua)
  ok('cache hit returns same blueprint', p1.blueprintId === p1b.blueprintId)

  // Re-instantiate
  delete require.cache[require.resolve('../browser/fingerprint-engine.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { FingerprintEngine: FE2 } = require('../browser/fingerprint-engine.js')
  const fe2 = new FE2()
  const p2 = fe2.get('id-1')
  ok('persisted across reload', !!p2)
  ok('UA survives reload', p2.ua === p1.ua)
  ok('blueprintId survives', p2.blueprintId === p1.blueprintId)
}

// ---------- 7. regenerate --------------------------------------------------
section('FingerprintEngine: regenerate creates new profile')
{
  const { FingerprintEngine } = freshSetup()
  const fe = new FingerprintEngine()
  const p1 = fe.getOrCreate('id-1', 'seed-A')
  const p2 = fe.regenerate('id-1', 'seed-B')
  ok('regenerate returns new profile', p2.seed === 'seed-B')
  ok('cache updated', fe.get('id-1').seed === 'seed-B')
  // With explicit different seed, profile fields likely differ
  ok(
    'different blueprint or screen',
    p1.blueprintId !== p2.blueprintId ||
      p1.screen.width !== p2.screen.width ||
      p1.locale !== p2.locale,
  )

  // No seed → mints new
  const p3 = fe.regenerate('id-1')
  ok('regenerate mints new seed', p3.seed && p3.seed !== 'seed-B')
}

// ---------- 8. applyGeoSuggestion ------------------------------------------
section('FingerprintEngine: applyGeoSuggestion mutates locale only')
{
  const { FingerprintEngine } = freshSetup()
  const fe = new FingerprintEngine()
  const before = fe.getOrCreate('id-1', 'fixed-seed')
  const after = fe.applyGeoSuggestion('id-1', {
    timezone: 'Asia/Tokyo',
    languages: ['ja-JP', 'ja', 'en'],
    locale: 'ja-JP',
  })
  ok('returns updated profile', !!after)
  ok('timezone mutated', after.timezone === 'Asia/Tokyo')
  ok('languages mutated', after.languages[0] === 'ja-JP')
  ok('locale mutated', after.locale === 'ja-JP')
  ok('geoOverridden flag set', after.geoOverridden === true)
  // BUT — UA, screen, blueprint should NOT change
  ok('UA preserved', after.ua === before.ua)
  ok('blueprintId preserved', after.blueprintId === before.blueprintId)
  ok('screen preserved', after.screen.width === before.screen.width)

  // Persisted across reload
  delete require.cache[require.resolve('../browser/fingerprint-engine.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { FingerprintEngine: FE2 } = require('../browser/fingerprint-engine.js')
  const fe2 = new FE2()
  const reloaded = fe2.get('id-1')
  ok('geo override persisted', reloaded.timezone === 'Asia/Tokyo')

  // applyGeoSuggestion on unknown identity → null
  ok('null on unknown id', fe.applyGeoSuggestion('nope', { timezone: 'X' }) === null)
}

// ---------- 9. remove ------------------------------------------------------
section('FingerprintEngine: remove cleans cache')
{
  const { FingerprintEngine } = freshSetup()
  const fe = new FingerprintEngine()
  fe.getOrCreate('id-A', 'sA')
  fe.getOrCreate('id-B', 'sB')
  ok('remove ok', fe.remove('id-A') === true)
  ok('A is gone', fe.get('id-A') === null)
  ok('B survives', fe.get('id-B') !== null)
  ok('remove unknown false', fe.remove('id-A') === false)
}

// ---------- Cleanup ---------------------------------------------------------
Module._load = originalLoad
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
