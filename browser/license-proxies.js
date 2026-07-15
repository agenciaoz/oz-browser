// OZ Browser — apply per-license proxy bundles (v2.0.0-alpha.100).
//
// The activation server (Cloudflare Worker + D1) delivers a `proxies` array on
// /activate + /validate (see license-manager.js). This module imports that
// bundle into the ProxyManager and auto-assigns it to identities, so a fresh
// install activated with a key comes up with its proxies already wired — the
// user touches nothing.
//
// Idempotent: safe to call on every boot. Dedups by host:port:username, respects
// proxy bindings the user set manually, and only fills identities that have no
// binding yet.
//
// Pure-ish: takes the managers as args (no globals) so it's unit-testable.

const log = require('./logger')

const MANAGED_TAG = 'managed'

// Identity key for dedup. Two proxies are "the same" iff host+port+username
// match — for Decodo per-user sessions the username carries the session token,
// so distinct sessions stay distinct even on the same port.
function keyOf(p) {
  return `${p.host}:${p.port}:${p.username || ''}`
}

/**
 * @param {object} o
 * @param {object} o.proxyManager      - ProxyManager (create/list)
 * @param {object} o.proxyAssignment   - ProxyAssignment (assignToIdentity/setDefaultStrategy/snapshot)
 * @param {object} [o.identityManager] - IdentityManager (list)
 * @param {Array}  o.proxies           - bundle from the activation server
 * @returns {{ok:boolean, added:number, assigned:number, pool?:number, reason?:string}}
 */
function applyManagedProxies({
  proxyManager,
  proxyAssignment,
  identityManager,
  proxies,
} = {}) {
  if (!proxyManager || !proxyAssignment) {
    return { ok: false, added: 0, assigned: 0, reason: 'no_managers' }
  }
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return { ok: false, added: 0, assigned: 0, reason: 'no_proxies' }
  }

  const existing = proxyManager.list() || []
  const byKey = new Map(existing.map((p) => [keyOf(p), p]))
  const managedIds = []
  let added = 0

  for (const p of proxies) {
    if (!p || !p.host || !p.port) continue
    const k = keyOf(p)
    let found = byKey.get(k)
    if (!found) {
      const created = proxyManager.create({
        name: p.name || `${p.host}:${p.port}`,
        protocol: p.protocol || 'https',
        host: p.host,
        port: Number(p.port),
        username: p.username || null,
        password: p.password || null,
        country: p.country || null,
        tags: Array.from(
          new Set([...(Array.isArray(p.tags) ? p.tags : []), MANAGED_TAG]),
        ),
      })
      if (created && created.id) {
        found = created
        byKey.set(k, created)
        added++
      }
    }
    if (found && found.id) managedIds.push(found.id)
  }

  if (managedIds.length === 0) {
    return { ok: false, added, assigned: 0, reason: 'nothing_created' }
  }

  // Any identity without an explicit binding falls back to the managed pool.
  proxyAssignment.setDefaultStrategy('auto-round-robin')

  // Dedicated auto-assign: identities with NO binding get a managed proxy
  // (round-robin). Respect whatever the user already assigned.
  let assigned = 0
  const snap = (proxyAssignment.snapshot && proxyAssignment.snapshot()) || {}
  const bound = snap.byIdentity || {}
  const identities =
    (identityManager && identityManager.list && identityManager.list()) || []
  let i = 0
  for (const ident of identities) {
    if (!ident || !ident.id) continue
    if (bound[ident.id]) continue // respect existing choice
    const pid = managedIds[i % managedIds.length]
    if (proxyAssignment.assignToIdentity(ident.id, pid)) {
      assigned++
      i++
    }
  }

  log.info('license-proxies', 'applied managed proxies', {
    added,
    assigned,
    pool: managedIds.length,
  })
  return { ok: true, added, assigned, pool: managedIds.length }
}

/**
 * Boot helper called from main.js: pull the stored bundle, apply it, and report
 * whether this install should enforce fail-closed (managed install = bundle
 * present). Best-effort — never throws.
 *
 * @returns {{enforce:boolean, result?:object}}
 */
function bootstrapForBoot(browser, licenseManager, log) {
  try {
    const bundle =
      licenseManager && licenseManager.getStoredProxies
        ? licenseManager.getStoredProxies()
        : []
    const result = applyManagedProxies({
      proxyManager: browser && browser.proxyManager,
      proxyAssignment: browser && browser.proxyAssignment,
      identityManager: browser && browser.identityManager,
      proxies: bundle,
    })
    const enforce = Array.isArray(bundle) && bundle.length > 0
    if (browser) browser.enforceProxy = enforce
    if (browser && browser.stickyRotation && browser.stickyRotation.setEnforce) {
      browser.stickyRotation.setEnforce(enforce)
    }
    if (result && result.ok && log) {
      log.info('license-proxies', 'applied at boot', result)
    }
    return { enforce, result }
  } catch (e) {
    if (log) log.warn('license-proxies', 'bootstrap failed', { message: e && e.message })
    return { enforce: false }
  }
}

module.exports = { applyManagedProxies, bootstrapForBoot, keyOf, MANAGED_TAG }
