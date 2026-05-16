// OZ Browser — hud-setup smoke test (K1-extras / v1.4.3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/hud-setup.smoketest.js
//
// Cubre la versión pivot (post-2026-05-15) basada en
// `webContents.executeJavaScript()` desde main process, en lugar del
// `session.registerPreloadScript` que falló silenciosamente por sandbox
// bundle issues. Ver hud-setup.js comment header para el rationale completo.
//
//   - shouldSkipUrl(url)         — filter chrome-extension/devtools/about
//   - buildInjectionScript(ctx)  — pure script builder con data inlined
//   - setupHud(browser)          — idempotent + marks _hudInstalled
//   - refreshHudOnTab(browser, wc) — direct injection path con multi-strategy
//                                    identity lookup
//   - broadcastHudUpdate(browser) — re-execute en tabs materializados
//   - broadcastToWebUI wrap       — whitelist channel triggers refresh
//
// Approach: fakes inyectables, NO requiere Electron real.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-hud-setup-'))
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
    getAppPath: () => '/fake/app/path',
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

const {
  setupHud,
  HUD_REFRESH_CHANNELS,
  broadcastHudUpdate,
  refreshHudOnTab,
  buildInjectionScript,
  shouldSkipUrl,
} = require('../browser/hud-setup')

section('HUD_REFRESH_CHANNELS')

ok('HUD_REFRESH_CHANNELS is a Set', HUD_REFRESH_CHANNELS instanceof Set)
ok(
  'HUD_REFRESH_CHANNELS includes identities:changed',
  HUD_REFRESH_CHANNELS.has('oz:identities:changed'),
)
ok(
  'HUD_REFRESH_CHANNELS includes accounts:changed (anti-logout flips)',
  HUD_REFRESH_CHANNELS.has('oz:accounts:changed'),
)
ok(
  'HUD_REFRESH_CHANNELS includes proxyHealth:changed',
  HUD_REFRESH_CHANNELS.has('oz:proxyHealth:changed'),
)

section('shouldSkipUrl')

ok('shouldSkipUrl("") skips empty', shouldSkipUrl('') === true)
ok('shouldSkipUrl(null) skips null', shouldSkipUrl(null) === true)
ok(
  'shouldSkipUrl(chrome-ext) skips',
  shouldSkipUrl('chrome-extension://abc/page.html') === true,
)
ok(
  'shouldSkipUrl(devtools) skips',
  shouldSkipUrl('devtools://devtools/bundled/inspector.html') === true,
)
ok('shouldSkipUrl(about:blank) skips', shouldSkipUrl('about:blank') === true)
ok('shouldSkipUrl(about:srcdoc) skips', shouldSkipUrl('about:srcdoc...') === true)
ok(
  'shouldSkipUrl(https) does NOT skip',
  shouldSkipUrl('https://www.instagram.com/') === false,
)
ok('shouldSkipUrl(http) does NOT skip', shouldSkipUrl('http://example.com/') === false)

section('buildInjectionScript')

// empty ctx → remove existing script
const removeScript = buildInjectionScript(null)
ok(
  'buildInjectionScript(null) returns remove-existing block',
  removeScript.includes('removeChild'),
)
ok(
  'buildInjectionScript(null) does NOT include data payload',
  !removeScript.includes('"identityId"'),
)

// full ctx → inject
const fullScript = buildInjectionScript({
  identity: { id: 'i1', name: 'IG Maria', color: '#7F77DD', isDefault: false },
  workspace: { id: 'w1', name: 'Workspace 2' },
  proxy: { id: 'p1', country: 'MX', host: '186.32.144.18', port: 10001, healthy: true },
  session: { status: 'green' },
})
ok('buildInjectionScript inlines identity name', fullScript.includes('IG Maria'))
ok('buildInjectionScript inlines workspace name', fullScript.includes('Workspace 2'))
ok('buildInjectionScript inlines MX flag', fullScript.includes('🇲🇽'))
ok('buildInjectionScript inlines IP last octets', fullScript.includes('·144.18'))
ok(
  'buildInjectionScript includes identityId for localStorage key',
  fullScript.includes('"i1"'),
)
ok(
  'buildInjectionScript includes shadow DOM attachment',
  fullScript.includes('attachShadow'),
)
ok(
  'buildInjectionScript includes click handler for collapse',
  fullScript.includes('collapse'),
)
ok(
  'buildInjectionScript includes click handler for expand',
  fullScript.includes('expand'),
)
ok(
  'buildInjectionScript wraps in IIFE + try/catch',
  fullScript.includes('(function()') && fullScript.includes('catch'),
)

section('setupHud + refreshHudOnTab + broadcast wrap')

function makeFakeBrowserForSetup() {
  const broadcastCalls = []
  const wcCalls = []
  const tabs = [
    {
      id: 't1',
      identityId: 'i1',
      materialized: true,
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://www.instagram.com/',
        executeJavaScript: (script) => {
          wcCalls.push({ tabId: 't1', script })
          return Promise.resolve()
        },
      },
    },
    { id: 't2-lazy', identityId: 'i1', materialized: false, webContents: null },
    {
      id: 't3',
      identityId: 'i1',
      materialized: true,
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://x.com/',
        executeJavaScript: (script) => {
          wcCalls.push({ tabId: 't3', script })
          return Promise.resolve()
        },
      },
    },
  ]
  // Link tab.webContents back to tab for the strategy-1 lookup.
  return {
    browser: {
      activeIdentityId: 'i1',
      identityManager: {
        get: (id) =>
          id === 'i1' ? { id: 'i1', name: 'IG Maria', color: '#7F77DD' } : null,
      },
      workspaceManager: { get: () => null },
      proxyAssignment: { resolve: () => null },
      accountVault: { isUnlocked: false, list: () => [] },
      handlers: {
        hud: {
          getContext: (id) =>
            id === 'i1'
              ? {
                  identity: {
                    id: 'i1',
                    name: 'IG Maria',
                    color: '#7F77DD',
                    isDefault: false,
                  },
                  workspace: null,
                  proxy: null,
                  session: { status: 'locked' },
                }
              : { identity: null, workspace: null, proxy: null, session: null },
        },
      },
      windows: [{ tabs: { tabList: tabs } }],
      broadcastToWebUI: (channel, ...args) => {
        broadcastCalls.push({ channel, args })
      },
    },
    broadcastCalls,
    wcCalls,
  }
}

const sf = makeFakeBrowserForSetup()
setupHud(sf.browser)
ok('setupHud marks browser._hudInstalled', sf.browser._hudInstalled === true)
ok('setupHud is idempotent', setupHud(sf.browser) === false)

// refreshHudOnTab — directly exercise the injection path
const wc1 = sf.browser.windows[0].tabs.tabList[0].webContents
const refreshed = refreshHudOnTab(sf.browser, wc1)
ok('refreshHudOnTab returns true on injection', refreshed === true)
ok('refreshHudOnTab calls executeJavaScript', sf.wcCalls.length === 1)
ok('injected script contains identity name', sf.wcCalls[0].script.includes('IG Maria'))

// skip URL → no injection
sf.wcCalls.length = 0
const wcExt = {
  isDestroyed: () => false,
  getURL: () => 'chrome-extension://abc/page.html',
  executeJavaScript: () => Promise.resolve(),
}
const refreshedExt = refreshHudOnTab(sf.browser, wcExt)
ok('refreshHudOnTab on chrome-extension URL returns false', refreshedExt === false)
ok('no executeJavaScript on skipped URL', sf.wcCalls.length === 0)

// broadcastHudUpdate hits materialized tabs only
sf.wcCalls.length = 0
const hitCount = broadcastHudUpdate(sf.browser)
ok('broadcastHudUpdate returns count', hitCount === 2)
ok('broadcastHudUpdate hits t1+t3, skips t2-lazy', sf.wcCalls.length === 2)

// broadcastToWebUI wrap — whitelist channel triggers HUD refresh
sf.wcCalls.length = 0
sf.browser.broadcastToWebUI('oz:identities:changed')
ok(
  'broadcasting oz:identities:changed triggers executeJavaScript',
  sf.wcCalls.length === 2,
)

// Non-whitelist channel does NOT trigger HUD update
sf.wcCalls.length = 0
sf.browser.broadcastToWebUI('oz:tabs:updated', { kind: 'created' })
ok('non-whitelist channel does NOT trigger HUD refresh', sf.wcCalls.length === 0)

// Defensive: missing handlers / windows
ok('broadcastHudUpdate(null) returns 0', broadcastHudUpdate(null) === 0)
ok('broadcastHudUpdate({}) returns 0', broadcastHudUpdate({}) === 0)
ok('refreshHudOnTab(null, null) returns false', refreshHudOnTab(null, null) === false)
ok(
  'refreshHudOnTab on destroyed wc returns false',
  refreshHudOnTab(sf.browser, { isDestroyed: () => true }) === false,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
