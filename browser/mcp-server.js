// OZ Browser — MCP server (hand-rolled JSON-RPC 2.0 over HTTP localhost).
//
// Qué hace: server MCP embebido en main process. Expone los handler maps de
// browser.handlers.{identities,tabs} como tools MCP. Off por default; on con
// env OZ_MCP_ENABLED=1.
//
// Doc: docs/modules/mcp-server.md
// ADR: docs/architecture/0012-oz-mcp-server.md
//
// Wire protocol:
//   - POST /mcp        JSON-RPC 2.0 (initialize, tools/list, tools/call)
//   - GET  /mcp/events Server-Sent Events stream (live tab/identity events)
//   - GET  /health     plain JSON {status:"ok", uptimeSec, ...}
//
// Auth:
//   - Default localhost-only (binds 127.0.0.1)
//   - Optional bearer token via env OZ_MCP_TOKEN. If set, every request needs
//     `Authorization: Bearer <token>`.
//
// Por qué hand-rolled (no @modelcontextprotocol/sdk): ver ADR 0012 update bis.

const http = require('http')
const { URL } = require('url')
const log = require('./logger')
const { buildToolCatalog, buildMetrics } = require('./mcp-tools')

const DEFAULT_PORT = 9223
const PROTOCOL_VERSION = '2024-11-05' // MCP spec version we implement

class MCPServer {
  constructor(browser, options = {}) {
    this.browser = browser
    this.port = Number(options.port || process.env.OZ_MCP_PORT || DEFAULT_PORT)
    this.token = options.token || process.env.OZ_MCP_TOKEN || null
    this.host = '127.0.0.1' // never bind to 0.0.0.0 — security
    this.server = null
    this.tools = null
    this.toolByName = null

    // SSE clients subscribed to live events.
    this.sseClients = new Set()
    this._eventForwarders = []
  }

  start() {
    if (this.server) return Promise.resolve()

    this.tools = buildToolCatalog(this.browser)
    this.toolByName = new Map(this.tools.map((t) => [t.name, t]))

    this._wireBrowserEvents()

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res))
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        log.info('mcp-server', 'started', {
          host: this.host,
          port: this.port,
          tokenRequired: !!this.token,
          toolsCount: this.tools.length,
        })
        resolve()
      })
    })
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      // Close all SSE connections cleanly. Ignore errors from already-closed
      // connections — best effort.
      for (const client of this.sseClients) {
        try {
          client.res.end()
        } catch {
          // noop: client likely already disconnected
        }
      }
      this.sseClients.clear()
      this._unwireBrowserEvents()
      this.server.close(() => {
        log.info('mcp-server', 'stopped', { port: this.port })
        this.server = null
        resolve()
      })
    })
  }

  // ---------- HTTP routing ---------------------------------------------------

  async _handle(req, res) {
    // CORS — only allow loopback so we can be queried from local tools / curl
    // / Claude Code's bridge. Real auth is via bearer token.
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // Bearer token check.
    if (this.token) {
      const auth = req.headers['authorization'] || ''
      if (auth !== `Bearer ${this.token}`) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }

    let url
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    } catch (_e) {
      res.statusCode = 400
      res.end('bad url')
      return
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return this._handleHealth(req, res)
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      return this._handleMcpRpc(req, res)
    }
    if (url.pathname === '/mcp/events' && req.method === 'GET') {
      return this._handleSse(req, res)
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
  }

  _handleHealth(req, res) {
    const m = buildMetrics(this.browser)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', ...m }))
  }

  // ---------- JSON-RPC over POST /mcp ---------------------------------------

  async _handleMcpRpc(req, res) {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      let request
      try {
        request = JSON.parse(body)
      } catch (_e) {
        return this._jsonRpcError(res, null, -32700, 'Parse error')
      }
      // Spec allows batch requests as arrays. Support that minimally.
      if (Array.isArray(request)) {
        const responses = []
        for (const r of request) responses.push(await this._dispatchRpc(r))
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(responses.filter(Boolean)))
      } else {
        const response = await this._dispatchRpc(request)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(response))
      }
    })
  }

  async _dispatchRpc(request) {
    const { jsonrpc, id, method, params } = request || {}
    const isNotification = id === undefined || id === null

    log.debug('mcp-server', 'rpc in', { method, id, hasParams: !!params })

    if (jsonrpc !== '2.0' || typeof method !== 'string') {
      return isNotification
        ? null
        : {
            jsonrpc: '2.0',
            id: id || null,
            error: { code: -32600, message: 'Invalid Request' },
          }
    }

    // v1.6.8: MCP spec says receivers MUST silently ignore unknown
    // notifications. Claude Desktop sends notifications/roots/list_changed
    // (and similar lifecycle pings) that the OZ server doesn't implement —
    // previously these threw METHOD_NOT_FOUND inside _callMethod and were
    // logged as ERROR with full stack, flooding the log. Short-circuit known
    // notification-namespace methods to a debug log + null response.
    if (isNotification && method.startsWith('notifications/')) {
      log.debug('mcp-server', 'ignored unknown notification', { method })
      return null
    }

    try {
      const result = await this._callMethod(method, params || {})
      log.info('mcp-server', 'rpc ok', { method, id })
      return isNotification ? null : { jsonrpc: '2.0', id, result }
    } catch (err) {
      // v1.6.8: log level depends on what kind of error this is. Notifications
      // don't get a response so logging as ERROR is misleading; METHOD_NOT_FOUND
      // on a real request is a client bug worth WARN but not ERROR; anything
      // else (server-side throw) stays ERROR with stack.
      const logCtx = { method, id, message: err.message }
      if (isNotification) {
        log.debug('mcp-server', 'rpc error in notification (ignored)', logCtx)
      } else if (err.code === 'METHOD_NOT_FOUND') {
        log.warn('mcp-server', 'rpc method not found', logCtx)
      } else {
        log.error('mcp-server', 'rpc error', { ...logCtx, stack: err.stack })
      }
      return isNotification
        ? null
        : {
            jsonrpc: '2.0',
            id,
            error: {
              code: err.code === 'METHOD_NOT_FOUND' ? -32601 : -32000,
              message: err.message || 'Internal error',
            },
          }
    }
  }

  async _callMethod(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            // We don't implement prompts/resources/sampling in v1.
          },
          serverInfo: { name: 'oz-browser-mcp', version: '0.1.0' },
        }

      case 'notifications/initialized':
        // Per MCP spec, this is a notification (no response). Caller wraps in
        // response: null in dispatchRpc since id will be undefined.
        return null

      case 'ping':
        return {}

      case 'tools/list':
        return {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }

      case 'tools/call': {
        const { name, arguments: args } = params
        if (!name) {
          throw withCode('METHOD_NOT_FOUND', 'tools/call missing name')
        }
        const tool = this.toolByName.get(name)
        if (!tool) {
          throw withCode('METHOD_NOT_FOUND', `Unknown tool: ${name}`)
        }
        const result = await Promise.resolve(tool.call(args || {}))
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          // Some clients also like a structured `result` blob; we put it on the
          // outer tools/call response under `_meta` for forward-compat.
          _meta: { value: result },
          isError: result && result.__error ? true : false,
        }
      }

      default:
        throw withCode('METHOD_NOT_FOUND', `Method not found: ${method}`)
    }
  }

  _jsonRpcError(res, id, code, message) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
  }

  // ---------- SSE for oz.events.subscribe -----------------------------------

  _handleSse(req, res) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering if proxied

    // Optional channel filter via ?channels=tabs.*,identities.*
    const url = new URL(req.url, `http://${req.headers.host}`)
    const channelsParam = url.searchParams.get('channels')
    const channels = channelsParam
      ? channelsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null

    const client = { res, channels, ip: req.socket.remoteAddress }
    this.sseClients.add(client)

    log.info('mcp-server', 'SSE client connected', {
      total: this.sseClients.size,
      channels,
    })

    // Initial hello.
    this._writeSse(client, 'hello', {
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
    })

    req.on('close', () => {
      this.sseClients.delete(client)
      log.info('mcp-server', 'SSE client disconnected', { total: this.sseClients.size })
    })
  }

  _writeSse(client, channel, payload) {
    if (client.channels && !channelMatches(client.channels, channel)) return
    try {
      client.res.write(
        `event: ${channel}\ndata: ${JSON.stringify({ channel, payload, ts: Date.now() })}\n\n`,
      )
    } catch (_e) {
      // Client likely disconnected mid-write; remove.
      this.sseClients.delete(client)
    }
  }

  _broadcastSse(channel, payload) {
    for (const client of this.sseClients) this._writeSse(client, channel, payload)
  }

  _wireBrowserEvents() {
    // We can't directly listen to Tabs/Identities events because those are per
    // window. Hook into the broadcastToWebUI side-channel: we monkey-patch
    // browser.broadcastToWebUI to also fan out to SSE clients.
    if (this._origBroadcast) return // already wired (idempotent)

    this._origBroadcast = this.browser.broadcastToWebUI.bind(this.browser)
    this.browser.broadcastToWebUI = (channel, ...args) => {
      // Re-emit the IPC channel name (e.g. "oz:tabs:updated") on SSE,
      // remapped to the dot-form ("tabs.updated") for cleaner client-side filters.
      const ssChannel = channel.replace(/^oz:/, '').replace(/:/g, '.')
      this._broadcastSse(ssChannel, args.length === 1 ? args[0] : args)
      return this._origBroadcast(channel, ...args)
    }
  }

  _unwireBrowserEvents() {
    if (this._origBroadcast) {
      this.browser.broadcastToWebUI = this._origBroadcast
      this._origBroadcast = null
    }
  }
}

function channelMatches(filters, channel) {
  for (const f of filters) {
    if (f === channel) return true
    if (f.endsWith('.*') && channel.startsWith(f.slice(0, -1))) return true
    if (f === '*') return true
  }
  return false
}

function withCode(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

module.exports = { MCPServer }
