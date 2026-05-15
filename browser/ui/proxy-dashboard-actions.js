// OZ Browser — Proxy Dashboard single-row action handler (H-2f, v1.1.3).
//
// Extraído de proxy-dashboard.js para mantener ese archivo bajo 500 LOC
// (ADR 0005). Mismo patrón que proxy-dashboard-alerts.js. Expone
// `window.OZ_DashboardActions.performAction(act, id, el, deps)` que delega a
// `window.oz.proxyAction.*` y muestra `window.alert/confirm` apropiados.
//
// deps = { t, fetchData, renderAll, fetchAlerts, renderAlerts, alertsApi }

;(function () {
  async function performAction(act, id, el, deps) {
    const { t, fetchData, renderAll, fetchAlerts, renderAlerts, alertsApi } = deps
    const pa = window.oz && window.oz.proxyAction
    if (!pa) return
    if (el) el.disabled = true
    try {
      let r
      switch (act) {
        case 'test':
          r = await pa.test(id)
          break
        case 'reset':
          r = await pa.reset(id)
          break
        case 'disable':
          r = await pa.setDisabled(id, true)
          break
        case 'enable':
          r = await pa.setDisabled(id, false)
          break
        case 'rotate':
          r = await pa.rotateSticky(id)
          if (r && !r.ok && r.reason === 'NOT_STICKY') {
            window.alert(
              t(
                'proxyDashboard.actions.notStickyMsg',
                'This proxy does not have a sticky session marker (-sessid- in username).',
              ),
            )
          }
          break
        case 'delete': {
          const ok = window.confirm(
            t(
              'proxyDashboard.actions.deleteConfirm',
              'Delete this proxy from the pool? Identities using it will fall back to default strategy. Continue?',
            ),
          )
          if (!ok) {
            if (el) el.disabled = false
            return
          }
          r = await pa.delete(id)
          break
        }
        case 'reload':
          r = await pa.reloadSession(id)
          if (r && r.ok) {
            window.alert(
              t(
                'proxyDashboard.actions.reloadOk',
                'Session re-applied. New navigations will use the assigned proxy.',
              ) +
                (r.proxyId ? ' (proxyId=' + r.proxyId.slice(0, 8) + ')' : ' (direct://)'),
            )
          }
          break
        case 'reassign-set': {
          const raw = el && el.value
          const value = raw === '(none)' ? null : raw
          r = await pa.reassign(id, value)
          if (r && r.ok) {
            window.alert(
              t(
                'proxyDashboard.actions.reassignOk',
                'Proxy reassigned and session re-applied.',
              ),
            )
          }
          break
        }
        case 'dismiss-alert': {
          if (alertsApi) {
            r = await alertsApi.handleDismissAlert(id, {
              refresh: async () => {
                await fetchAlerts()
                renderAlerts()
              },
            })
          }
          return
        }
        default:
          return
      }
      if (r && !r.ok) {
        window.alert(
          t('proxyDashboard.actions.failed', 'Action failed') +
            ': ' +
            (r.reason || 'unknown') +
            (r.message ? ' — ' + r.message : ''),
        )
      }
    } finally {
      if (el) el.disabled = false
    }
    await fetchData(false)
    renderAll()
  }

  window.OZ_DashboardActions = { performAction }
})()
