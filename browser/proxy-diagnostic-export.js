// OZ Browser — Proxy diagnostic bundle builder + export (H-2 extras, v1.1.6).
//
// Por qué existe: cuando algo va mal con proxies (identity ve IP real, una
// alerta no se dispara, leak test miente, dashboard muestra status raro),
// queremos un snapshot exportable que el user pueda mandar a soporte (o
// adjuntar a un issue) sin tener que reproducir el bug. El bundle agrega
// el state público del subsystema proxies en un JSON serializable.
//
// Sanitización: NUNCA exportamos:
//   - proxy.password
//   - proxy.username (puede contener customer-X-... — Oxylabs/SmartProxy
//     username embed customer id, los ofuscamos a "<redacted>")
//   - cookies
//   - account vault contents
//
// Lo que SÍ va al bundle:
//   - proxies: host/port/protocol/country/city/tags/status/lastTestedAt/
//             lastLatencyMs/lastTestedIp/failureCount/isDisabled/usedByCount
//             (username/password redacted)
//   - assignments: identityId → proxyId mapping
//   - identities: id/name/workspaceId/isDefault (no fingerprintSeed, no cookies)
//   - workspaces: id/name (sólo metadata)
//   - alerts: active alerts via alertManager.list()
//   - leakTest cache: per-identity overall + reasons (sin srflxIps/dnsServers
//     full por privacy — el resumen es enough para diagnostic)
//   - meta: app version, ts, hostname, platform
//
// Doc: docs/modules/proxy-diagnostic-export.md (TBD)

const REDACTED = '<redacted>'

function buildDiagnosticBundle({
  proxyManager,
  proxyAssignment,
  identityManager,
  workspaceManager,
  alertManager,
  leakTestHandlers,
  appVersion = 'unknown',
  platform = 'unknown',
  now = () => new Date(),
} = {}) {
  const ts = now().toISOString()
  const out = {
    meta: {
      ts,
      appVersion,
      platform,
      bundleVersion: 1,
      note: 'Sanitized: usernames + passwords + cookies redacted.',
    },
    proxies: [],
    assignments: { byIdentity: {}, byWorkspace: {}, defaultStrategy: null },
    identities: [],
    workspaces: [],
    alerts: [],
    leakTests: [],
  }

  // ----- proxies -----
  if (proxyManager && typeof proxyManager.list === 'function') {
    for (const p of proxyManager.list()) {
      out.proxies.push({
        id: p.id,
        name: p.name,
        host: p.host,
        port: p.port,
        protocol: p.protocol,
        country: p.country,
        city: p.city || null,
        tags: Array.isArray(p.tags) ? p.tags.slice() : [],
        isActive: !!p.isActive,
        isDisabled: !!p.isDisabled,
        lastTestedAt: p.lastTestedAt || null,
        lastLatencyMs: p.lastLatencyMs || null,
        lastTestedIp: p.lastTestedIp || null,
        failureCount: p.failureCount || 0,
        bandwidthBytesUsed: p.bandwidthBytesUsed || 0,
        username: p.username ? REDACTED : null,
        password: p.password ? REDACTED : null,
        createdAt: p.createdAt || null,
      })
    }
  }

  // ----- assignments -----
  if (proxyAssignment && typeof proxyAssignment.getState === 'function') {
    try {
      const st = proxyAssignment.getState()
      if (st) {
        out.assignments.byIdentity = st.byIdentity || {}
        out.assignments.byWorkspace = st.byWorkspace || {}
        out.assignments.defaultStrategy = st.defaultStrategy || null
      }
    } catch (_err) {
      // fall through with empty assignments
    }
  }

  // ----- identities (metadata only) -----
  if (identityManager && typeof identityManager.list === 'function') {
    for (const i of identityManager.list()) {
      out.identities.push({
        id: i.id,
        name: i.name,
        workspaceId: i.workspaceId,
        isDefault: !!i.isDefault,
        color: i.color || null,
        createdAt: i.createdAt || null,
      })
    }
  }

  // ----- workspaces (metadata only) -----
  if (workspaceManager && typeof workspaceManager.list === 'function') {
    for (const w of workspaceManager.list()) {
      out.workspaces.push({
        id: w.id,
        name: w.name,
        isArchived: !!w.isArchived,
        isFrozen: !!w.isFrozen,
        createdAt: w.createdAt || null,
      })
    }
  }

  // ----- alerts -----
  if (alertManager && typeof alertManager.list === 'function') {
    try {
      const list = alertManager.list({ activeOnly: true })
      out.alerts = (Array.isArray(list) ? list : []).map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        title: a.title,
        message: a.message,
        createdAt: a.createdAt,
        identityId: a.identityId || null,
        proxyId: a.proxyId || null,
      }))
    } catch (_err) {
      // fall through
    }
  }

  // ----- leak tests (overall + reason only) -----
  if (leakTestHandlers && typeof leakTestHandlers.list === 'function') {
    try {
      const list = leakTestHandlers.list()
      out.leakTests = (Array.isArray(list) ? list : []).map((r) => ({
        identityId: r.identityId,
        identityName: r.identityName,
        overall: r.overall,
        evaluatedAt: r.evaluatedAt,
        webrtcStatus: r.webrtc && r.webrtc.status,
        webrtcReason: r.webrtc && r.webrtc.reason,
        dnsStatus: r.dns && r.dns.status,
        dnsReason: r.dns && r.dns.reason,
        proxyCountry: r.proxyCountry || null,
      }))
    } catch (_err) {
      // fall through
    }
  }

  return out
}

module.exports = { buildDiagnosticBundle, REDACTED }
