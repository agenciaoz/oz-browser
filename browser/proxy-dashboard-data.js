// OZ Browser — Proxy Dashboard data aggregator (H-2b, v1.1.1).
//
// Doc: docs/modules/proxy-dashboard-data.md
//
// Wirea ProxyManager + ProxyAssignment + IdentityManager + WorkspaceManager
// y devuelve un snapshot consumible por el dashboard tab. Read-only — no
// muta nada. Las acciones (test/reset/edit/disable) llegan en H-2c.

const { computeGlobalStatus } = require('./proxy-health-status')

function getDashboardData({
  proxyManager,
  proxyAssignment,
  identityManager,
  workspaceManager,
} = {}) {
  const out = {
    globalStatus: computeGlobalStatus({
      proxyManager,
      proxyAssignment,
      identityManager,
    }),
    identities: [],
    proxies: [],
    capturedAt: new Date().toISOString(),
  }
  if (!proxyManager) return out

  const wsById = new Map()
  if (workspaceManager && typeof workspaceManager.list === 'function') {
    for (const w of workspaceManager.list()) wsById.set(w.id, w)
  }
  const allProxies = proxyManager.list()

  // Per-identity rows — what each identity is resolving to right now.
  const usageCounter = new Map() // proxyId → [identityId,...]
  const identitiesList =
    identityManager && typeof identityManager.list === 'function'
      ? identityManager.list()
      : []
  for (const i of identitiesList) {
    let resolved = null
    if (proxyAssignment && typeof proxyAssignment.resolve === 'function') {
      try {
        resolved = proxyAssignment.resolve({
          identityId: i.id,
          workspaceId: i.workspaceId,
        })
      } catch (_err) {
        resolved = null
      }
    }
    if (resolved) {
      if (!usageCounter.has(resolved.id)) usageCounter.set(resolved.id, [])
      usageCounter.get(resolved.id).push({ id: i.id, name: i.name })
    }
    const ws = wsById.get(i.workspaceId)
    out.identities.push({
      id: i.id,
      name: i.name,
      isDefault: !!i.isDefault,
      workspaceId: i.workspaceId,
      workspaceName: ws ? ws.name : i.workspaceId,
      proxy: resolved
        ? {
            id: resolved.id,
            name: resolved.name,
            host: resolved.host,
            port: resolved.port,
            country: resolved.country,
            protocol: resolved.protocol,
          }
        : null,
      // Risk: non-default identity with no proxy resolved = leak risk.
      leakRisk: !i.isDefault && !resolved,
    })
  }

  // Per-proxy rows — pool view + who uses each.
  for (const p of allProxies) {
    const usedBy = usageCounter.get(p.id) || []
    out.proxies.push({
      id: p.id,
      name: p.name,
      label: p.label,
      host: p.host,
      port: p.port,
      protocol: p.protocol,
      country: p.country,
      tags: p.tags || [],
      isActive: !!p.isActive,
      isDisabled: !!p.isDisabled,
      lastTestedAt: p.lastTestedAt || null,
      lastLatencyMs: p.lastLatencyMs || null,
      lastTestedIp: p.lastTestedIp || null,
      failureCount: p.failureCount || 0,
      bandwidthBytesUsed: p.bandwidthBytesUsed || 0,
      createdAt: p.createdAt || null,
      usedByCount: usedBy.length,
      usedBy: usedBy.slice(0, 20), // cap preview
      // Convenience status per row: red disabled, yellow if failures/stale/untested, green otherwise
      status: _proxyStatus(p),
    })
  }

  return out
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000

function _proxyStatus(p) {
  if (p.isDisabled) return 'red'
  if (!p.lastTestedAt) return 'yellow'
  if (Date.now() - p.lastTestedAt > STALE_THRESHOLD_MS) return 'yellow'
  if (p.failureCount && p.failureCount > 0) return 'yellow'
  return 'green'
}

module.exports = { getDashboardData }
