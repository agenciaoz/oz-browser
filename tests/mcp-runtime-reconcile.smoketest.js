// OZ Browser — MCP runtime reconcile smoke test (Node-puro, sin Electron real).
//
// Cómo correr:
//   node tests/mcp-runtime-reconcile.smoketest.js
//
// Split from mcp-server.smoketest.js per ADR 0005 (500-LOC budget).
//
// Cubre (v1.6.1):
//   - getMcpStatus shape cuando server está off
//   - reconcileMcpRuntime con automation.mcpEnabled=false → noop
//   - reconcileMcpRuntime con automation.mcpEnabled=true → server arranca
//   - reconcile idempotente (same config = same instance)
//   - reconcile con port/token change → stop + restart
//   - buildCoworkConfigSnippet shape (command/args/env) + bridge path absoluto
//   - snippet incluye OZ_MCP_TOKEN solo cuando token está set
//   - reconcile con enabled=false → stop + null server

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ---------- Electron mock (matches mcp-server.smoketest.js) -----------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-mcp-reconcile-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser MCP Reconcile Test',
    getAppPath: () => path.resolve(__dirname, '..'),
    on() {},
    whenReady: () => Promise.resolve(),
  },
  session: {
    defaultSession: {
      __label: 'default',
      setUserAgent() {},
      cookies: { onChanged: { addListener() {} } },
    },
    fromPartition: (partition) => {
      if (!fakeElectron.session.__partitionCache) {
        fakeElectron.session.__partitionCache = new Map()
      }
      const cache = fakeElectron.session.__partitionCache
      if (cache.has(partition)) return cache.get(partition)
      const ses = {
        __label: partition,
        setUserAgent() {},
        cookies: { onChanged: { addListener() {} } },
      }
      cache.set(partition, ses)
      return ses
    },
  },
  ipcMain: { handle() {} },
  WebContentsView: class {
    constructor(opts = {}) {
      this.webContents = opts.webContents || { id: -1 }
    }
    setBounds() {}
    setBorderRadius() {}
    setVisible() {}
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

process.env.OZ_TIER = 'paid'
delete require.cache[require.resolve('../browser/identity-manager.js')]
delete require.cache[require.resolve('../browser/logger.js')]

const { IdentityManager } = require('../browser/identity-manager.js')
const { buildIdentityHandlers } = require('../browser/identity-handlers.js')
const { buildTabHandlers } = require('../browser/tab-handlers.js')
const {
  reconcileMcpRuntime,
  getMcpStatus,
  buildCoworkConfigSnippet,
} = require('../browser/mcp-server-setup.js')

// ---------- Test runner -----------------------------------------------------

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

// ---------- Mock Browser ----------------------------------------------------

function makeMockBrowser(automation) {
  const broadcasts = []
  const im = new IdentityManager()
  const browser = {
    identityManager: im,
    activeIdentityId: im.getDefault().id,
    windows: [],
    handlers: null,
    broadcastToWebUI(channel, ...args) {
      broadcasts.push({ channel, args })
    },
    getFocusedWindow() {
      return null
    },
    mcpServer: null,
    mcpServerStartedAt: null,
    mcpServerLastError: null,
    settingsManager: {
      get(section) {
        return section === 'automation' ? { ...automation } : null
      },
    },
    _broadcasts: broadcasts,
  }
  browser.handlers = {
    identities: buildIdentityHandlers(browser),
    tabs: buildTabHandlers(browser),
  }
  return browser
}

// ---------- Tests -----------------------------------------------------------

console.log('OZ Browser — MCP runtime reconcile smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)
;(async () => {
  // Use a port far from the main mcp-server.smoketest.js fixture so parallel
  // runs do not collide on the loopback listen socket.
  const PORT = 28223
  const automation = { mcpEnabled: false, mcpPort: PORT, mcpToken: null }
  const browser = makeMockBrowser(automation)

  // Save env in case the harness was invoked with OZ_MCP_* set.
  const savedEnv = {
    enabled: process.env.OZ_MCP_ENABLED,
    port: process.env.OZ_MCP_PORT,
    token: process.env.OZ_MCP_TOKEN,
  }
  delete process.env.OZ_MCP_ENABLED
  delete process.env.OZ_MCP_PORT
  delete process.env.OZ_MCP_TOKEN

  section('Status snapshot when disabled')
  {
    const s = getMcpStatus(browser)
    ok('running=false', s.running === false)
    ok('enabled=false', s.enabled === false)
    ok('port reflects setting', s.port === PORT)
    ok('toolCount 0', s.toolCount === 0)
    ok('lastError null', s.lastError === null)
  }

  section('Reconcile while disabled — noop')
  await reconcileMcpRuntime(browser)
  ok('no server created', browser.mcpServer === null)

  section('Reconcile enable → server boots')
  automation.mcpEnabled = true
  const status1 = await reconcileMcpRuntime(browser)
  ok('server created', browser.mcpServer !== null)
  ok('status.running=true', status1.running === true)
  ok('port matches', status1.port === PORT)
  ok('toolCount > 0', status1.toolCount > 0)

  section('Reconcile idempotent')
  const serverBefore = browser.mcpServer
  await reconcileMcpRuntime(browser)
  ok('same server instance', browser.mcpServer === serverBefore)

  section('buildCoworkConfigSnippet — no token')
  {
    const snippet = buildCoworkConfigSnippet(browser)
    ok(
      'top-level mcpServers.oz-browser exists',
      snippet && snippet.mcpServers && snippet.mcpServers['oz-browser'],
    )
    const oz = snippet.mcpServers['oz-browser']
    ok('command=node', oz.command === 'node')
    ok(
      'args[0] is absolute bridge path',
      Array.isArray(oz.args) &&
        oz.args[0].endsWith('tools/mcp-stdio-bridge.js') &&
        path.isAbsolute(oz.args[0]),
    )
    ok(
      'env.OZ_MCP_URL reflects port',
      oz.env && oz.env.OZ_MCP_URL === `http://127.0.0.1:${PORT}`,
    )
    ok('no OZ_MCP_TOKEN when token null', !('OZ_MCP_TOKEN' in (oz.env || {})))
  }

  section('Reconcile token-change → stop + restart')
  automation.mcpToken = 'secret-xyz'
  const status2 = await reconcileMcpRuntime(browser)
  ok('status.tokenRequired=true', status2.tokenRequired === true)
  ok(
    'cowork snippet includes token after set',
    buildCoworkConfigSnippet(browser).mcpServers['oz-browser'].env.OZ_MCP_TOKEN ===
      'secret-xyz',
  )

  section('Reconcile disable → stop + null server')
  automation.mcpEnabled = false
  automation.mcpToken = null
  const status3 = await reconcileMcpRuntime(browser)
  ok('server null', browser.mcpServer === null)
  ok('status.running=false', status3.running === false)

  // Restore env so any test invoking this script does not get side-effected.
  if (savedEnv.enabled !== undefined) process.env.OZ_MCP_ENABLED = savedEnv.enabled
  if (savedEnv.port !== undefined) process.env.OZ_MCP_PORT = savedEnv.port
  if (savedEnv.token !== undefined) process.env.OZ_MCP_TOKEN = savedEnv.token

  Module._load = originalLoad
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    }
    process.exit(1)
  }
  process.exit(0)
})().catch((err) => {
  console.error('Test harness crashed:', err)
  process.exit(2)
})
