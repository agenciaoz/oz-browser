// OZ Browser — Leak tests handlers (H-2j, v1.1.4).
//
// Runtime bridge entre la lógica pura de leak-tests.js y Electron:
//   - WebRTC: spawnea un hidden BrowserWindow con la partition de la
//     identity (persist:identity-<id>), navega a una data: URI con un
//     gatherer de RTCIceCandidates, ejecuta JS para extraer candidates
//     después de 4s, cierra el window. Pasa el resultado a
//     analyzeWebRtcCandidates().
//   - DNS / IP: hace net.request al endpoint https://ipleak.net/json/
//     usando la session de la identity. Pasa el JSON a analyzeDnsLeak().
//
// Resultado cacheado in-memory en _leakTestCache: Map<identityId, record>.
// El cache es por proceso (no persistido) — los tests son rápidos enough
// que ejecutarlos on-demand desde el dashboard es OK, y cachearlos a disk
// agregaría complexity + concerns de privacidad sin valor.
//
// Doc: docs/modules/leak-tests-handlers.md
// ADRs: 0005 (modular 500 LOC), 0017 (proxy model).

const { BrowserWindow, net, session } = require('electron')
const log = require('./logger')
const {
  analyzeWebRtcCandidates,
  analyzeDnsLeak,
  combineLeakResults,
  parseRtcCandidate,
  STATUSES,
  LEAK_REASONS,
} = require('./leak-tests')

// Tunables — kept here so tests/operators can override.
const WEBRTC_GATHER_TIMEOUT_MS = 4500
const IPLEAK_TIMEOUT_MS = 6000
const IPLEAK_URL = 'https://ipleak.net/json/'
const STUN_URL = 'stun:stun.l.google.com:19302'

function buildLeakTestHandlers(browser) {
  // Per-browser cache so re-instantiation (tests) doesn't bleed.
  if (!browser._leakTestCache) browser._leakTestCache = new Map()
  const cache = browser._leakTestCache

  const im = () => browser.identityManager
  const pa = () => browser.proxyAssignment

  // ------------------------------------------------------------------------
  // get(identityId) — returns cached record or null. UI uses this to render
  // last-known result without re-running tests.
  // ------------------------------------------------------------------------
  function get(identityId) {
    if (!identityId) return null
    return cache.get(identityId) || null
  }

  // ------------------------------------------------------------------------
  // clear(identityId) — drops cache entry. Used by UI "Clear results".
  // ------------------------------------------------------------------------
  function clear(identityId) {
    if (!identityId) {
      cache.clear()
      broadcastChanged(null)
      return { ok: true, cleared: 'all' }
    }
    const had = cache.delete(identityId)
    broadcastChanged(identityId)
    return { ok: true, cleared: had ? identityId : 'none' }
  }

  // ------------------------------------------------------------------------
  // run({identityId}) — orchestrates WebRTC + DNS in parallel, caches
  // result, broadcasts change, returns the leak record.
  // ------------------------------------------------------------------------
  async function run({ identityId } = {}) {
    if (!identityId) {
      return { __error: { code: 'MISSING_ID', message: 'identityId required' } }
    }
    if (!im()) {
      return {
        __error: {
          code: 'NO_IDENTITY_MANAGER',
          message: 'IdentityManager not initialized',
        },
      }
    }
    const identity = im().get(identityId)
    if (!identity) {
      return {
        __error: { code: 'NOT_FOUND', message: `Identity ${identityId} not found` },
      }
    }
    const proxy = pa()
      ? pa().resolve({ identityId, workspaceId: identity.workspaceId })
      : null
    const proxyPublicIp = proxy && proxy.lastTestedIp ? proxy.lastTestedIp : null
    const proxyCountry = proxy && proxy.country ? proxy.country : null

    log.info('leak-tests', 'run start', {
      identityId,
      hasProxy: !!proxy,
      proxyPublicIp,
      proxyCountry,
    })

    // Run both in parallel — they're independent.
    const [webrtc, dns] = await Promise.all([
      runWebRtcTest({ identity, proxyPublicIp }).catch((err) => {
        log.warn('leak-tests', 'webrtc test failed', { err: err.message })
        return {
          status: STATUSES.YELLOW,
          reason: LEAK_REASONS.NO_STUN_RESPONSE,
          summary: `WebRTC test errored: ${err.message || err}`,
          candidates: [],
          srflxIps: [],
          hostIps: [],
          leakedIps: [],
        }
      }),
      runDnsTest({ identity, proxyCountry, proxyPublicIp }).catch((err) => {
        log.warn('leak-tests', 'dns test failed', { err: err.message })
        return {
          status: STATUSES.YELLOW,
          reason: LEAK_REASONS.NO_IPLEAK_RESPONSE,
          summary: `DNS test errored: ${err.message || err}`,
          detectedIp: null,
          detectedCountry: null,
          dnsServers: [],
        }
      }),
    ])

    const record = combineLeakResults({ webrtc, dns, identityId })
    record.identityName = identity.name
    record.identityColor = identity.color
    record.proxyId = proxy ? proxy.id : null
    record.proxyName = proxy ? proxy.name : null
    record.proxyCountry = proxyCountry
    record.proxyPublicIp = proxyPublicIp

    cache.set(identityId, record)
    broadcastChanged(identityId)
    log.info('leak-tests', 'run done', {
      identityId,
      overall: record.overall,
      webrtcStatus: webrtc.status,
      dnsStatus: dns.status,
    })
    return record
  }

  // ------------------------------------------------------------------------
  // list() — all cached records (no fresh re-run). UI on initial load
  // displays whatever's cached.
  // ------------------------------------------------------------------------
  function list() {
    return Array.from(cache.values())
  }

  // ------------------------------------------------------------------------
  // WebRTC ICE candidate gatherer — hidden BrowserWindow with identity
  // partition (so proxy + cookies + session match what the user actually
  // browses with).
  //
  // We load a data: URI with a tiny gather script, wait for candidates to
  // flow in for WEBRTC_GATHER_TIMEOUT_MS, then read window.OZ_CANDIDATES
  // via executeJavaScript, close the window, and pass to analyze.
  // ------------------------------------------------------------------------
  async function runWebRtcTest({ identity, proxyPublicIp }) {
    const partition = `persist:identity-${identity.id}`
    const html = buildWebRtcGatherHtml()
    const dataUri = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`

    let win
    try {
      win = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
          partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      })
      // Some Electron versions refuse data: navigation without explicit
      // file/network handling — loadURL with data: works on stock.
      await win.loadURL(dataUri)
      // Give the page a moment to register its RTCPeerConnection callbacks,
      // then poll until either we have candidates or the timeout fires.
      const candidates = await collectCandidates(win, WEBRTC_GATHER_TIMEOUT_MS)
      const parsed = candidates.map(parseRtcCandidate).filter(Boolean)
      return analyzeWebRtcCandidates({ candidates: parsed, proxyPublicIp })
    } finally {
      try {
        if (win && !win.isDestroyed()) win.close()
      } catch (_err) {
        // ignore
      }
    }
  }

  async function collectCandidates(win, timeoutMs) {
    const start = Date.now()
    let lastSeen = 0
    // Poll every 300ms — early exit when we've seen no new candidate for
    // 1s and have at least one srflx (or after timeoutMs whichever first).
    while (Date.now() - start < timeoutMs) {
      const arr = await win.webContents
        .executeJavaScript('window.OZ_CANDIDATES || []')
        .catch(() => [])
      if (Array.isArray(arr) && arr.length > 0) {
        // Found new candidates? Reset stable timer.
        if (arr.length > lastSeen) {
          lastSeen = arr.length
        }
        // Stable for 1s with at least one srflx — early exit.
        const hasSrflx = arr.some(
          (c) =>
            (c && c.type === 'srflx') ||
            /typ\s+srflx/.test(String((c && c.candidate) || '')),
        )
        if (hasSrflx && Date.now() - start > 1500) return arr
      }
      await sleep(300)
    }
    // Timed out — return whatever we have.
    const final = await win.webContents
      .executeJavaScript('window.OZ_CANDIDATES || []')
      .catch(() => [])
    return Array.isArray(final) ? final : []
  }

  // ------------------------------------------------------------------------
  // DNS / IP leak via ipleak.net — net.request goes through the same
  // session.fromPartition() as the identity, so proxy config applies.
  // ------------------------------------------------------------------------
  async function runDnsTest({ identity, proxyCountry, proxyPublicIp }) {
    const ses = session.fromPartition(`persist:identity-${identity.id}`, { cache: true })
    const json = await fetchJsonViaSession(ses, IPLEAK_URL, IPLEAK_TIMEOUT_MS)
    return analyzeDnsLeak({ ipleakJson: json, proxyCountry, proxyPublicIp })
  }

  function fetchJsonViaSession(ses, url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (val) => {
        if (settled) return
        settled = true
        resolve(val)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      try {
        const request = net.request({ url, session: ses, useSessionCookies: false })
        let body = ''
        request.on('response', (response) => {
          response.on('data', (chunk) => {
            body += chunk.toString('utf8')
          })
          response.on('end', () => {
            clearTimeout(timer)
            try {
              finish(JSON.parse(body))
            } catch (_err) {
              finish(null)
            }
          })
          response.on('error', () => {
            clearTimeout(timer)
            finish(null)
          })
        })
        request.on('error', () => {
          clearTimeout(timer)
          finish(null)
        })
        request.end()
      } catch (_err) {
        clearTimeout(timer)
        finish(null)
      }
    })
  }

  function broadcastChanged(identityId) {
    if (browser && typeof browser.broadcastToWebUI === 'function') {
      browser.broadcastToWebUI('oz:leakTest:changed', { identityId })
    }
  }

  return { run, get, list, clear }
}

// ============================================================================
// HTML gather page — minimal, no external deps.
// ============================================================================

function buildWebRtcGatherHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>oz-leak-gather</title></head>
<body>
<script>
(function () {
  window.OZ_CANDIDATES = []
  try {
    var pc = new RTCPeerConnection({iceServers: [{urls: '${STUN_URL}'}]})
    pc.createDataChannel('oz-gather')
    pc.onicecandidate = function (e) {
      if (e && e.candidate) {
        var c = e.candidate
        window.OZ_CANDIDATES.push({
          type: c.type || null,
          address: c.address || null,
          port: c.port || null,
          protocol: c.protocol || null,
          candidate: c.candidate || ''
        })
      }
    }
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o) }).catch(function () {})
  } catch (err) {
    window.OZ_CANDIDATES_ERROR = String(err && err.message || err)
  }
})()
</script>
</body></html>`
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

module.exports = { buildLeakTestHandlers, buildWebRtcGatherHtml }
