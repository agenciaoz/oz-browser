// OZ Browser — Sidebar Anti-Detect Health bridge (E2-C-6).
//
// Extraído de sidebar.js para respetar ADR 0005 (≤500 LOC). Encapsula:
//   - cache per-identity de overall health status
//   - load async via window.oz.health.list()
//   - suscripción a oz:health:changed + oz:proxies:changed
//   - helper renderDot(identity, sidebar) → appends a click-to-open dot
//
// Uso desde sidebar.js:
//   if (window.OZ.SidebarHealth) {
//     window.OZ.SidebarHealth.attach(this)
//   }
//   ... in renderIdentityWrapper:
//   window.OZ.SidebarHealth.renderDotInto(row, identity)
//
// El módulo es self-contained — no muta nada del sidebar excepto vía render
// requests (sidebar.render()). Si SidebarHealth no está disponible (versión
// vieja de webui), el sidebar funciona igual sin dots (graceful degrade).

;(function () {
  if (!window.OZ) window.OZ = {}

  const cache = Object.create(null)
  let attachedSidebar = null

  function attach(sidebar) {
    attachedSidebar = sidebar
    _loadHealth()
    if (window.oz.health && typeof window.oz.health.onChanged === 'function') {
      window.oz.health.onChanged(_loadHealth)
    }
    if (window.oz.proxies && typeof window.oz.proxies.onChanged === 'function') {
      window.oz.proxies.onChanged(_loadHealth)
    }
  }

  async function _loadHealth() {
    if (!window.oz || !window.oz.health || typeof window.oz.health.list !== 'function') {
      return
    }
    try {
      const records = await window.oz.health.list()
      for (const id of Object.keys(cache)) delete cache[id]
      for (const r of records || []) {
        if (r && r.identityId) cache[r.identityId] = r.overall || 'unknown'
      }
      if (attachedSidebar && typeof attachedSidebar.render === 'function') {
        attachedSidebar.render()
      }
    } catch (err) {
      if (window.oz && window.oz.log) {
        window.oz.log.warn('webui/sidebar-health', 'list failed', err.message || err)
      }
    }
  }

  /** Get the cached overall status for an identity (defaults to 'unknown'). */
  function getStatus(identityId) {
    return cache[identityId] || 'unknown'
  }

  /**
   * Append a health dot to `parent` (an identity row element). The dot is
   * only rendered for yellow/red — green/unknown stay invisible to keep
   * the sidebar quiet.
   */
  function renderDotInto(parent, identity) {
    const status = getStatus(identity.id)
    if (status !== 'yellow' && status !== 'red') return null
    const dot = document.createElement('span')
    dot.className = `tree-health-dot tree-health-${status}`
    dot.title =
      status === 'red'
        ? 'Anti-detect health: critical — click for details'
        : 'Anti-detect health: warning — click for details'
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (
        window.OZ &&
        window.OZ.HealthCheck &&
        typeof window.OZ.HealthCheck.open === 'function'
      ) {
        window.OZ.HealthCheck.open(identity.id)
      }
    })
    parent.appendChild(dot)
    return dot
  }

  window.OZ.SidebarHealth = { attach, getStatus, renderDotInto, refresh: _loadHealth }
})()
