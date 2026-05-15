// OZ Browser — Proxy Bulk Assign 1:1 (H-2h, v1.1.3).
//
// Doc: docs/modules/proxy-bulk-assign.md
//
// SOLO 1:1 mapping (decisión Jose 2026-05-15). Si N proxies != M identities
// el warning lo emite el preview y la UI ofrece resolver — backend nunca hace
// round-robin ni random. Si user persiste con N!=M, las primeras min(N,M)
// se aparean en orden y el resto sobra.
//
// previewPairing(proxyIds, identityIds) → { pairings, leftoverProxies,
//   leftoverIdentities, warning|null }
// executePairing(pairings) → ejecuta proxyAssignment.assignToIdentity +
//   best-effort proxyActions.reloadSession en cascade.

const log = require('./logger')

function buildProxyBulkAssign({ proxyManager, proxyAssignment, proxyActions }) {
  if (!proxyManager) throw new Error('proxyManager required')
  if (!proxyAssignment) throw new Error('proxyAssignment required')

  function _resolveProxyName(id) {
    if (proxyManager && typeof proxyManager.get === 'function') {
      const p = proxyManager.get(id)
      if (p) return p.name || `${p.host}:${p.port}`
    }
    return id
  }

  function previewPairing(proxyIds, identityIds, opts = {}) {
    const ps = Array.isArray(proxyIds) ? proxyIds.slice() : []
    const is = Array.isArray(identityIds) ? identityIds.slice() : []
    const identityNamesById = (opts && opts.identityNamesById) || {}
    const n = ps.length
    const m = is.length
    const k = Math.min(n, m)
    const pairings = []
    for (let i = 0; i < k; i++) {
      pairings.push({
        proxyId: ps[i],
        identityId: is[i],
        proxyName: _resolveProxyName(ps[i]),
        identityName: identityNamesById[is[i]] || is[i],
      })
    }
    const leftoverProxies = ps.slice(k)
    const leftoverIdentities = is.slice(k)
    let warning = null
    if (n !== m) {
      warning = `${n} proxies vs ${m} identities — only the first ${k} will be paired.`
    }
    return {
      ok: true,
      pairings,
      leftoverProxies,
      leftoverIdentities,
      warning,
      counts: { proxies: n, identities: m, paired: k },
    }
  }

  async function executePairing(pairings) {
    const results = []
    const list = Array.isArray(pairings) ? pairings : []
    for (const pair of list) {
      const { identityId, proxyId } = pair || {}
      if (!identityId || !proxyId) {
        results.push({
          ok: false,
          identityId,
          proxyId,
          reason: 'BAD_PAIR',
        })
        continue
      }
      let assignOk = true
      try {
        proxyAssignment.assignToIdentity(identityId, proxyId)
      } catch (err) {
        assignOk = false
        results.push({
          ok: false,
          identityId,
          proxyId,
          reason: 'ASSIGN_FAILED',
          message: err && err.message,
        })
        continue
      }
      // Best-effort cascade reloadSession — assignment is the source of truth,
      // session reload is a UX nicety. If it fails we still report ok:true
      // (the assignment landed) but log the sessionReload sub-result.
      let sessionReload = null
      if (proxyActions && typeof proxyActions.reloadSession === 'function') {
        try {
          sessionReload = await proxyActions.reloadSession(identityId)
        } catch (err) {
          sessionReload = { ok: false, reason: 'THREW', message: err && err.message }
        }
      }
      results.push({
        ok: assignOk,
        identityId,
        proxyId,
        sessionReload,
      })
    }
    let okCount = 0
    let failed = 0
    for (const r of results) {
      if (r.ok) okCount++
      else failed++
    }
    log.info('proxy-bulk-assign', 'executePairing done', {
      total: results.length,
      ok: okCount,
      failed,
    })
    return {
      ok: failed === 0,
      results,
      summary: { total: results.length, ok: okCount, failed },
    }
  }

  return {
    previewPairing,
    executePairing,
  }
}

module.exports = { buildProxyBulkAssign }
