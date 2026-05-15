// OZ Browser — Proxy Diagnostics + Alerts engine (H-2e, v1.1.3).
//
// Doc: docs/modules/proxy-diagnostics.md
//
// Qué hace:
//   Corre health checks pasivos sobre el estado actual del subsystem proxies
//   y dispara alertas cuando detecta condiciones que el usuario debería
//   accionar. Es un engine "compute-only" — no muta el state del proxyManager,
//   solo lee. Las alertas se persisten in-memory + se rebotan al AlertManager
//   (panel) y al OS via el callback `notify` opcional.
//
// Triggers (4 condiciones):
//
//   1. proxy-disabled
//      Un proxy quedó disabled (failureCount >= 3 ya disparado por daemon,
//      o flag isDisabled manual). Severity=urgent. El plumbing existing en
//      proxy-health-notify ya cubre el momento del transition; este check
//      lo re-emite si sigue disabled y nadie lo accionó (>1h).
//
//   2. identity-unassigned (leak risk)
//      Una identity non-default no tiene proxy resuelto. El bug original
//      que motivó todo el bloque H-2 (Contexto IG con IP real). Severity=urgent.
//
//   3. proxy-stale
//      Un proxy lleva >24h sin test. No es leak directo pero el status que
//      ve el usuario es viejo. Severity=warning.
//
//   4. latency-spike
//      Las últimas 2 medidas de un proxy son >2000ms. Sticky session lenta
//      por degradación, o el upstream Oxylabs cae. Severity=warning.
//
// Dedup: cada alert tiene una key estable (kind + targetId). Re-emit del
// mismo (kind,targetId) dentro de la ventana de dedup NO se vuelve a postear.
// Ventana default: 6h para urgent (proxy-disabled, identity-unassigned),
// 24h para warning (stale, latency-spike). Reset al dismiss explícito.
//
// Returns siempre objetos `{ ok, ... }` o arrays. Nunca throw.

const DEFAULT_DEDUP_URGENT_MS = 6 * 60 * 60 * 1000 // 6h
const DEFAULT_DEDUP_WARNING_MS = 24 * 60 * 60 * 1000 // 24h
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24h
const LATENCY_SPIKE_MS = 2000 // 2s

function _key(kind, targetId) {
  return `${kind}:${targetId || '_'}`
}

function buildProxyDiagnostics({
  proxyManager,
  proxyAssignment,
  identityManager,
  alertManager,
  notify, // optional fn(title, body, severity) — OS notification dispatch
  logger,
  now, // injectable for tests
  dedupUrgentMs,
  dedupWarningMs,
} = {}) {
  const _now = typeof now === 'function' ? now : () => Date.now()
  const _log = logger || { info: () => {}, warn: () => {}, debug: () => {} }
  const _dUrgent = dedupUrgentMs == null ? DEFAULT_DEDUP_URGENT_MS : dedupUrgentMs
  const _dWarning = dedupWarningMs == null ? DEFAULT_DEDUP_WARNING_MS : dedupWarningMs

  // In-memory state — alerts active + dedup timestamps.
  // alerts: Map<key, { id, kind, targetId, severity, title, message, createdAt, dismissedAt? }>
  // lastFiredAt: Map<key, ts>
  // latencyHistory: Map<proxyId, [lastLatency, prevLatency]>
  const alerts = new Map()
  const lastFiredAt = new Map()
  const latencyHistory = new Map()

  function _shouldFire(key, severity) {
    const last = lastFiredAt.get(key)
    if (!last) return true
    const window = severity === 'urgent' ? _dUrgent : _dWarning
    return _now() - last >= window
  }

  function _addAlert(kind, targetId, severity, title, message, extra) {
    const key = _key(kind, targetId)
    if (!_shouldFire(key, severity)) return null
    const id = `${kind}_${targetId || 'global'}_${_now().toString(36)}`
    const alert = {
      id,
      kind,
      targetId: targetId || null,
      severity,
      title,
      message,
      createdAt: _now(),
      ...extra,
    }
    alerts.set(key, alert)
    lastFiredAt.set(key, _now())
    // Forward to AlertManager (in-app panel) if available.
    if (alertManager && typeof alertManager.add === 'function') {
      try {
        alertManager.add({
          type: kind,
          severity,
          title,
          message,
          action:
            kind === 'identity-unassigned'
              ? { kind: 'open-dashboard' }
              : { kind: 'open-modal', payload: { modal: 'proxyManager' } },
        })
      } catch (err) {
        _log.warn('proxy-diagnostics', 'alertManager.add failed', {
          message: err.message,
        })
      }
    }
    // OS notification dispatch (off-by-default in settings handled by caller).
    if (typeof notify === 'function') {
      try {
        notify(title, message, severity)
      } catch (err) {
        _log.warn('proxy-diagnostics', 'notify dispatch failed', {
          message: err.message,
        })
      }
    }
    _log.info('proxy-diagnostics', 'alert fired', { kind, targetId, severity })
    return alert
  }

  function _checkProxyDisabled() {
    if (!proxyManager || typeof proxyManager.list !== 'function') return
    const proxies = proxyManager.list()
    for (const p of proxies) {
      if (!p.isDisabled) continue
      _addAlert(
        'proxy-disabled',
        p.id,
        'urgent',
        `Proxy disabled: ${p.name || p.host}`,
        `Proxy ${p.name || `${p.host}:${p.port}`} is disabled and not serving traffic. Identities assigned to it are using fallback (real IP if no other proxy resolves).`,
        { proxyName: p.name, proxyHost: p.host, proxyPort: p.port },
      )
    }
  }

  function _checkIdentitiesUnassigned() {
    if (!identityManager || typeof identityManager.list !== 'function') return
    if (!proxyAssignment || typeof proxyAssignment.resolve !== 'function') return
    const idents = identityManager.list()
    for (const i of idents) {
      if (i.isDefault) continue
      let resolved = null
      try {
        resolved = proxyAssignment.resolve({
          identityId: i.id,
          workspaceId: i.workspaceId,
        })
      } catch (_e) {
        resolved = null
      }
      if (resolved) continue
      _addAlert(
        'identity-unassigned',
        i.id,
        'urgent',
        `Leak risk: ${i.name}`,
        `Identity "${i.name}" has no proxy assigned. Browsing under this identity is using the real IP. Reassign a proxy from the dashboard or proxy manager.`,
        { identityName: i.name, workspaceId: i.workspaceId },
      )
    }
  }

  function _checkProxyStale() {
    if (!proxyManager || typeof proxyManager.list !== 'function') return
    const proxies = proxyManager.list()
    const cutoff = _now() - STALE_THRESHOLD_MS
    for (const p of proxies) {
      if (p.isDisabled) continue // already covered by proxy-disabled
      if (!p.lastTestedAt) {
        // never tested counts as stale
        _addAlert(
          'proxy-stale',
          p.id,
          'warning',
          `Proxy never tested: ${p.name || p.host}`,
          `Proxy ${p.name || `${p.host}:${p.port}`} has never been tested. Click "Test" in the dashboard to verify it works.`,
          { proxyName: p.name },
        )
        continue
      }
      if (p.lastTestedAt < cutoff) {
        _addAlert(
          'proxy-stale',
          p.id,
          'warning',
          `Proxy stale: ${p.name || p.host}`,
          `Proxy ${p.name || `${p.host}:${p.port}`} has not been tested in over 24h. Status shown may be outdated.`,
          { proxyName: p.name, lastTestedAt: p.lastTestedAt },
        )
      }
    }
  }

  function _trackLatency() {
    // Called from _checkLatencySpike — pulls latest latency from proxyManager
    // and updates the rolling 2-point history.
    if (!proxyManager || typeof proxyManager.list !== 'function') return
    const proxies = proxyManager.list()
    for (const p of proxies) {
      if (p.isDisabled) continue
      if (p.lastLatencyMs == null) continue
      const hist = latencyHistory.get(p.id) || []
      // Only record if the lastTestedAt changed (avoid stuffing same value).
      // We use lastTestedAt as the freshness key.
      const last = hist[0]
      if (last && last.testedAt === p.lastTestedAt) continue
      const entry = { latency: p.lastLatencyMs, testedAt: p.lastTestedAt }
      latencyHistory.set(p.id, [entry, hist[0] || null].filter(Boolean))
    }
  }

  function _checkLatencySpike() {
    _trackLatency()
    if (!proxyManager || typeof proxyManager.list !== 'function') return
    const proxies = proxyManager.list()
    for (const p of proxies) {
      if (p.isDisabled) continue
      const hist = latencyHistory.get(p.id) || []
      if (hist.length < 2) continue
      const both =
        hist[0].latency > LATENCY_SPIKE_MS && hist[1].latency > LATENCY_SPIKE_MS
      if (!both) continue
      _addAlert(
        'latency-spike',
        p.id,
        'warning',
        `Latency spike: ${p.name || p.host}`,
        `Proxy ${p.name || `${p.host}:${p.port}`} returned high latency (${Math.round(hist[0].latency)}ms then ${Math.round(hist[1].latency)}ms). The sticky session may be expiring or the upstream is degraded — try Rotate sticky or Reset.`,
        { proxyName: p.name, latencies: [hist[0].latency, hist[1].latency] },
      )
    }
  }

  function scan() {
    _checkProxyDisabled()
    _checkIdentitiesUnassigned()
    _checkProxyStale()
    _checkLatencySpike()
    return { ok: true, count: alerts.size }
  }

  function getAlerts() {
    // Return active (non-dismissed) alerts, newest first.
    const list = []
    for (const a of alerts.values()) {
      if (a.dismissedAt) continue
      list.push(a)
    }
    list.sort((a, b) => b.createdAt - a.createdAt)
    return list
  }

  function dismissAlert(alertId) {
    if (!alertId) return { ok: false, reason: 'NO_ID' }
    for (const [key, a] of alerts.entries()) {
      if (a.id !== alertId) continue
      a.dismissedAt = _now()
      // Reset dedup timer so a NEW occurrence of the same condition fires
      // again immediately (user has signaled they want a fresh notification
      // if it happens again).
      lastFiredAt.delete(key)
      return { ok: true, alertId }
    }
    return { ok: false, reason: 'NOT_FOUND' }
  }

  function dismissAll() {
    let n = 0
    for (const [key, a] of alerts.entries()) {
      if (a.dismissedAt) continue
      a.dismissedAt = _now()
      lastFiredAt.delete(key)
      n += 1
    }
    return { ok: true, dismissed: n }
  }

  // Internal accessor for tests — never expose in production UI.
  function _internalState() {
    return { alerts, lastFiredAt, latencyHistory }
  }

  return {
    scan,
    getAlerts,
    dismissAlert,
    dismissAll,
    _internalState,
  }
}

module.exports = {
  buildProxyDiagnostics,
  DEFAULT_DEDUP_URGENT_MS,
  DEFAULT_DEDUP_WARNING_MS,
  STALE_THRESHOLD_MS,
  LATENCY_SPIKE_MS,
}
