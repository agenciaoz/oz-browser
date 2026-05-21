#!/usr/bin/env node
// OZ Browser — stdio↔HTTP MCP bridge.
//
// Qué hace: standalone Node script que Claude Code/Cursor/etc. spawnean.
// Lee JSON-RPC del stdin (delimitado por linebreaks), forwardea a OZ Browser
// HTTP localhost (default :9223), escribe respuestas a stdout. Hace que
// nuestro server MCP-vía-HTTP se comporte como un MCP stdio convencional.
//
// Pass-through completo: desde v1.9.3 el server HTTP ya sanitiza los nombres
// de tools (`oz.X.Y` → `oz_X_Y`) en tools/list y acepta ambos formatos en
// tools/call. El bridge no toca el payload — sólo pipea stdio↔HTTP. Ver
// ADR 0012 para la decisión de naming.
//
// Cómo configurarlo en Claude Code / Claude Desktop:
//   "mcpServers": {
//     "oz-browser": {
//       "command": "node",
//       "args": ["/Users/.../oz-browser/tools/mcp-stdio-bridge.js"],
//       "env": { "OZ_MCP_URL": "http://localhost:9223", "OZ_MCP_TOKEN": "..." }
//     }
//   }
//
// Cómo configurarlo en Cursor: idéntico, en .cursor/mcp.json.
//
// Pre-requisito: OZ Browser corriendo con OZ_MCP_ENABLED=1 npm start
// (o Settings → Automation → Enable MCP server desde v1.6.1).
//
// Doc: docs/guides/mcp-automation.md
// ADR: docs/architecture/0012-oz-mcp-server.md

const http = require('http')
const { URL } = require('url')

const URL_BASE = process.env.OZ_MCP_URL || 'http://localhost:9223'
const TOKEN = process.env.OZ_MCP_TOKEN || null
const MCP_PATH = '/mcp'

// MCP stdio framing: each message is a JSON object on its own line.
// Use a line buffer because Node's data events can split / merge.

let buffer = ''

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf-8')
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) handleLine(line)
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

function handleLine(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch (e) {
    writeError(null, -32700, 'Parse error in stdio bridge', e.message)
    return
  }

  forwardToHttp(request).then(
    (response) => {
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n')
      }
    },
    (err) => {
      writeError(
        request.id ?? null,
        -32603,
        'Bridge transport error',
        err.message || String(err),
      )
    },
  )
}

function forwardToHttp(request) {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_PATH, URL_BASE)
    const body = JSON.stringify(request)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    }
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () => {
          if (res.statusCode === 401) {
            return reject(
              new Error('OZ MCP server requires bearer token (set OZ_MCP_TOKEN env)'),
            )
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`OZ MCP server returned ${res.statusCode}: ${data}`))
          }
          // Notification (no id) → server returned null/empty body. Don't write.
          if (!data || data === 'null') return resolve(null)
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error('Bad JSON from server: ' + e.message))
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(30_000, () =>
      req.destroy(new Error('OZ MCP server request timed out (30s)')),
    )
    req.write(body)
    req.end()
  })
}

function writeError(id, code, message, data) {
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    }) + '\n',
  )
}

// Friendly stderr line on startup (won't break stdio framing — clients ignore stderr).
process.stderr.write(
  `[oz-mcp-bridge] forwarding stdio → ${URL_BASE}${MCP_PATH}` +
    (TOKEN ? ' (with bearer token)' : '') +
    ' [pass-through; server sanitizes tool names]\n',
)
