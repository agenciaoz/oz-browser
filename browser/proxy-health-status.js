// OZ Browser — Proxy Health global status aggregator (H-2a, v1.1.1).
//
// Doc: docs/modules/proxy-health-status.md
//
// Qué hace: a partir del estado actual del ProxyManager + ProxyAssignment,
// computa un status global agregado para el badge de toolbar:
//
//   'green'   → todos los proxies asignados pasan (ok recent, no failures)
//   'yellow'  → 1+ proxy con failures>0, never-tested, o stale (>24h sin test)
//   'red'     → 1+ proxy disabled (3 fallos consecutivos), OR identities
//              asignadas a proxy que no existe en el pool
//   'gray'    → no hay proxies en el pool, o ninguno asignado
//
// La definición es defensiva: el caso default ante incertidumbre es 'yellow'
// (no green), porque silently-OK en duda es peor UX que falso-positivo.
//
// Exports:
//   computeGlobalStatus({proxyManager, proxyAssignment, identityManager}) →
//     {status, counts: {total, ok, fail, disabled, untested, stale, unassigned},
//      lastTestedAt?, hint}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24h

function computeGlobalStatus({ proxyManager, proxyAssignment, identityManager } = {}) {
  const out = {
    status: 'gray',
    counts: {
      total: 0,
      ok: 0,
      fail: 0,
      disabled: 0,
      untested: 0,
      stale: 0,
      unassigned: 0,
      identities: 0,
      identitiesWithProxy: 0,
    },
    lastTestedAt: null,
    hint: null,
  }
  if (!proxyManager) {
    out.hint = 'Proxy subsystem not ready'
    return out
  }

  const all = typeof proxyManager.list === 'function' ? proxyManager.list() : []
  out.counts.total = all.length

  if (all.length === 0) {
    out.status = 'gray'
    out.hint = 'No proxies configured'
    return out
  }

  const now = Date.now()
  let latestTest = 0
  for (const p of all) {
    if (p.isDisabled) {
      out.counts.disabled += 1
      continue
    }
    if (!p.lastTestedAt) {
      out.counts.untested += 1
      continue
    }
    if (p.lastTestedAt > latestTest) latestTest = p.lastTestedAt
    if (now - p.lastTestedAt > STALE_THRESHOLD_MS) {
      out.counts.stale += 1
      continue
    }
    if (p.failureCount && p.failureCount > 0) {
      out.counts.fail += 1
      continue
    }
    out.counts.ok += 1
  }
  out.lastTestedAt = latestTest || null

  // Identity-level signals — detect "assigned but no proxy" leak risk.
  if (identityManager && proxyAssignment) {
    const ids = typeof identityManager.list === 'function' ? identityManager.list() : []
    out.counts.identities = ids.length
    for (const i of ids) {
      if (i.isDefault) continue
      const p = proxyAssignment.resolve({ identityId: i.id, workspaceId: i.workspaceId })
      if (p) out.counts.identitiesWithProxy += 1
      else out.counts.unassigned += 1
    }
  }

  // Status decision tree:
  // - any disabled OR any identity unassigned (non-default, identitied) → red
  // - any failures, untested, or stale → yellow
  // - everything ok and at least 1 proxy → green
  if (out.counts.disabled > 0) {
    out.status = 'red'
    out.hint = `${out.counts.disabled} proxy disabled — leak risk for assigned identities`
  } else if (out.counts.unassigned > 0 && out.counts.identities > 1) {
    // Treat unassigned identities as red because they leak real IP.
    out.status = 'red'
    out.hint = `${out.counts.unassigned} identities have no proxy — using real IP`
  } else if (out.counts.fail > 0) {
    out.status = 'yellow'
    out.hint = `${out.counts.fail} proxy with failures`
  } else if (out.counts.untested > 0 || out.counts.stale > 0) {
    out.status = 'yellow'
    out.hint = `${out.counts.untested + out.counts.stale} proxy not tested recently`
  } else if (out.counts.ok > 0) {
    out.status = 'green'
    out.hint = `${out.counts.ok} of ${out.counts.total} proxies healthy`
  } else {
    out.status = 'gray'
    out.hint = 'Status unknown'
  }
  return out
}

module.exports = { computeGlobalStatus, STALE_THRESHOLD_MS }
