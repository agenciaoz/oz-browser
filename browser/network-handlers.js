// OZ Browser — Network-intercept handlers (v3-A, scraping/agent-control).
//
// Per-identity request interception on the identity's Electron session:
//   - block: cancel requests whose URL matches any pattern (speed/stealth:
//     drop ads/trackers/heavy assets while scraping)
//   - capture: log matching requests (url/method/resourceType) for inspection
//
// One onBeforeRequest listener is wired per identity session, lazily, and it
// consults mutable per-identity state — so toggling block/capture never
// re-wires. Default state = passthrough (no behaviour change until used).
//
// Pure matching lives in network-utils.js. MCP catalog: mcp-tools-network.js.
// ADR: 0036 (page-control layer) · 0012 (MCP server).

'use strict'

const log = require('./logger')
const NU = require('./network-utils')

const CAPTURE_CAP = 500

function buildNetworkHandlers(browser) {
  const state = new Map() // identityId -> { block:[], captureOn, captured:[], wired }

  function getState(identityId) {
    let s = state.get(identityId)
    if (!s) {
      s = { block: [], captureOn: false, captured: [], wired: false }
      state.set(identityId, s)
    }
    return s
  }

  function err(code, message) {
    return { __error: { code, message: message || code } }
  }

  function sessionFor(identityId) {
    const im = browser.identityManager
    if (!im) return null
    try {
      return im.resolve(identityId).session
    } catch (_e) {
      return null
    }
  }

  // Wire the single onBeforeRequest listener for this identity's session once.
  function ensureWired(identityId) {
    const s = getState(identityId)
    if (s.wired) return true
    const ses = sessionFor(identityId)
    if (!ses || !ses.webRequest) return false
    ses.webRequest.onBeforeRequest((details, cb) => {
      const url = details.url
      if (s.captureOn && NU.matchesAnyPattern(url, s.capturePatterns || ['*'])) {
        s.captured.push({
          url,
          method: details.method,
          resourceType: details.resourceType,
          ts: Date.now(),
        })
        if (s.captured.length > CAPTURE_CAP) s.captured.shift()
      }
      if (s.block.length && NU.matchesAnyPattern(url, s.block)) {
        cb({ cancel: true })
        return
      }
      cb({})
    })
    s.wired = true
    log.info('network-handlers', 'wired interceptor', { identityId })
    return true
  }

  return {
    /** Set the block patterns for an identity ([] disables blocking). */
    block({ identityId, patterns }) {
      if (!identityId) return err('BAD_IDENTITY')
      const s = getState(identityId)
      s.block = NU.sanitizePatterns(patterns)
      if (!ensureWired(identityId)) return err('NO_SESSION', 'No session for identity')
      return { ok: true, patterns: s.block }
    },

    /** Toggle capture. on=true starts logging; patterns optional (default all). */
    capture({ identityId, on, patterns }) {
      if (!identityId) return err('BAD_IDENTITY')
      const s = getState(identityId)
      s.captureOn = !!on
      s.capturePatterns = NU.sanitizePatterns(patterns)
      if (s.capturePatterns.length === 0) s.capturePatterns = ['*']
      if (!ensureWired(identityId)) return err('NO_SESSION', 'No session for identity')
      return { ok: true, on: s.captureOn, patterns: s.capturePatterns }
    },

    /** Return the captured request log (most recent `limit`, default 100). */
    captured({ identityId, limit }) {
      if (!identityId) return err('BAD_IDENTITY')
      const s = getState(identityId)
      const n = Math.max(1, Math.min(Number(limit) || 100, CAPTURE_CAP))
      return { ok: true, count: s.captured.length, items: s.captured.slice(-n) }
    },

    /** Reset block + capture + log for an identity (listener stays, passthrough). */
    clear({ identityId }) {
      if (!identityId) return err('BAD_IDENTITY')
      const s = getState(identityId)
      s.block = []
      s.captureOn = false
      s.captured = []
      return { ok: true }
    },
  }
}

module.exports = { buildNetworkHandlers }
