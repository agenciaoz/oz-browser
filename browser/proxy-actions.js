// OZ Browser — Proxy Actions (H-2c + H-2d, v1.1.2).
//
// Doc: docs/modules/proxy-actions.md
//
// Operaciones del dashboard sobre el pool de proxies + asignaciones:
//
//   Per-proxy:
//     - testProxy(id)              dispara testOne via proxyHealth
//     - resetProxy(id)             failureCount=0, isDisabled=false, re-test
//     - setDisabled(id, disabled)  toggle manual
//     - rotateSticky(id)           regex sessid-XXX en username → nuevo random
//     - deleteProxy(id)            remove del pool + cleanup assignments
//
//   Per-identity:
//     - reloadSession(identityId)  re-aplica proxy actual sobre la session
//                                  cacheada. THE fix para el bug del Contexto IG
//                                  (session creada antes de tener proxy → quedó
//                                  con direct://, este path la re-resuelve).
//     - reassignProxy(identityId, value)   value = proxyId | 'auto-random' |
//                                          'auto-round-robin' | null. Update
//                                          assignment + reloadSession en cascade.
//
// Todos retornan { ok: bool, ...detail } y nunca throw — los errores los
// transforman en ok:false + reason.

const log = require('./logger')

function _normalizeSessidInUsername(username) {
  if (!username || typeof username !== 'string') return username
  // Oxylabs format: ...-sessid-XXX-... → reemplazar XXX por nuevo random
  const m = username.match(/-sessid-([^-]+)/)
  if (!m) return null // no sticky session marker — nothing to rotate
  const newSess = Math.floor(Math.random() * 1e8)
    .toString(36)
    .slice(0, 8)
  return username.replace(/-sessid-[^-]+/, `-sessid-${newSess}`)
}

function buildProxyActions({
  proxyManager,
  proxyAssignment,
  proxyHealth,
  identityManager,
  toProxyRulesString,
}) {
  if (!proxyManager) throw new Error('proxyManager required')

  async function testProxy(proxyId) {
    if (!proxyHealth || typeof proxyHealth.testOne !== 'function') {
      return { ok: false, reason: 'NO_HEALTH_DAEMON' }
    }
    try {
      const r = await proxyHealth.testOne(proxyId)
      return { ok: true, result: r }
    } catch (err) {
      return { ok: false, reason: 'TEST_FAILED', message: err.message }
    }
  }

  async function resetProxy(proxyId) {
    const p = proxyManager.get(proxyId)
    if (!p) return { ok: false, reason: 'NOT_FOUND' }
    try {
      proxyManager.update(proxyId, {
        failureCount: 0,
        isDisabled: false,
        isActive: true,
        lastTestedAt: null,
        lastLatencyMs: null,
        lastTestedIp: null,
      })
    } catch (err) {
      return { ok: false, reason: 'UPDATE_FAILED', message: err.message }
    }
    // best-effort re-test
    if (proxyHealth && typeof proxyHealth.testOne === 'function') {
      try {
        await proxyHealth.testOne(proxyId)
      } catch (_e) {
        // ignored — reset still ok even if test failed
      }
    }
    return { ok: true, proxyId }
  }

  function setDisabled(proxyId, disabled) {
    const p = proxyManager.get(proxyId)
    if (!p) return { ok: false, reason: 'NOT_FOUND' }
    try {
      proxyManager.update(proxyId, { isDisabled: !!disabled })
      return { ok: true, proxyId, isDisabled: !!disabled }
    } catch (err) {
      return { ok: false, reason: 'UPDATE_FAILED', message: err.message }
    }
  }

  function rotateSticky(proxyId) {
    const p = proxyManager.get(proxyId)
    if (!p) return { ok: false, reason: 'NOT_FOUND' }
    const newUsername = _normalizeSessidInUsername(p.username)
    if (!newUsername) {
      return {
        ok: false,
        reason: 'NOT_STICKY',
        message: 'username has no -sessid- marker',
      }
    }
    try {
      proxyManager.update(proxyId, { username: newUsername })
      log.info('proxy-actions', 'sticky rotated', {
        proxyId,
        oldUsername: p.username,
        newUsername,
      })
      return { ok: true, proxyId, newUsername }
    } catch (err) {
      return { ok: false, reason: 'UPDATE_FAILED', message: err.message }
    }
  }

  function deleteProxy(proxyId) {
    const p = proxyManager.get(proxyId)
    if (!p) return { ok: false, reason: 'NOT_FOUND' }
    try {
      if (proxyAssignment && typeof proxyAssignment.clearByProxyId === 'function') {
        proxyAssignment.clearByProxyId(proxyId)
      }
      proxyManager.remove(proxyId)
      return { ok: true, proxyId }
    } catch (err) {
      return { ok: false, reason: 'REMOVE_FAILED', message: err.message }
    }
  }

  async function reloadSession(identityId) {
    if (!identityManager) return { ok: false, reason: 'NO_IDENTITY_MGR' }
    const ident = identityManager.get(identityId)
    if (!ident) return { ok: false, reason: 'NOT_FOUND' }
    let ses
    try {
      ses = identityManager.getSession(identityId)
    } catch (err) {
      return { ok: false, reason: 'NO_SESSION', message: err.message }
    }
    if (!ses) return { ok: false, reason: 'NO_SESSION' }
    let proxy = null
    if (proxyAssignment && typeof proxyAssignment.resolve === 'function') {
      proxy = proxyAssignment.resolve({
        identityId,
        workspaceId: ident.workspaceId,
      })
    }
    const rules = proxy && toProxyRulesString ? toProxyRulesString(proxy) : 'direct://'
    try {
      await ses.setProxy({ proxyRules: rules })
      log.info('proxy-actions', 'identity session proxy re-applied', {
        identityId,
        proxyId: proxy && proxy.id,
        rules,
      })
      return { ok: true, identityId, proxyId: proxy && proxy.id, rules }
    } catch (err) {
      return { ok: false, reason: 'SET_PROXY_FAILED', message: err.message }
    }
  }

  async function reassignProxy(identityId, value) {
    if (!proxyAssignment || typeof proxyAssignment.assignToIdentity !== 'function') {
      return { ok: false, reason: 'NO_ASSIGNMENT_MGR' }
    }
    try {
      proxyAssignment.assignToIdentity(identityId, value)
    } catch (err) {
      return { ok: false, reason: 'ASSIGN_FAILED', message: err.message }
    }
    // Cascade: re-apply on the existing session immediately.
    const r = await reloadSession(identityId)
    return { ok: true, identityId, value, sessionReload: r }
  }

  return {
    testProxy,
    resetProxy,
    setDisabled,
    rotateSticky,
    deleteProxy,
    reloadSession,
    reassignProxy,
  }
}

module.exports = { buildProxyActions, _normalizeSessidInUsername }
