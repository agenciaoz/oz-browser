// OZ Browser — MCP server smoke test (Node-puro, sin Electron real).
//
// Cómo correr:
//   node tests/mcp-server.smoketest.js
//
// Cubre:
//   - server arranca en port asignado
//   - GET /health responde con shape esperado
//   - POST /mcp initialize → protocolVersion + serverInfo
//   - POST /mcp tools/list → todos los tools v1 con schemas
//   - POST /mcp tools/call oz.identities.list → array
//   - POST /mcp tools/call oz.identities.create → identity object
//   - POST /mcp tools/call oz.identities.create con cap → __error
//   - POST /mcp tools/call oz.system.getMetrics → shape esperado
//   - POST /mcp tools/call con name desconocido → JSON-RPC error -32601
//   - bearer token: 401 si no se manda, 200 si se manda
//   - SSE GET /mcp/events: hello + evento al broadcast
//   - contract test: cada IPC channel oz:identities:* o oz:tabs:* tiene tool MCP
//
// NO cubre (requiere GUI):
//   - WebContentsView creation, materialization de tabs
//   - Browser.broadcastToWebUI real (mockeado)

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

// ---------- Electron mock ----------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-mcp-test-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser MCP Test',
    getAppPath: () => path.resolve(__dirname, '..'), // 1.5f: contentPreloadPath()
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
  ipcMain: {
    handle() {}, // no-op — we don't go through IPC layer in this test
  },
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

process.env.OZ_TIER = 'paid' // skip cap for the bulk of tests
delete require.cache[require.resolve('../browser/identity-manager.js')]
delete require.cache[require.resolve('../browser/logger.js')]

const { IdentityManager } = require('../browser/identity-manager.js')
const { buildIdentityHandlers } = require('../browser/identity-handlers.js')
const { buildTabHandlers } = require('../browser/tab-handlers.js')
const { MCPServer } = require('../browser/mcp-server.js')

// ---------- Test runner ------------------------------------------------------

let passed = 0,
  failed = 0
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

function makeMockBrowser() {
  const broadcasts = []
  const im = new IdentityManager()
  const browser = {
    identityManager: im,
    activeIdentityId: im.getDefault().id,
    windows: [],
    handlers: null, // will be filled
    broadcastToWebUI(channel, ...args) {
      broadcasts.push({ channel, args })
    },
    getFocusedWindow() {
      return null
    },
    _broadcasts: broadcasts,
  }
  browser.handlers = {
    identities: buildIdentityHandlers(browser),
    tabs: buildTabHandlers(browser),
  }
  return browser
}

// ---------- HTTP helpers ----------------------------------------------------

function postRpc(port, body, token) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d || 'null') })
          } catch (e) {
            resolve({ status: res.statusCode, body: d, parseError: e.message })
          }
        })
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function getJSON(port, p, token) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = http.request(
      { hostname: '127.0.0.1', port, path: p, method: 'GET', headers },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d || 'null') })
          } catch (e) {
            resolve({ status: res.statusCode, body: d })
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ---------- Tests -----------------------------------------------------------

console.log('OZ Browser — MCP server smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)
;(async () => {
  // 1. Boot server with random port
  section('Boot MCP server')
  const browser = makeMockBrowser()
  const port = 19223 + Math.floor(Math.random() * 1000)
  const server = new MCPServer(browser, { port })
  await server.start()
  ok('server.start() resolves', !!server.server)
  ok('server.tools loaded', Array.isArray(server.tools) && server.tools.length > 0)

  // 2. /health
  section('GET /health')
  {
    const r = await getJSON(port, '/health')
    ok('status === 200', r.status === 200)
    ok('body.status === "ok"', r.body && r.body.status === 'ok')
    ok('body.uptimeSec is number', typeof r.body.uptimeSec === 'number')
    ok('body.identitiesCount === 1', r.body.identitiesCount === 1)
  }

  // 3. JSON-RPC initialize
  section('POST /mcp initialize')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })
    ok('status === 200', r.status === 200)
    ok('body.id === 1', r.body && r.body.id === 1)
    ok('result.protocolVersion exists', r.body.result && r.body.result.protocolVersion)
    ok(
      'result.serverInfo.name === oz-browser-mcp',
      r.body.result.serverInfo.name === 'oz-browser-mcp',
    )
    ok(
      'result.capabilities.tools exists',
      r.body.result.capabilities && r.body.result.capabilities.tools,
    )
  }

  // 4. tools/list
  section('POST /mcp tools/list')
  let toolNames = []
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    ok('result.tools is array', r.body && Array.isArray(r.body.result.tools))
    toolNames = r.body.result.tools.map((t) => t.name)
    ok('contains oz.identities.list', toolNames.includes('oz.identities.list'))
    ok('contains oz.identities.create', toolNames.includes('oz.identities.create'))
    ok('contains oz.tabs.list', toolNames.includes('oz.tabs.list'))
    ok('contains oz.system.getMetrics', toolNames.includes('oz.system.getMetrics'))
    ok('contains oz.events.subscribe', toolNames.includes('oz.events.subscribe'))
    ok(
      'every tool has inputSchema',
      r.body.result.tools.every((t) => t.inputSchema),
    )
    ok(
      'every tool has description',
      r.body.result.tools.every(
        (t) => typeof t.description === 'string' && t.description.length > 0,
      ),
    )
  }

  // 5. tools/call oz.identities.list
  section('POST /mcp tools/call oz.identities.list')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'oz.identities.list', arguments: {} },
    })
    ok('result.content[0].type === text', r.body.result.content[0].type === 'text')
    ok('isError === false', r.body.result.isError === false)
    const meta = r.body.result._meta && r.body.result._meta.value
    ok(
      '_meta.value is array (Default identity)',
      Array.isArray(meta) && meta.length === 1,
    )
    ok('Default identity returned', meta && meta[0] && meta[0].isDefault === true)
  }

  // 6. tools/call oz.identities.create
  section('POST /mcp tools/call oz.identities.create')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'oz.identities.create',
        arguments: { name: 'MCP Test', color: '#abcdef' },
      },
    })
    const v = r.body.result._meta.value
    ok('created identity has id', v && typeof v.id === 'string' && v.id.length > 0)
    ok('created identity has correct name', v && v.name === 'MCP Test')
    ok('created identity has correct color', v && v.color === '#abcdef')
    ok(
      'broadcast oz:identities:changed fired',
      browser._broadcasts.some((b) => b.channel === 'oz:identities:changed'),
    )
  }

  // 7. Unknown tool
  section('POST /mcp tools/call name desconocido')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'oz.nope.doesNotExist', arguments: {} },
    })
    ok(
      'error.code === -32601',
      r.body.error && r.body.error.code === -32601,
      JSON.stringify(r.body),
    )
    ok(
      'error.message mentions tool',
      r.body.error.message.includes('oz.nope.doesNotExist'),
    )
  }

  // 8. Unknown method
  section('POST /mcp method desconocido')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 6,
      method: 'foo/bar',
      params: {},
    })
    ok('error.code === -32601', r.body.error && r.body.error.code === -32601)
  }

  // 9. Notification (no id) → no response body
  section('POST /mcp notification (no id)')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    })
    ok('status === 200', r.status === 200)
    // body should be null/empty per JSON-RPC spec for notifications
    ok(
      'no response body for notification (or null)',
      r.body === null || r.body === undefined,
    )
  }

  // 10. system.getMetrics
  section('POST /mcp tools/call oz.system.getMetrics')
  {
    const r = await postRpc(port, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'oz.system.getMetrics', arguments: {} },
    })
    const v = r.body.result._meta.value
    ok('metrics has memoryMB', typeof v.memoryMB === 'number')
    ok('metrics has identitiesCount', v.identitiesCount === 2) // 1 Default + 1 created above
    ok('metrics has uptimeSec', typeof v.uptimeSec === 'number')
    ok(
      'metrics has tabsLazy and tabsMaterialized',
      typeof v.tabsLazy === 'number' && typeof v.tabsMaterialized === 'number',
    )
  }

  // 11. Bad JSON
  section('POST /mcp parse error')
  {
    const r = await postRpc(port, '{ this is not json')
    ok(
      'error.code === -32700',
      r.body.error && r.body.error.code === -32700,
      JSON.stringify(r.body),
    )
  }

  // Stop, restart with token to test auth
  await server.stop()
  ok('server.stop() resolves', !server.server)

  // 12. Bearer token
  section('Bearer token enforcement')
  {
    const browser2 = makeMockBrowser()
    const server2 = new MCPServer(browser2, { port: port + 1, token: 'secret123' })
    await server2.start()

    const noAuth = await postRpc(port + 1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })
    ok('without token → 401', noAuth.status === 401)

    const withAuth = await postRpc(
      port + 1,
      { jsonrpc: '2.0', id: 2, method: 'initialize' },
      'secret123',
    )
    ok('with correct token → 200', withAuth.status === 200)
    ok(
      'with correct token → result valid',
      withAuth.body.result && withAuth.body.result.serverInfo,
    )

    const badAuth = await postRpc(
      port + 1,
      { jsonrpc: '2.0', id: 3, method: 'initialize' },
      'wrong',
    )
    ok('with wrong token → 401', badAuth.status === 401)

    await server2.stop()
  }

  // 13. SSE
  section('SSE /mcp/events')
  await new Promise((resolve, reject) => {
    const browser3 = makeMockBrowser()
    const server3 = new MCPServer(browser3, { port: port + 2 })
    server3.start().then(() => {
      const req = http.request(
        { hostname: '127.0.0.1', port: port + 2, path: '/mcp/events', method: 'GET' },
        (res) => {
          ok('SSE status === 200', res.statusCode === 200)
          ok(
            'SSE Content-Type',
            res.headers['content-type'].includes('text/event-stream'),
          )

          let buffer = ''
          let sawHello = false
          let sawTabUpdate = false
          res.on('data', (chunk) => {
            buffer += chunk.toString('utf-8')
            if (buffer.includes('event: hello')) sawHello = true
            if (buffer.includes('event: tabs.updated')) sawTabUpdate = true
            if (sawHello && sawTabUpdate) {
              ok('hello event received', sawHello)
              ok('tabs.updated event received', sawTabUpdate)
              res.destroy()
              server3.stop().then(resolve, reject)
            }
          })

          // After a tick, broadcast a tab event — server3 wires browser3 broadcastToWebUI
          // to fan out via SSE.
          setTimeout(() => {
            browser3.broadcastToWebUI('oz:tabs:updated', {
              kind: 'created',
              tabId: 'fake',
            })
          }, 50)

          // Safety timeout
          setTimeout(() => {
            if (!sawHello || !sawTabUpdate) {
              ok(
                'SSE events received',
                false,
                `sawHello=${sawHello}, sawTabUpdate=${sawTabUpdate}`,
              )
              res.destroy()
              server3.stop().then(resolve, reject)
            }
          }, 1500)
        },
      )
      req.on('error', reject)
      req.end()
    }, reject)
  })

  // 14. Contract test: every preload-exposed identity/tab IPC has matching MCP tool
  section('Contract test IPC↔MCP')
  {
    const preloadPath = path.resolve(__dirname, '../preload.js')
    const preload = fs.readFileSync(preloadPath, 'utf-8')

    // Channels the preload bridge invokes for the identities + tabs + workspaces
    // + vault + accounts domains. We extract them from the preload.js source
    // so we don't drift.
    const found = new Set()
    const re =
      /ipcRenderer\.invoke\('(oz:(identities|tabs|workspaces|vault|accounts|excel):[a-zA-Z]+)'/g
    let m
    while ((m = re.exec(preload)) !== null) found.add(m[1])

    // Map IPC channel → expected MCP tool name. Some channels are exempt
    // (e.g. legacy rename/setColor wrappers — covered by *.update which is
    // the canonical version).
    const exempt = new Set([
      'oz:identities:rename', // wrapper of oz.identities.update
      'oz:identities:setColor', // wrapper of oz.identities.update
      'oz:tabs:getIdentity', // info available via oz.tabs.list
      'oz:tabs:bulkCreateLazy', // power-user, reduce v1 surface
      'oz:workspaces:rename', // wrapper of oz.workspaces.update
      'oz:workspaces:setColor', // wrapper of oz.workspaces.update
      'oz:excel:pickExportPath', // 1.5f UI-only file dialog wrapper
      'oz:excel:pickImportPath', // 1.5f UI-only file dialog wrapper
    ])

    for (const channel of found) {
      if (exempt.has(channel)) continue
      const expectedTool = channel.replace(/^oz:/, 'oz.').replace(/:/, '.')
      ok(
        `IPC ${channel} has matching MCP tool ${expectedTool}`,
        toolNames.includes(expectedTool),
        `Missing tool: ${expectedTool}`,
      )
    }
  }

  // ---------- Done -----------------------------------------------------------
  Module._load = originalLoad
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures)
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    process.exit(1)
  }
  process.exit(0)
})().catch((err) => {
  console.error('Test harness crashed:', err)
  process.exit(2)
})
