// OZ Browser — Anti-Detect Health handlers (E2-C-6).
//
// Bridge entre evaluateHealth() (lógica pura, sync) y los managers de runtime
// que tienen el state vivo (IdentityManager, ProxyAssignment, ProxyManager,
// FingerprintEngine, AntiLogout) + lectura async de cookies via
// session.cookies.get().
//
// Handler map shared by IPC + MCP. Pure adapter — delegates to managers.
// Doc: docs/modules/anti-detect-health-handlers.md

const log = require('./logger')
const { evaluateHealth, FIX_KINDS, STATUSES } = require('./anti-detect-health')
const { resolveCountry } = require('./country-locale')

function buildHealthHandlers(browser) {
  const im = () => browser.identityManager
  const pm = () => browser.proxyManager
  const pa = () => browser.proxyAssignment
  const ph = () => browser.proxyHealth
  const fe = () => browser.fingerprintEngine
  const al = () => browser.antiLogout
  const am = () => browser.alertManager

  // ------------------------------------------------------------------------
  // get(identityId) — async porque cookies son async.
  // ------------------------------------------------------------------------
  async function get(identityId) {
    if (!identityId)
      return { __error: { code: 'MISSING_ID', message: 'identityId required' } }
    const identity = im() && im().get(identityId)
    if (!identity) {
      return {
        __error: { code: 'NOT_FOUND', message: `Identity ${identityId} not found` },
      }
    }
    const proxy = pa()
      ? pa().resolve({ identityId, workspaceId: identity.workspaceId })
      : null
    const fingerprint = fe() ? fe().get(identityId) : null
    const cookies = await fetchCookiesSafe(im(), identityId)
    const record = evaluateHealth({ identity, fingerprint, proxy, cookies })
    // Decorate with display fields the UI uses.
    record.identityName = identity.name
    record.identityColor = identity.color
    return record
  }

  // ------------------------------------------------------------------------
  // list() — health record para todas las identities. Cookies se fetchean
  // en paralelo. NO incluye locked filter — la salud importa igual.
  // ------------------------------------------------------------------------
  async function list() {
    if (!im()) return []
    const identities = im().list()
    const records = await Promise.all(identities.map((i) => get(i.id)))
    return records.filter((r) => r && !r.__error)
  }

  // ------------------------------------------------------------------------
  // applyFix({identityId, vector, kind}) — ejecuta una de las acciones
  // inline definidas en FIX_KINDS. Retorna { ok, message?, result? }.
  //
  // La UI ya sabe qué fix aplica para qué vector (vino en record.vectors[v].fix);
  // exponemos el kind como dispatcher para mantener bajo coupling.
  // ------------------------------------------------------------------------
  async function applyFix({ identityId, kind, vector } = {}) {
    if (!identityId || !kind) {
      return { ok: false, reason: 'identityId-and-kind-required' }
    }
    const identity = im() && im().get(identityId)
    if (!identity) return { ok: false, reason: 'identity-not-found' }

    log.info('anti-detect-health', 'applyFix called', { identityId, kind, vector })

    switch (kind) {
      case FIX_KINDS.REROLL_FP:
        return rerollFingerprint(identityId)
      case FIX_KINDS.APPLY_GEO:
        return applyGeoFromProxy(identity)
      case FIX_KINDS.REASSIGN_PROXY:
        return reassignProxy(identityId)
      case FIX_KINDS.TEST_PROXY:
        return testProxyForIdentity(identity)
      case FIX_KINDS.MARK_RELOGIN:
        return markCookiesForRelogin(identity)
      default:
        return { ok: false, reason: 'unknown-fix-kind', kind }
    }
  }

  function rerollFingerprint(identityId) {
    if (!fe()) return { ok: false, reason: 'no-fingerprint-engine' }
    const fp = fe().regenerate(identityId)
    notifyChanged(identityId, 'fingerprint regenerated')
    return {
      ok: true,
      kind: FIX_KINDS.REROLL_FP,
      result: { blueprintId: fp.blueprintId },
    }
  }

  function applyGeoFromProxy(identity) {
    if (!fe()) return { ok: false, reason: 'no-fingerprint-engine' }
    const proxy = pa()
      ? pa().resolve({ identityId: identity.id, workspaceId: identity.workspaceId })
      : null
    if (!proxy) return { ok: false, reason: 'no-proxy-assigned' }
    if (!proxy.country) return { ok: false, reason: 'proxy-has-no-country' }
    const suggestion = resolveCountry(proxy.country)
    if (!suggestion) {
      return { ok: false, reason: 'unknown-country', country: proxy.country }
    }
    // Ensure the FP exists before mutating (engine.applyGeoSuggestion needs it).
    fe().getOrCreate(identity.id, identity.fingerprintSeed)
    const updated = fe().applyGeoSuggestion(identity.id, suggestion)
    notifyChanged(identity.id, 'fingerprint geo applied')
    return {
      ok: true,
      kind: FIX_KINDS.APPLY_GEO,
      result: {
        timezone: updated.timezone,
        locale: updated.locale,
        country: proxy.country,
      },
    }
  }

  function reassignProxy(identityId) {
    if (!pa() || !pm()) return { ok: false, reason: 'no-proxy-system' }
    // Switch this identity to auto-random — picks a different healthy proxy.
    pa().assignToIdentity(identityId, 'auto-random')
    const newProxy = pa().resolve({ identityId })
    notifyChanged(identityId, 'proxy reassigned')
    return {
      ok: true,
      kind: FIX_KINDS.REASSIGN_PROXY,
      result: {
        newProxyId: newProxy && newProxy.id,
        newProxyName: newProxy && newProxy.name,
      },
    }
  }

  async function testProxyForIdentity(identity) {
    if (!ph() || !pa()) return { ok: false, reason: 'no-proxy-health' }
    const proxy = pa().resolve({
      identityId: identity.id,
      workspaceId: identity.workspaceId,
    })
    if (!proxy) return { ok: false, reason: 'no-proxy-assigned' }
    const result = await ph().testOne(proxy.id)
    notifyChanged(identity.id, 'proxy tested')
    return { ok: true, kind: FIX_KINDS.TEST_PROXY, result }
  }

  function markCookiesForRelogin(identity) {
    if (!al()) return { ok: false, reason: 'no-anti-logout' }
    // AntiLogout.flagAllForRelogin(identityId) hace el work si existe.
    // Fallback: emitir alert sin mutar (la lógica de "borrar cookies expiradas"
    // es delicada, mejor delegar a anti-logout o dejarlo informativo).
    const flagged =
      typeof al().flagAllForRelogin === 'function'
        ? al().flagAllForRelogin(identity.id)
        : null
    if (am()) {
      am().add({
        type: 'health-check',
        severity: 'info',
        title: `Cookies flagged on ${identity.name}`,
        message: 'Persistent cookies marked stale; review accounts on next login.',
        identityId: identity.id,
      })
    }
    notifyChanged(identity.id, 'cookies marked for relogin')
    return { ok: true, kind: FIX_KINDS.MARK_RELOGIN, result: { flagged } }
  }

  function notifyChanged(identityId, reason) {
    if (browser && typeof browser.broadcastToWebUI === 'function') {
      browser.broadcastToWebUI('oz:health:changed', { identityId, reason })
    }
  }

  return { get, list, applyFix }
}

// ----------------------------------------------------------------------------
// Cookies fetch — wrapped in try/catch + timeout so a single broken session
// doesn't tank the whole list() call.
// ----------------------------------------------------------------------------

async function fetchCookiesSafe(identityManager, identityId) {
  try {
    if (!identityManager || typeof identityManager.getSession !== 'function') return null
    const session = identityManager.getSession(identityId)
    if (!session || !session.cookies || typeof session.cookies.get !== 'function') {
      return null
    }
    // Empty filter = all cookies for this session. Wrapped in a 2s timeout
    // because in pathological cases (huge cookie store) get() can stall the
    // event loop briefly; we'd rather degrade to "unknown" than freeze the UI.
    return await Promise.race([
      session.cookies.get({}),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ])
  } catch (err) {
    log.warn('anti-detect-health-handlers', 'fetchCookiesSafe failed', {
      identityId,
      message: err.message,
    })
    return null
  }
}

module.exports = { buildHealthHandlers, STATUSES, FIX_KINDS }
