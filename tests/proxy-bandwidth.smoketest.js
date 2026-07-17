// OZ Browser — proxy-bandwidth smoke test (Fase 7, alpha.113).
//
//   node tests/proxy-bandwidth.smoketest.js
//
// Cubre estimateBytesFromHeaders + BandwidthAccumulator + attachBandwidthMeter
// (con una sesión fake) + proxyManager.addBandwidth. Puro (sin Electron real).

'use strict'

const assert = require('assert')

const {
  estimateBytesFromHeaders,
  BandwidthAccumulator,
  attachBandwidthMeter,
} = require('../browser/proxy-bandwidth.js')

let passed = 0
function ok(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' :: ' + detail : ''}`)
  passed++
  console.log('  ✓ ' + name)
}

console.log('proxy-bandwidth smoke test')

// ---- estimateBytesFromHeaders ----
ok(
  'encodedDataLength gana',
  estimateBytesFromHeaders({ encodedDataLength: 1234 }) === 1234,
)
ok(
  'Content-Length header (array)',
  estimateBytesFromHeaders({ responseHeaders: { 'Content-Length': ['500'] } }) === 500,
)
ok(
  'content-length case-insensitive (string)',
  estimateBytesFromHeaders({ responseHeaders: { 'content-length': '250' } }) === 250,
)
ok('sin señal → 0', estimateBytesFromHeaders({ responseHeaders: {} }) === 0)
ok('null → 0', estimateBytesFromHeaders(null) === 0)
ok(
  'encodedDataLength prioridad sobre header',
  estimateBytesFromHeaders({
    encodedDataLength: 999,
    responseHeaders: { 'Content-Length': '1' },
  }) === 999,
)

// ---- BandwidthAccumulator ----
{
  const flushed = []
  const acc = new BandwidthAccumulator({ sink: (batch) => flushed.push(batch) })
  acc.add('p1', 100)
  acc.add('p1', 50)
  acc.add('p2', 200)
  acc.add('p1', 0) // ignorado
  acc.add(null, 10) // ignorado
  acc.add('p3', -5) // ignorado
  ok('totalBytes acumula', acc.totalBytes === 350)
  ok('pendingSize = 2 (p1,p2)', acc.pendingSize() === 2)
  const batch = acc.flush()
  ok('flush devuelve el batch', batch.get('p1') === 150 && batch.get('p2') === 200)
  ok('sink recibió el batch', flushed.length === 1 && flushed[0].get('p1') === 150)
  ok('flush limpia el buffer', acc.pendingSize() === 0)
  ok('flush vacío → no llama sink', acc.flush().size === 0 && flushed.length === 1)
}

// ---- attachBandwidthMeter con sesión fake ----
{
  let onCompletedCb = null
  const fakeSession = {
    webRequest: {
      onCompleted: (cb) => {
        onCompletedCb = cb
      },
    },
  }
  const acc = new BandwidthAccumulator({ sink: () => {} })
  const attached = attachBandwidthMeter({
    session: fakeSession,
    identityId: 'idA',
    resolveProxyId: () => 'proxyA',
    accumulator: acc,
  })
  ok('attach ok', attached === true)
  ok('registró onCompleted', typeof onCompletedCb === 'function')
  // Simular una respuesta con Content-Length.
  onCompletedCb({ responseHeaders: { 'Content-Length': '4096' } })
  ok('atribuyó bytes al proxy', acc.totalBytes === 4096)
  const batch = acc.flush()
  ok('bytes al proxyA', batch.get('proxyA') === 4096)
  // Respuesta sin proxy resoluble → no atribuye.
  const acc2 = new BandwidthAccumulator({ sink: () => {} })
  let cb2 = null
  attachBandwidthMeter({
    session: { webRequest: { onCompleted: (c) => (cb2 = c) } },
    identityId: 'idB',
    resolveProxyId: () => null,
    accumulator: acc2,
  })
  cb2({ responseHeaders: { 'Content-Length': '100' } })
  ok('sin proxy → no acumula', acc2.totalBytes === 0)

  ok('attach sin session → false', attachBandwidthMeter({}) === false)
}

// ---- proxyManager.addBandwidth ----
{
  const Module = require('module')
  const origLoad = Module._load
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bw-'))
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') {
      return {
        app: {
          getPath: () => tmp,
          getName: () => 'test',
          getVersion: () => 'test',
          on() {},
        },
      }
    }
    return origLoad.call(this, req, parent, ...rest)
  }
  delete require.cache[require.resolve('../browser/proxy-manager.js')]
  const { ProxyManager } = require('../browser/proxy-manager.js')
  const pm = new ProxyManager()
  const p = pm.create({ name: 'A', host: 'a.com', port: 80 })
  ok('bandwidth arranca en 0', p.bandwidthBytesUsed === 0)
  ok('addBandwidth suma', pm.addBandwidth(p.id, 1000) === 1000)
  ok('addBandwidth acumula', pm.addBandwidth(p.id, 500) === 1500)
  ok('addBandwidth ignora <=0', pm.addBandwidth(p.id, 0) === 1500)
  ok('addBandwidth id desconocido → null', pm.addBandwidth('nope', 100) === null)
  ok('persistió en get()', pm.get(p.id).bandwidthBytesUsed === 1500)
  Module._load = origLoad
}

console.log(`\n=== ${passed} passed · 0 failed ===`)
process.exit(0)
