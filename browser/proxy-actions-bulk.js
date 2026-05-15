// OZ Browser — Proxy Actions Bulk wrappers (H-2f, v1.1.3).
//
// Doc: docs/modules/proxy-actions-bulk.md
//
// Envuelve las acciones single de proxy-actions.js para aplicarlas sobre N ids
// en secuencia (no Promise.all — evitamos saturar el daemon + el proxy
// upstream). Cada bulk function retorna:
//
//   { ok: true, results: [{ id, ok, ...detail }, ...], summary: { total, ok, failed } }
//
// `ok:true` a nivel top significa "ejecutamos el ciclo" — no que todos los
// items hayan funcionado. Los items individuales tienen su propio `ok`. Este
// patrón evita que un solo fallo aborte el batch.
//
// La UI envuelve `bulkDelete` en confirm() — el backend solo borra. La razón
// de no ofrecer Promise.all es doble: (a) el daemon de health hace HTTP egress
// y saturar es contraproducente, (b) los logs quedan ordenados y debuggables.

const log = require('./logger')

function buildProxyActionsBulk({ proxyActions }) {
  if (!proxyActions) throw new Error('proxyActions required')

  function _summarize(results) {
    let okCount = 0
    let failed = 0
    for (const r of results) {
      if (r && r.ok) okCount++
      else failed++
    }
    return { total: results.length, ok: okCount, failed }
  }

  async function _runSequential(ids, opName, fn) {
    const results = []
    const list = Array.isArray(ids) ? ids : []
    for (const id of list) {
      try {
        const r = await fn(id)
        results.push({ id, ...r })
      } catch (err) {
        log.warn('proxy-actions-bulk', `${opName} threw`, {
          id,
          message: err && err.message,
        })
        results.push({ id, ok: false, reason: 'THREW', message: err && err.message })
      }
    }
    const summary = _summarize(results)
    log.info('proxy-actions-bulk', `${opName} done`, {
      total: summary.total,
      ok: summary.ok,
      failed: summary.failed,
    })
    return { ok: true, results, summary }
  }

  async function bulkTestProxies(ids) {
    return _runSequential(ids, 'bulkTestProxies', (id) => proxyActions.testProxy(id))
  }

  async function bulkResetProxies(ids) {
    return _runSequential(ids, 'bulkResetProxies', (id) => proxyActions.resetProxy(id))
  }

  async function bulkSetDisabled(ids, disabled) {
    const flag = !!disabled
    return _runSequential(ids, 'bulkSetDisabled', async (id) =>
      proxyActions.setDisabled(id, flag),
    )
  }

  async function bulkDeleteProxies(ids) {
    return _runSequential(ids, 'bulkDeleteProxies', async (id) =>
      proxyActions.deleteProxy(id),
    )
  }

  async function bulkReloadSessions(identityIds) {
    return _runSequential(identityIds, 'bulkReloadSessions', (id) =>
      proxyActions.reloadSession(id),
    )
  }

  return {
    bulkTestProxies,
    bulkResetProxies,
    bulkSetDisabled,
    bulkDeleteProxies,
    bulkReloadSessions,
  }
}

module.exports = { buildProxyActionsBulk }
