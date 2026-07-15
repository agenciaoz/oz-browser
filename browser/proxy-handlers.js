// OZ Browser — Proxy domain handlers (1.8a).
//
// Qué hace: handler map puro consumido por IPC (oz:proxies:*) y MCP
// (oz.proxies.*). Mismo patrón que identity/workspace/tab handlers.
//
// Doc: docs/modules/proxy-handlers.md
// ADR: docs/architecture/0017-proxy-model.md
//
// Exports: buildProxyHandlers(browser) -> Record<string, fn>

const fs = require('fs')
const log = require('./logger')
const { toProxyRulesString } = require('./proxy-assignment')
const { parseCsv, encodeCsv } = require('./proxy-csv')
const { listProviders, expandProvider } = require('./proxy-providers')
const { resolveCountry } = require('./country-locale')
const { formatAcceptLanguage, shouldAutoApplyGeo } = require('./geo-match')

function buildProxyHandlers(browser) {
  const pm = () => browser.proxyManager
  const pa = () => browser.proxyAssignment

  return {
    list() {
      if (!pm()) return []
      return pm().list()
    },

    listAssignable() {
      if (!pm()) return []
      return pm().listAssignable()
    },

    get(id) {
      if (!pm()) return null
      return pm().get(id)
    },

    create(opts) {
      if (!pm()) return { __error: { code: 'NO_PROXY_MANAGER' } }
      const r = pm().create(opts || {})
      if (r && !r.__error) browser.broadcastToWebUI('oz:proxies:changed')
      return r
    },

    update(id, patch) {
      if (!pm()) return null
      const r = pm().update(id, patch || {})
      if (r) browser.broadcastToWebUI('oz:proxies:changed')
      return r
    },

    remove(id) {
      if (!pm()) return false
      const ok = pm().remove(id)
      if (ok) {
        // Cascade: clean up any assignment pointing to this proxy.
        if (pa()) pa().clearByProxyId(id)
        browser.broadcastToWebUI('oz:proxies:changed')
      }
      return ok
    },

    // -------------------- assignment (1.8b) ---------------------------------

    /**
     * Assign a proxy to an identity. value can be a proxyId, 'auto-random',
     * 'auto-round-robin', or null (clears the assignment so the resolver
     * falls back to workspace/default).
     *
     * Returns { ok, geoSuggestion? }. If the resolved proxy has a `country`
     * known to the country-locale table, geoSuggestion contains the
     * timezone/languages/locale that the caller can apply via
     * fingerprintHandlers.applyGeoSuggestion(identityId, geoSuggestion). The
     * UI typically surfaces this as a "Apply locale to identity?" dialog.
     */
    assignToIdentity(identityId, value) {
      if (!pa()) return { ok: false, reason: 'no-proxy-assignment' }
      const ok = pa().assignToIdentity(identityId, value)
      if (!ok) return { ok: false, reason: 'assign-failed' }
      applyAssignmentsToIdentity(browser, identityId)
      browser.broadcastToWebUI('oz:proxies:changed')

      // Look up resolved proxy to surface geoSuggestion (1.9d).
      const resolved = pa().resolve({ identityId })
      let geoSuggestion = null
      if (resolved && resolved.country) {
        geoSuggestion = resolveCountry(resolved.country)
      }
      // V3-C: auto-match the identity's geo (timezone + languages + locale) to
      // the proxy's country, unless the user set a manual override. Off via
      // settings.privacy.autoMatchGeo = false.
      const geoApplied = maybeAutoMatchGeo(browser, identityId, geoSuggestion)
      log.info('proxy-handlers', 'assignToIdentity ok', {
        identityId,
        value,
        proxyId: resolved && resolved.id,
        geoSuggestion: geoSuggestion && geoSuggestion.country,
        geoApplied,
      })
      return { ok: true, identityId, value, geoSuggestion, geoApplied }
    },

    /**
     * Assign a proxy to a workspace. Same value semantics + returns
     * geoSuggestion if the resolved proxy has a known country (1.9d).
     */
    assignToWorkspace(workspaceId, value) {
      if (!pa()) return { ok: false, reason: 'no-proxy-assignment' }
      const ok = pa().assignToWorkspace(workspaceId, value)
      if (!ok) return { ok: false, reason: 'assign-failed' }
      // Apply to every window currently on this workspace.
      for (const win of browser.windows || []) {
        if (win.workspaceId === workspaceId) {
          const focused = win.tabs && win.tabs.selected
          if (focused) applyAssignmentsToIdentity(browser, focused.identityId)
        }
      }
      browser.broadcastToWebUI('oz:proxies:changed')

      const resolved = pa().resolve({ workspaceId })
      let geoSuggestion = null
      if (resolved && resolved.country) {
        geoSuggestion = resolveCountry(resolved.country)
      }
      return { ok: true, workspaceId, value, geoSuggestion }
    },

    setDefaultStrategy(strategy) {
      if (!pa()) return false
      const ok = pa().setDefaultStrategy(strategy)
      if (ok) browser.broadcastToWebUI('oz:proxies:changed')
      return ok
    },

    /** Snapshot of all current bindings (for UI / MCP inspection). */
    listAssignments() {
      if (!pa()) return null
      return pa().snapshot()
    },

    /**
     * Resolve which proxy the given identity (and optionally workspace)
     * would use right now. Returns the concrete proxy object or null.
     */
    resolveForIdentity(identityId, workspaceId) {
      if (!pa()) return null
      return pa().resolve({ identityId, workspaceId })
    },

    // -------------------- health (1.8c) -------------------------------------

    /** Test a single proxy. Returns {ok, latencyMs, reason?, autoDisabled?}. */
    async testConnectivity(proxyId) {
      if (!browser.proxyHealth) return { ok: false, reason: 'no-proxy-health' }
      const r = await browser.proxyHealth.testOne(proxyId)
      browser.broadcastToWebUI('oz:proxies:changed')
      return r
    },

    /** Test all assignable proxies in parallel. Returns array of results. */
    async testAll(opts) {
      if (!browser.proxyHealth) return []
      const r = await browser.proxyHealth.testAll(opts)
      browser.broadcastToWebUI('oz:proxies:changed')
      return r
    },

    // -------------------- CSV import / export (1.8d) -----------------------

    /**
     * Parse CSV content and bulk-add. Returns
     *   { ok, parsedCount, addedCount, errors? }
     * Errors are per-row (skipped rows during parse + invalid rows during
     * create). Does NOT block on partial errors — adds what it can.
     */
    importCsvContent(content) {
      const parsed = parseCsv(content)
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason, message: parsed.message }
      }
      const added = pm() ? pm().bulkAdd(parsed.items) : []
      browser.broadcastToWebUI('oz:proxies:changed')
      log.info('proxy-handlers', 'importCsvContent', {
        parsed: parsed.items.length,
        added: added.length,
      })
      return { ok: true, parsedCount: parsed.items.length, addedCount: added.length }
    },

    importCsvFromFile(filePath) {
      let content
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        return { ok: false, reason: 'read-failed', message: err.message }
      }
      return this.importCsvContent(content)
    },

    exportCsvContent() {
      if (!pm()) return ''
      return encodeCsv(pm().list())
    },

    exportCsvToFile(filePath) {
      try {
        fs.writeFileSync(filePath, this.exportCsvContent(), 'utf-8')
      } catch (err) {
        return { ok: false, reason: 'write-failed', message: err.message }
      }
      return { ok: true, filePath }
    },

    // -------------------- Providers (1.8d) ---------------------------------

    /** List provider templates (id, label, status, fields). */
    listProviders() {
      return listProviders()
    },

    /**
     * Expand a provider into N proxy specs and add them to the manager.
     * Returns { ok, addedCount } or { __error }.
     */
    expandProvider(providerId, opts) {
      const r = expandProvider(providerId, opts || {})
      if (r.__error) return r
      const added = pm() ? pm().bulkAdd(r.items) : []
      browser.broadcastToWebUI('oz:proxies:changed')
      log.info('proxy-handlers', 'expandProvider added', {
        providerId,
        addedCount: added.length,
      })
      return { ok: true, providerId, addedCount: added.length }
    },

    /**
     * Toggle isActive flag for the given proxy. Auto-disabled proxies (after
     * 3 health failures) require an explicit re-enable: setting isActive=true
     * also clears isDisabled so the user can manually recover.
     */
    setActive(id, isActive) {
      if (!pm()) return null
      const patch = { isActive: !!isActive }
      if (isActive) patch.isDisabled = false
      const r = pm().update(id, patch)
      if (r) browser.broadcastToWebUI('oz:proxies:changed')
      log.info('proxy-handlers', 'setActive', { id, isActive: !!isActive })
      return r
    },

    /**
     * Auto-Assign one proxy via the requested strategy. Returns the proxy or
     * null if the assignable pool is empty. Does NOT mutate state — the
     * caller decides whether to persist the assignment via assignTo*.
     */
    autoAssign(strategy = 'random') {
      if (!pm()) return null
      const proxy = pm().autoAssign(strategy)
      log.info('proxy-handlers', 'autoAssign', {
        strategy,
        pickedId: proxy && proxy.id,
      })
      return proxy
    },

    /**
     * alpha.102 — Reconnect: manual failover. Rota la identity a otro proxy
     * sano (mismo núcleo que el auto-failover de alpha.101) y recarga sus
     * tabs materializados. Returns {ok, from, to, reloaded} o {ok:false, reason}.
     */
    async reconnect(identityId) {
      if (!identityId) return { ok: false, reason: 'bad_args' }
      const { rotateIdentityProxy } = require('./proxy-failover')
      const r = await rotateIdentityProxy(browser, identityId, 'manual')
      if (r && r.ok) {
        try {
          const tabs = browser.handlers && browser.handlers.tabs
          const rr =
            tabs && tabs.refreshAllInIdentity
              ? tabs.refreshAllInIdentity(identityId)
              : null
          r.reloaded = (rr && rr.count) || 0
        } catch (e) {
          log.warn('proxy-handlers', 'reconnect reload failed', {
            identityId,
            message: e && e.message,
          })
          r.reloaded = 0
        }
        browser.broadcastToWebUI('oz:proxies:changed')
      }
      log.info('proxy-handlers', 'reconnect', { identityId, ...r })
      return r
    },

    /** Bulk add (used by CSV import in 1.8d). */
    bulkAdd(items) {
      if (!pm()) return []
      const out = pm().bulkAdd(items || [])
      if (out.length > 0) browser.broadcastToWebUI('oz:proxies:changed')
      log.info('proxy-handlers', 'bulkAdd', {
        requested: (items || []).length,
        added: out.length,
      })
      return out
    },
  }
}

/**
 * Apply the resolved proxy (or clear it) to the live session for an identity.
 * Called after assignment changes so navigation immediately picks up the new
 * proxy without restart. We DO this from the handler — not from the resolver
 * itself — to keep proxy-assignment.js pure and easy to test.
 *
 * Workspace context is best-effort: if we can find ANY focused window using
 * this identity, we use that workspaceId for the resolution; otherwise we
 * pass undefined so only the identity assignment applies.
 */
function applyAssignmentsToIdentity(browser, identityId) {
  const im = browser.identityManager
  const pa = browser.proxyAssignment
  if (!im || !pa) return false
  const session = im.getSession(identityId)
  if (!session) return false

  let workspaceId
  for (const win of browser.windows || []) {
    if (
      win.tabs &&
      win.tabs.tabList &&
      win.tabs.tabList.some((t) => t.identityId === identityId)
    ) {
      workspaceId = win.workspaceId
      break
    }
  }

  const proxy = pa.resolve({ identityId, workspaceId })
  if (!proxy) {
    // Clear any prior proxy: 'direct://' tells Chrome to bypass entirely.
    session
      .setProxy({ proxyRules: 'direct://' })
      .then(() => {
        log.info('proxy-handlers', 'cleared proxy for identity', { identityId })
      })
      .catch((err) => {
        log.error('proxy-handlers', 'clear setProxy failed', {
          identityId,
          message: err.message,
        })
      })
    return true
  }

  const proxyRules = toProxyRulesString(proxy)
  session
    .setProxy({ proxyRules })
    .then(() => {
      log.info('proxy-handlers', 'applied proxy to identity session', {
        identityId,
        proxyId: proxy.id,
        rules: proxyRules,
      })
    })
    .catch((err) => {
      log.error('proxy-handlers', 'setProxy failed', {
        identityId,
        proxyId: proxy.id,
        message: err.message,
      })
    })
  return true
}

/**
 * V3-C: auto-match an identity's fingerprint geo to a proxy's country.
 *
 * Given the geoSuggestion resolved from the proxy's country, applies it to the
 * identity's fingerprint (timezone + languages + locale) and refreshes the live
 * cached session's Accept-Language so HTTP headers match navigator.languages.
 *
 * Respects two guards:
 *   - settings.privacy.autoMatchGeo (default true) — global off switch.
 *   - a MANUAL geo override on the profile is never clobbered
 *     (geo-match.shouldAutoApplyGeo).
 *
 * Returns true if geo was applied, false otherwise. Best-effort: never throws.
 */
function maybeAutoMatchGeo(browser, identityId, geoSuggestion) {
  try {
    if (!geoSuggestion) return false
    const fe = browser.fingerprintEngine
    if (!fe || typeof fe.applyGeoSuggestion !== 'function') return false

    // Global setting gate (default ON if settings unavailable).
    const sm = browser.settingsManager
    if (sm && typeof sm.get === 'function') {
      const privacy = sm.get('privacy')
      if (privacy && privacy.autoMatchGeo === false) return false
    }

    // Never clobber a manual override.
    const current =
      typeof fe.getOrCreate === 'function' ? fe.cache && fe.cache[identityId] : null
    if (!shouldAutoApplyGeo(current)) return false

    const profile = fe.applyGeoSuggestion(identityId, geoSuggestion, 'auto')
    if (!profile || profile.__error) return false

    // Refresh the live session's Accept-Language (UA unchanged) so the change
    // takes effect without a tab reload. Only touches an already-cached session.
    try {
      const im = browser.identityManager
      const cached = im && im.sessionCache && im.sessionCache.get(identityId)
      if (cached && profile.ua) {
        const acceptLang =
          formatAcceptLanguage(profile.languages) || profile.language || 'en-US,en;q=0.9'
        cached.setUserAgent(profile.ua, acceptLang)
      }
    } catch (err) {
      log.warn('proxy-handlers', 'live Accept-Language refresh failed', {
        identityId,
        message: err.message,
      })
    }

    browser.broadcastToWebUI('oz:fingerprint:changed', { identityId })
    log.info('proxy-handlers', 'auto-matched geo to proxy', {
      identityId,
      country: geoSuggestion.country,
      timezone: geoSuggestion.timezone,
    })
    return true
  } catch (err) {
    log.warn('proxy-handlers', 'maybeAutoMatchGeo failed', {
      identityId,
      message: err.message,
    })
    return false
  }
}

module.exports = { buildProxyHandlers, applyAssignmentsToIdentity, maybeAutoMatchGeo }
