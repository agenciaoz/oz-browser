// OZ Browser — hud-handlers + preload-hud-script + hud-setup smoke test
// (K1-extras / v1.4.3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/hud-handlers.smoketest.js
//
// Cubre:
//   - preload-hud-script.js: countryToFlag, ipLastOctets, escapeHtml,
//     badgeInitials, sessionPill, pillTitle, buildExpandedHtml, buildCollapsedHtml
//   - hud-handlers.js: getContext + getContextForSession + getCollapsed +
//     setCollapsed + state persistence
//   - hud-setup.js: setupHud preload hook + broadcastHudUpdate + broadcast
//     wrap (HUD_REFRESH_CHANNELS filter)
//
// Approach: fakes inyectables, NO requiere Electron real.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-hud-'))
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

// ============================================================================
// preload-hud-script.js
// ============================================================================
section('preload-hud-script: pure builders')

const {
  countryToFlag,
  ipLastOctets,
  escapeHtml,
  badgeInitials,
  sessionPill,
  pillTitle,
  buildHudStyles,
  buildExpandedHtml,
  buildCollapsedHtml,
} = require('../browser/preload-hud-script')

// countryToFlag
ok('countryToFlag("MX") returns Mexican flag', countryToFlag('MX') === '🇲🇽')
ok('countryToFlag("US") returns US flag', countryToFlag('US') === '🇺🇸')
ok('countryToFlag("mx") tolerates lowercase', countryToFlag('mx') === '🇲🇽')
ok('countryToFlag(" MX ") trims whitespace', countryToFlag(' MX ') === '🇲🇽')
ok('countryToFlag("MXX") returns empty (>2)', countryToFlag('MXX') === '')
ok('countryToFlag("M") returns empty (<2)', countryToFlag('M') === '')
ok('countryToFlag("") returns empty', countryToFlag('') === '')
ok('countryToFlag(null) returns empty', countryToFlag(null) === '')
ok('countryToFlag("12") rejects non-letters', countryToFlag('12') === '')
ok('countryToFlag("M1") rejects digits', countryToFlag('M1') === '')

// ipLastOctets
ok(
  'ipLastOctets("186.32.144.18") → "·144.18"',
  ipLastOctets('186.32.144.18') === '·144.18',
)
ok('ipLastOctets("10.0.0.1") → "·0.1"', ipLastOctets('10.0.0.1') === '·0.1')
ok(
  'ipLastOctets("us-pr.oxylabs.io") → "us-pr"',
  ipLastOctets('us-pr.oxylabs.io') === 'us-pr',
)
ok(
  'ipLastOctets("very-long-hostname-here.example.com") clamps to 12+…',
  ipLastOctets('very-long-hostname-here.example.com') === 'very-long-ho…',
)
ok('ipLastOctets(null) → ""', ipLastOctets(null) === '')
ok('ipLastOctets("") → ""', ipLastOctets('') === '')

// escapeHtml
ok('escapeHtml("<script>") encodes < and >', escapeHtml('<script>') === '&lt;script&gt;')
ok('escapeHtml("a & b") encodes &', escapeHtml('a & b') === 'a &amp; b')
ok(
  'escapeHtml(\'"hello"\') encodes quotes',
  escapeHtml('"hello"') === '&quot;hello&quot;',
)
ok('escapeHtml("don\'t") encodes apostrophe', escapeHtml("don't") === 'don&#39;t')
ok('escapeHtml(null) returns empty', escapeHtml(null) === '')
ok('escapeHtml(undefined) returns empty', escapeHtml(undefined) === '')

// badgeInitials
ok('badgeInitials("Insta Maria") → "IN"', badgeInitials('Insta Maria') === 'IN')
ok('badgeInitials("default") → "DE"', badgeInitials('default') === 'DE')
ok('badgeInitials("") → "??"', badgeInitials('') === '??')
ok('badgeInitials(null) → "??"', badgeInitials(null) === '??')

// sessionPill
ok(
  "sessionPill({status:'green'}) → 'green'",
  sessionPill({ status: 'green' }) === 'green',
)
ok(
  "sessionPill({status:'needs_relogin'}) → 'red'",
  sessionPill({ status: 'needs_relogin' }) === 'red',
)
ok("sessionPill({status:'red'}) → 'red'", sessionPill({ status: 'red' }) === 'red')
ok("sessionPill({status:'warn'}) → 'amber'", sessionPill({ status: 'warn' }) === 'amber')
ok(
  "sessionPill({status:'locked'}) → 'gray'",
  sessionPill({ status: 'locked' }) === 'gray',
)
ok(
  "sessionPill({status:'unknown'}) → 'gray'",
  sessionPill({ status: 'unknown' }) === 'gray',
)
ok('sessionPill(null) → "gray"', sessionPill(null) === 'gray')

// pillTitle
ok(
  "pillTitle({status:'needs_relogin'}) returns relogin message",
  pillTitle({ status: 'needs_relogin' }).includes('re-login'),
)
ok(
  "pillTitle({status:'locked'}) mentions vault",
  pillTitle({ status: 'locked' }).toLowerCase().includes('vault'),
)
ok(
  "pillTitle({status:'green'}) says healthy",
  pillTitle({ status: 'green' }).toLowerCase().includes('healthy'),
)

// buildHudStyles — sanity check
const styles = buildHudStyles()
ok(
  'buildHudStyles() returns non-empty string',
  typeof styles === 'string' && styles.length > 100,
)
ok(
  'buildHudStyles() includes :host with z-index',
  styles.includes(':host') && styles.includes('z-index'),
)
ok(
  'buildHudStyles() includes all 4 pill colors',
  styles.includes('.pill.green') &&
    styles.includes('.pill.amber') &&
    styles.includes('.pill.red') &&
    styles.includes('.pill.gray'),
)

// buildExpandedHtml
const fullCtx = {
  identity: { id: 'i1', name: 'IG Maria Acc 14', color: '#7F77DD', isDefault: false },
  workspace: { id: 'w1', name: 'Workspace 2', color: null },
  proxy: {
    id: 'p1',
    country: 'MX',
    host: '186.32.144.18',
    port: 10001,
    protocol: 'https',
    healthy: true,
  },
  session: { status: 'green' },
}
const html = buildExpandedHtml(fullCtx)
ok('buildExpandedHtml includes identity name', html.includes('IG Maria Acc 14'))
ok('buildExpandedHtml includes workspace name', html.includes('Workspace 2'))
ok('buildExpandedHtml includes MX flag', html.includes('🇲🇽'))
ok('buildExpandedHtml includes IP last octets', html.includes('·144.18'))
ok('buildExpandedHtml uses identity color', html.includes('#7F77DD'))
ok('buildExpandedHtml uses badge initials', html.includes('>IG<'))
ok('buildExpandedHtml uses green pill class', html.includes('pill green'))
ok('buildExpandedHtml has collapse button', html.includes('data-action="collapse"'))
ok('buildExpandedHtml has role=status', html.includes('role="status"'))

// XSS defensive: identity.name with HTML
const xssCtx = {
  identity: {
    id: 'i1',
    name: '<script>alert(1)</script>',
    color: '#5b8def',
    isDefault: false,
  },
  workspace: null,
  proxy: null,
  session: { status: 'green' },
}
const xssHtml = buildExpandedHtml(xssCtx)
ok(
  'buildExpandedHtml escapes <script> tags in identity name',
  !xssHtml.includes('<script>') && xssHtml.includes('&lt;script&gt;'),
)

// Empty proxy → sub has only workspace
const noProxy = {
  identity: { id: 'i1', name: 'Default', color: '#888', isDefault: true },
  workspace: { id: 'general', name: 'General' },
  proxy: null,
  session: { status: 'green' },
}
const noProxyHtml = buildExpandedHtml(noProxy)
ok('buildExpandedHtml without proxy includes workspace', noProxyHtml.includes('General'))
ok(
  'buildExpandedHtml without proxy does NOT include flag char',
  // Just ensure no flag bytes from countryToFlag pollute the output.
  !noProxyHtml.includes('🇲🇽') && !noProxyHtml.includes('🇺🇸'),
)

// red session
const redCtx = {
  identity: { id: 'i1', name: 'X', color: '#a8a8a8', isDefault: false },
  workspace: null,
  proxy: null,
  session: { status: 'needs_relogin' },
}
const redHtml = buildExpandedHtml(redCtx)
ok('buildExpandedHtml emits red pill on needs_relogin', redHtml.includes('pill red'))
ok('buildExpandedHtml red pill has relogin tooltip', redHtml.includes('re-login'))

// buildCollapsedHtml
const collapsedHtml = buildCollapsedHtml(fullCtx)
ok('buildCollapsedHtml has collapsed class', collapsedHtml.includes('hud collapsed'))
ok('buildCollapsedHtml has expand action', collapsedHtml.includes('data-action="expand"'))
ok('buildCollapsedHtml includes identity color', collapsedHtml.includes('#7F77DD'))
ok('buildCollapsedHtml has green pill', collapsedHtml.includes('pill green'))
ok(
  'buildCollapsedHtml does NOT include workspace name',
  !collapsedHtml.includes('Workspace 2'),
)
ok('buildCollapsedHtml does NOT include flag', !collapsedHtml.includes('🇲🇽'))

// ============================================================================
// hud-handlers.js
// ============================================================================
section('hud-handlers: context blob + state persistence')

const { buildHudHandlers } = require('../browser/hud-handlers')

// Fake browser with all the managers wired
function makeFakeBrowser({ vaultUnlocked = true, accounts = [], proxy = null } = {}) {
  const identities = {
    i1: {
      id: 'i1',
      name: 'IG Maria',
      color: '#7F77DD',
      isDefault: false,
      workspaceId: 'w1',
    },
    iDefault: {
      id: 'iDefault',
      name: 'Default',
      color: '#888',
      isDefault: true,
      workspaceId: 'general',
    },
  }
  const workspaces = {
    w1: { id: 'w1', name: 'Workspace 2', color: null },
    general: { id: 'general', name: 'General', color: null },
  }
  const sessions = {
    sessForI1: { __identityId: 'i1' },
    sessForDefault: { __identityId: 'iDefault' },
  }
  return {
    identityManager: {
      get: (id) => identities[id] || null,
      identityIdForSession: (s) => (s && s.__identityId) || null,
    },
    workspaceManager: { get: (id) => workspaces[id] || null },
    proxyAssignment: {
      resolve: () => proxy,
    },
    accountVault: {
      isUnlocked: vaultUnlocked,
      list: () => accounts,
    },
    _sessions: sessions,
  }
}

// happy path with proxy + workspace + green session
const browser1 = makeFakeBrowser({
  proxy: {
    id: 'p1',
    country: 'MX',
    host: '186.32.144.18',
    port: 10001,
    protocol: 'https',
    isDisabled: false,
  },
})
const handlers1 = buildHudHandlers(browser1, { dataDir: TEST_USERDATA })
const ctx1 = handlers1.getContext('i1')
ok('getContext("i1") returns identity block', ctx1.identity && ctx1.identity.id === 'i1')
ok('getContext identity has name', ctx1.identity.name === 'IG Maria')
ok('getContext identity has color', ctx1.identity.color === '#7F77DD')
ok(
  'getContext workspace name resolved',
  ctx1.workspace && ctx1.workspace.name === 'Workspace 2',
)
ok('getContext proxy country resolved', ctx1.proxy && ctx1.proxy.country === 'MX')
ok('getContext proxy host resolved', ctx1.proxy.host === '186.32.144.18')
ok('getContext proxy healthy=true when not disabled', ctx1.proxy.healthy === true)
ok(
  'getContext session.status=green with no flagged accounts',
  ctx1.session.status === 'green',
)

// getContext with unknown identity
const ctxUnknown = handlers1.getContext('nope')
ok('getContext("nope") returns empty blob', ctxUnknown.identity === null)

// getContext(null) returns empty
const ctxNull = handlers1.getContext(null)
ok('getContext(null) returns empty blob', ctxNull.identity === null)

// vault locked → session.status = locked
const browser2 = makeFakeBrowser({ vaultUnlocked: false })
const handlers2 = buildHudHandlers(browser2, { dataDir: TEST_USERDATA })
const ctx2 = handlers2.getContext('i1')
ok(
  'getContext with vault locked → session.status=locked',
  ctx2.session.status === 'locked',
)

// account flagged → session.status = needs_relogin
const browser3 = makeFakeBrowser({
  accounts: [
    { id: 'a1', identityId: 'i1', status: 'active' },
    { id: 'a2', identityId: 'i1', status: 'needs_relogin' },
  ],
})
const handlers3 = buildHudHandlers(browser3, { dataDir: TEST_USERDATA })
const ctx3 = handlers3.getContext('i1')
ok(
  'getContext with flagged account → session.status=needs_relogin',
  ctx3.session.status === 'needs_relogin',
)

// proxy disabled → healthy=false
const browser4 = makeFakeBrowser({
  proxy: { id: 'p1', country: 'AR', host: '1.2.3.4', port: 80, isDisabled: true },
})
const handlers4 = buildHudHandlers(browser4, { dataDir: TEST_USERDATA })
const ctx4 = handlers4.getContext('i1')
ok('getContext with disabled proxy → healthy=false', ctx4.proxy.healthy === false)

// getContextForSession resolves via session
const ctxBySession = handlers1.getContextForSession(browser1._sessions.sessForI1)
ok(
  'getContextForSession resolves identity via session',
  ctxBySession.identity && ctxBySession.identity.id === 'i1',
)

// getContextForSession with unknown session falls back to identityIdArg
const ctxByArg = handlers1.getContextForSession({ __identityId: null }, 'i1')
ok(
  'getContextForSession with null session uses identityIdArg fallback',
  ctxByArg.identity && ctxByArg.identity.id === 'i1',
)

// getContextForSession with neither → empty
const ctxEmpty = handlers1.getContextForSession({ __identityId: null })
ok('getContextForSession with no resolution returns empty', ctxEmpty.identity === null)

// Collapsed state persistence
section('hud-handlers: collapsed state')

// Use fresh dataDir to avoid bleed
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-hud-state-'))
const h5 = buildHudHandlers(browser1, { dataDir: STATE_DIR })
ok('getCollapsed initial → false', h5.getCollapsed('i1') === false)
h5.setCollapsed('i1', true)
ok('setCollapsed(true) persists', h5.getCollapsed('i1') === true)
ok(
  'state file exists after setCollapsed',
  fs.existsSync(path.join(STATE_DIR, 'hud-state.json')),
)

// Verify persisted shape
const raw = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'hud-state.json'), 'utf-8'))
ok(
  'persisted state has collapsedByIdentity',
  raw.collapsedByIdentity && raw.collapsedByIdentity.i1 === true,
)

// New handler instance loads the persisted state
const h5b = buildHudHandlers(browser1, { dataDir: STATE_DIR })
ok('new instance loads persisted collapsed=true', h5b.getCollapsed('i1') === true)

// Toggle back to false → deletes the key
h5b.setCollapsed('i1', false)
ok('setCollapsed(false) flips back', h5b.getCollapsed('i1') === false)
const raw2 = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'hud-state.json'), 'utf-8'))
ok('setCollapsed(false) removes the key', raw2.collapsedByIdentity.i1 === undefined)

// null/undefined identityId → defensive
ok('getCollapsed(null) → false', h5b.getCollapsed(null) === false)
ok('setCollapsed(null, true) → false (rejected)', h5b.setCollapsed(null, true) === false)

// hud-setup tests moved to tests/hud-setup.smoketest.js — they require
// fakeElectron wiring AND would push this file past the 500 LOC budget.

// ============================================================================
// summary
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
