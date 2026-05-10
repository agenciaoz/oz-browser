// OZ Browser — settings-manager + settings-handlers smoke test (1.10a).

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-set-'))
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
  delete require.cache[require.resolve('../browser/settings-manager.js')]
  delete require.cache[require.resolve('../browser/settings-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  return require('../browser/settings-manager.js')
}

console.log('OZ Browser — settings-manager smoke test')

// ---------- 1. defaults ---------------------------------------------------
section('defaults: schema v1 with 6 sections')
{
  const { SettingsManager, DEFAULTS, SCHEMA_VERSION } = freshSetup()
  const sm = new SettingsManager()
  const all = sm.getAll()
  ok('version 1', all.version === SCHEMA_VERSION)
  ok('has general', !!all.general)
  ok('has privacy', !!all.privacy)
  ok('has automation', !!all.automation)
  ok('has backup', !!all.backup)
  ok('has onboarding', !!all.onboarding)
  ok('has performance', !!all.performance)
  ok('devMode default false', all.general.devMode === false)
  ok('logLevel default INFO', all.general.logLevel === 'INFO')
  ok('mcpEnabled default false', all.automation.mcpEnabled === false)
  ok('mcpPort default 9223', all.automation.mcpPort === 9223)
  ok('dailySnapshot default true', all.backup.dailySnapshot === true)
  ok('onboarded default false', all.onboarding.completed === false)
  ok('autoTabDiscard default true', all.performance.autoTabDiscard === true)
  ok('discardIdleMin default 30', all.performance.discardIdleMin === 30)
  void DEFAULTS
}

// ---------- 2. set + persist ---------------------------------------------
section('set: section + persistence round-trip')
{
  const { SettingsManager } = freshSetup()
  const sm = new SettingsManager()
  const r = sm.set('general', { devMode: true, logLevel: 'DEBUG' })
  ok('set returns updated section', r.devMode === true && r.logLevel === 'DEBUG')
  ok('cache reflects', sm.get('general').devMode === true)

  // Re-instantiate
  delete require.cache[require.resolve('../browser/settings-manager.js')]
  const { SettingsManager: SM2 } = require('../browser/settings-manager.js')
  const sm2 = new SM2()
  ok('persisted devMode', sm2.get('general').devMode === true)
  ok('persisted logLevel', sm2.get('general').logLevel === 'DEBUG')
}

// ---------- 3. validation -------------------------------------------------
section('validation: invalid values rejected with __error')
{
  const { SettingsManager } = freshSetup()
  const sm = new SettingsManager()

  const r1 = sm.set('general', { logLevel: 'BOGUS' })
  ok('bad logLevel → __error', r1.__error && r1.__error.code === 'INVALID_VALUE')

  const r2 = sm.set('automation', { mcpPort: 0 })
  ok('bad port → __error', r2.__error && r2.__error.code === 'INVALID_VALUE')

  const r3 = sm.set('automation', { mcpPort: 99999 })
  ok('out-of-range port → __error', r3.__error && r3.__error.code === 'INVALID_VALUE')

  const r4 = sm.set('general', { devMode: 'yes' })
  ok('non-boolean → __error', r4.__error && r4.__error.code === 'INVALID_VALUE')

  const r5 = sm.set('automation', { mcpToken: 123 })
  ok('mcpToken non-string → __error', r5.__error && r5.__error.code === 'INVALID_VALUE')

  const r6 = sm.set('bogus-section', { x: 1 })
  ok('unknown section → __error', r6.__error && r6.__error.code === 'UNKNOWN_SECTION')

  // Settings stay untouched after errors
  ok('logLevel still INFO', sm.get('general').logLevel === 'INFO')
  ok('mcpPort still 9223', sm.get('automation').mcpPort === 9223)
}

// ---------- 4. unknown keys ignored --------------------------------------
section('unknown keys silently ignored (forward compat)')
{
  const { SettingsManager } = freshSetup()
  const sm = new SettingsManager()
  const r = sm.set('general', { devMode: true, futureKey: 42 })
  ok('valid key applied', r.devMode === true)
  ok('unknown key not in result', r.futureKey === undefined)
}

// ---------- 5. reset ----------------------------------------------------
section('resetSection + resetAll')
{
  const { SettingsManager, DEFAULTS } = freshSetup()
  const sm = new SettingsManager()
  sm.set('general', { devMode: true, logLevel: 'WARN' })
  sm.set('automation', { mcpEnabled: true, mcpPort: 8080 })

  const r = sm.resetSection('general')
  ok('general reset to defaults', r.devMode === DEFAULTS.general.devMode)
  ok('logLevel reset', r.logLevel === DEFAULTS.general.logLevel)
  ok('automation NOT reset', sm.get('automation').mcpEnabled === true)

  sm.resetAll()
  ok('automation now reset too', sm.get('automation').mcpEnabled === false)
  ok('automation port reset', sm.get('automation').mcpPort === 9223)
}

// ---------- 6. mergeWithDefaults — forward compat for new keys -----------
section('migration: load older file → new keys appear from defaults')
{
  // Manually write a minimal settings file (older schema, missing performance)
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  const minimal = {
    version: 1,
    general: { devMode: true, freeTier: false, logLevel: 'INFO' },
  }
  fs.writeFileSync(
    path.join(TEST_USERDATA, 'settings.json'),
    JSON.stringify(minimal, null, 2),
  )
  delete require.cache[require.resolve('../browser/settings-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  ok('user value preserved', sm.get('general').devMode === true)
  ok('missing section appears with defaults', sm.get('performance').discardIdleMin === 30)
  ok('missing automation also appears', sm.get('automation').mcpEnabled === false)
}

// ---------- 7. corrupted file → defaults ---------------------------------
section('corrupted JSON → falls back to defaults silently')
{
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(TEST_USERDATA, 'settings.json'), '{ this is not valid json')
  delete require.cache[require.resolve('../browser/settings-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { SettingsManager } = require('../browser/settings-manager.js')
  const sm = new SettingsManager()
  ok('falls back to defaults', sm.get('general').logLevel === 'INFO')
}

// ---------- 8. onboarding helpers ---------------------------------------
section('markOnboarded + markOnboardingSkipped')
{
  const { SettingsManager } = freshSetup()
  const sm = new SettingsManager()
  ok('initial completed=false', sm.get('onboarding').completed === false)
  sm.markOnboarded()
  ok('after markOnboarded', sm.get('onboarding').completed === true)

  sm.resetSection('onboarding')
  sm.markOnboardingSkipped()
  ok(
    'after markOnboardingSkipped: completed=true',
    sm.get('onboarding').completed === true,
  )
  ok(
    'skippedAt set',
    typeof sm.get('onboarding').skippedAt === 'number' &&
      sm.get('onboarding').skippedAt > 0,
  )
}

// ---------- 9. handlers wrappers ---------------------------------------
section('handlers: broadcasts + delegation')
{
  freshSetup()
  delete require.cache[require.resolve('../browser/settings-handlers.js')]
  const { SettingsManager } = require('../browser/settings-manager.js')
  const { buildSettingsHandlers } = require('../browser/settings-handlers.js')
  const sm = new SettingsManager()
  const broadcasts = []
  const browser = {
    settingsManager: sm,
    broadcastToWebUI(channel, payload) {
      broadcasts.push({ channel, payload })
    },
  }
  const h = buildSettingsHandlers(browser)
  ok('getAll returns object', !!h.getAll().general)
  const r = h.set('general', { devMode: true })
  ok('set returns updated section', r.devMode === true)
  ok(
    'broadcast fired',
    broadcasts.some((b) => b.channel === 'oz:settings:changed'),
  )
  // Invalid → no broadcast
  broadcasts.length = 0
  const r2 = h.set('general', { logLevel: 'BOGUS' })
  ok('invalid returns __error', !!r2.__error)
  ok('no broadcast on error', broadcasts.length === 0)
  // resetAll fires broadcast
  h.resetAll()
  ok(
    'resetAll fires broadcast',
    broadcasts.some((b) => b.channel === 'oz:settings:changed'),
  )
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
