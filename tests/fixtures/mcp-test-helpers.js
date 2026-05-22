// Helpers compartidos por tests/mcp-server.smoketest.js. Extraídos a fixture
// para mantener el smoke test bajo el límite de 500 LOC (ADR 0005).

const http = require('http')

// HTTP helpers: postRpc lanza JSON-RPC contra /mcp, getJSON contra GET /...
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
          } catch (_e) {
            resolve({ status: res.statusCode, body: d })
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

module.exports = { postRpc, getJSON }
