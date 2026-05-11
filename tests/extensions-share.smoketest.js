// OZ Browser — extensions-share smoke test (E2-C-7).
//
// Cómo correr:
//   cd oz-browser
//   node tests/extensions-share.smoketest.js
//
// Cubre la lógica pura del manager (sin Electron) inyectando fakes:
//   - persistencia load/save round-trip
//   - listInstalledInDefault excluye WebUI
//   - listEnabledForIdentity con/sin entradas
//   - reportForIdentity matriz default×enabled
//   - enable/disable persistence + idempotency + Default rejection
//   - hookSessionInit re-loads enabled list

const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-extshare-'))

// Capture loaded extension paths per session for assertions.
const loadedPerSession = new Map()
function makeFakeSession(id) {
  const loaded = []
  loadedPerSession.set(id, loaded)
  return {
    extensions: {
      loadExtension: async (p) => loaded.push(p),
      removeExtension: (extId) => {
        const i = loaded.findIndex((p) => p.includes(extId))
        if (i >= 0) loaded.splice(i, 1)
      },
      getExtension: (extId) => loaded.find((p) => p.includes(extId)) || null,
      getAllExtensions: () => [],
    },
  }
}

const defaultSes = {
  extensions: {
    getAllExtensions: () => [
      {
        id: 'webui-extension-id',
        path: '/fake/webui',
        manifest: { name: 'WebUI', version: '1.0.0' },
      },
      {
        id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
        path: '/fake/extensions/ublock',
        manifest: {
          name: 'uBlock Origin',
          version: '1.55.0',
          description: 'Block ads',
          manifest_version: 3,
        },
      },
      {
        id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
        path: '/fake/extensions/1password',
        manifest: {
          name: '1Password',
          version: '8.10',
          manifest_version: 3,
        },
      },
    ],
  },
}

const fakeApp = {
  getPath: () => TEST_USERDATA,
  getVersion: () => '0.1.0-test',
  on: () => {},
  whenReady: () => Promise.resolve(),
}
const fakeElectron = {
  app: fakeApp,
  session: { defaultSession: defaultSes },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  if (request === 'electron-chrome-extensions') {
    return {
      ElectronChromeExtensions: class {
        constructor() {}
        static handleCRXProtocol() {}
      },
    }
  }
  return originalLoad.call(this, request, parent, ...rest)
}

delete require.cache[require.resolve('../browser/extensions-share.js')]
const { ExtensionShareManager } = require('../browser/extensions-share.js')

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

console.log('OZ Browser — extensions-share smoke test')

// Fake IdentityManager — minimal API used by ExtensionShareManager.
function makeFakeIM(identities) {
  return {
    identities,
    get: (id) => identities.find((i) => i.id === id) || null,
    list: () => identities.map((i) => ({ ...i })),
    getDefault: () => identities.find((i) => i.isDefault) || identities[0],
    getSession: (id) => makeFakeSession(id),
  }
}

const IDS = [
  { id: 'default', name: 'Default', isDefault: true },
  { id: 'ig1', name: 'IG 1', isDefault: false },
  { id: 'ig2', name: 'IG 2', isDefault: false },
]

// ============================================================================
section('listInstalledInDefault')

const sm1 = new ExtensionShareManager({
  dataDir: TEST_USERDATA,
  identityManager: makeFakeIM(IDS),
})
const installed = sm1.listInstalledInDefault()
ok('returns 2 extensions (excludes WebUI)', installed.length === 2)
ok('first is uBlock', installed[0].name === 'uBlock Origin')
ok('first carries path', installed[0].path === '/fake/extensions/ublock')
ok('first carries version', installed[0].version === '1.55.0')
ok('first carries manifestVersion', installed[0].manifestVersion === 3)

// ============================================================================
section('listEnabledForIdentity (initial state)')

ok(
  'Default returns all installed IDs',
  JSON.stringify(sm1.listEnabledForIdentity('default').sort()) ===
    JSON.stringify(installed.map((e) => e.id).sort()),
)
ok('custom identity returns []', sm1.listEnabledForIdentity('ig1').length === 0)

// ============================================================================
section('reportForIdentity')

const reportDefault = sm1.reportForIdentity('default')
ok('Default report has 2 rows', reportDefault.length === 2)
ok(
  'Default report rows enabledForIdentity = true',
  reportDefault.every((r) => r.enabledForIdentity === true),
)
ok(
  'Default report rows isDefault = true',
  reportDefault.every((r) => r.isDefault === true),
)

const reportIg1 = sm1.reportForIdentity('ig1')
ok('IG1 report has 2 rows', reportIg1.length === 2)
ok(
  'IG1 report rows enabledForIdentity = false',
  reportIg1.every((r) => r.enabledForIdentity === false),
)
ok(
  'IG1 report rows isDefault = false',
  reportIg1.every((r) => r.isDefault === false),
)

// ============================================================================
section('enableForIdentity')
;(async () => {
  const r1 = await sm1.enableForIdentity('ig1', 'cjpalhdlnbpafiamejdnhcphjbkeiagm')
  ok('enable uBlock for IG1 ok', r1.ok === true)
  ok(
    'enable uBlock for IG1 returns extension info',
    r1.extension && r1.extension.name === 'uBlock Origin',
  )
  ok('IG1 enabled list now has 1 entry', sm1.listEnabledForIdentity('ig1').length === 1)

  // Second call = idempotent
  const r2 = await sm1.enableForIdentity('ig1', 'cjpalhdlnbpafiamejdnhcphjbkeiagm')
  ok('repeat enable returns alreadyEnabled', r2.ok === true && r2.alreadyEnabled === true)
  ok('IG1 enabled list still 1', sm1.listEnabledForIdentity('ig1').length === 1)

  // Default rejection
  const r3 = await sm1.enableForIdentity('default', 'cjpalhdlnbpafiamejdnhcphjbkeiagm')
  ok('Default enable rejects', r3.ok === false && r3.reason === 'default-always-enabled')

  // Unknown extension
  const r4 = await sm1.enableForIdentity('ig1', 'nonexistent-id')
  ok(
    'unknown ext rejects',
    r4.ok === false && r4.reason === 'extension-not-installed-in-default',
  )

  // Missing args
  const r5 = await sm1.enableForIdentity(null, null)
  ok('missing args rejects', r5.ok === false)

  // ==========================================================================
  section('persistence (round-trip)')

  // Re-instantiate from same dir → bindings should reload
  const sm2 = new ExtensionShareManager({
    dataDir: TEST_USERDATA,
    identityManager: makeFakeIM(IDS),
  })
  ok(
    'IG1 enabled list survives reload',
    sm2.listEnabledForIdentity('ig1').includes('cjpalhdlnbpafiamejdnhcphjbkeiagm'),
  )
  ok(
    'JSON file exists',
    fs.existsSync(path.join(TEST_USERDATA, 'extension-sharing.json')),
  )

  // ==========================================================================
  section('disableForIdentity')

  const d1 = sm2.disableForIdentity('ig1', 'cjpalhdlnbpafiamejdnhcphjbkeiagm')
  ok('disable ok', d1.ok === true)
  ok('IG1 enabled list back to []', sm2.listEnabledForIdentity('ig1').length === 0)

  // Idempotent
  const d2 = sm2.disableForIdentity('ig1', 'cjpalhdlnbpafiamejdnhcphjbkeiagm')
  ok(
    'repeat disable returns alreadyDisabled',
    d2.ok === true && d2.alreadyDisabled === true,
  )

  // Default rejection
  const d3 = sm2.disableForIdentity('default', 'whatever')
  ok(
    'Default disable rejects',
    d3.ok === false && d3.reason === 'default-uninstall-via-chrome-extensions',
  )

  // ==========================================================================
  section('hookSessionInit')

  await sm2.enableForIdentity('ig2', 'cjpalhdlnbpafiamejdnhcphjbkeiagm')
  await sm2.enableForIdentity('ig2', 'aeblfdkhhhdcdjpifhhbdiojplfjncoa')
  loadedPerSession.set('ig2-fresh', [])
  const freshSession = makeFakeSession('ig2-fresh')
  await sm2.hookSessionInit('ig2', freshSession)
  const loaded = loadedPerSession.get('ig2-fresh') || []
  ok('hookSessionInit loaded both extensions', loaded.length === 2)
  ok('hookSessionInit loaded uBlock path', loaded.includes('/fake/extensions/ublock'))
  ok(
    'hookSessionInit loaded 1password path',
    loaded.includes('/fake/extensions/1password'),
  )

  // Default identity is no-op
  loadedPerSession.set('default-noop', [])
  const defaultSession = makeFakeSession('default-noop')
  await sm2.hookSessionInit('default', defaultSession)
  ok(
    'hookSessionInit on Default is no-op',
    (loadedPerSession.get('default-noop') || []).length === 0,
  )

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  process.exit(0)
})()
