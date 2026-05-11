// OZ Browser — Identity clone (E2-C-3 fase 1).
//
// Qué hace: duplica una identity existente preservando opcionalmente
// fingerprint, proxy assignment y/o User-Agent. Use case real (Jose):
// "5 sub-cuentas IG con el mismo fingerprint" (SaaS competitivo vs Ghost
// que NO tiene clone-with-options).
//
// Doc: docs/modules/identity-clone.md
// ADR: ninguna (orquestación sobre primitivas existentes — IdentityManager
// + ProxyAssignment + FingerprintEngine).
//
// API (módulo puro testeable):
//   cloneIdentity({
//     srcId,
//     opts: { name?, sameFingerprint, sameProxy, sameUA },
//     identityManager,
//     proxyAssignment?,
//   })
//     → { ok: true, identity }  ó  { ok: false, reason }
//
//   resolveCopyName(srcName, allIdentities)
//     → string  ("X (copy)", "X (copy 2)", etc — colision-aware)
//
// Defaults:
//   - sameFingerprint: false → seed nueva (perfiles distintos por safety
//     anti-detect: si un account es flagged, los clones NO matchean fingerprint).
//   - sameProxy:       true  → mismo proxy assignment (use case más común:
//     sub-cuentas del mismo cluster geográfico).
//   - sameUA:          false → UA fresca (deja al engine decidir blueprint).
//
// El llamador (handler) decide los defaults; este módulo aplica EXACTAMENTE
// lo que se le pide en opts (no asume defaults aquí). El handler los aplica.

function resolveCopyName(srcName, allIdentities) {
  if (typeof srcName !== 'string' || !srcName) srcName = 'Identity'
  const list = Array.isArray(allIdentities) ? allIdentities : []
  // Strip trailing " (copy)" / " (copy N)" so cloning a clone gives "X (copy 2)"
  // instead of "X (copy) (copy)".
  const base = srcName.replace(/ \(copy(?: \d+)?\)$/, '')
  const taken = new Set(list.map((i) => i && i.name).filter(Boolean))
  const first = `${base} (copy)`
  if (!taken.has(first)) return first
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (copy ${i})`
    if (!taken.has(candidate)) return candidate
  }
  // Fallback (should never hit in practice — would mean 1000 clones in a row).
  return `${base} (copy ${Date.now()})`
}

/**
 * Clone an identity. Returns {ok:true, identity} or {ok:false, reason}.
 *
 * @param {object} args
 * @param {string} args.srcId — id of the source identity
 * @param {object} args.opts — clone options
 *   - name: explicit new name; if omitted, resolveCopyName picks one.
 *   - sameFingerprint: if true, copy parent's fingerprintSeed → same FP profile.
 *   - sameProxy: if true, inherit parent's proxy assignment (if any).
 *   - sameUA: if true, copy parent's userAgent override.
 * @param {object} args.identityManager — IdentityManager instance (required)
 * @param {object} [args.proxyAssignment] — ProxyAssignment instance (optional;
 *   only needed if opts.sameProxy is truthy)
 */
function cloneIdentity({ srcId, opts = {}, identityManager, proxyAssignment }) {
  if (!identityManager || typeof identityManager.get !== 'function') {
    return { ok: false, reason: 'no-identity-manager' }
  }
  const src = identityManager.get(srcId)
  if (!src) return { ok: false, reason: 'not-found', srcId }

  const all = typeof identityManager.list === 'function' ? identityManager.list() : []
  const finalName =
    typeof opts.name === 'string' && opts.name.trim()
      ? opts.name.trim()
      : resolveCopyName(src.name, all)

  // Build the create() payload. Color is always inherited (visual cue that
  // this is "the same family"). Workspace inherited (clone lives next to
  // the parent — user can move it later via right-click).
  const createPayload = {
    name: finalName,
    color: src.color,
    workspaceId: src.workspaceId,
  }
  if (opts.sameFingerprint && src.fingerprintSeed) {
    createPayload.fingerprintSeed = src.fingerprintSeed
  }
  if (opts.sameUA && src.userAgent) {
    createPayload.userAgent = src.userAgent
  }

  let created
  try {
    created = identityManager.create(createPayload)
  } catch (err) {
    // Most likely IDENTITY_CAP_REACHED on free tier.
    return {
      ok: false,
      reason: err && err.code ? err.code : 'create-failed',
      message: err && err.message,
    }
  }

  // Same proxy: copy the parent's assignment (concrete proxyId or
  // 'auto-random'/'auto-round-robin' string).
  let inheritedProxy = null
  if (opts.sameProxy && proxyAssignment) {
    const byIdent = proxyAssignment.assignments && proxyAssignment.assignments.byIdentity
    const srcAssign = byIdent && byIdent[srcId]
    if (srcAssign != null && typeof proxyAssignment.assignToIdentity === 'function') {
      try {
        proxyAssignment.assignToIdentity(created.id, srcAssign)
        inheritedProxy = srcAssign
      } catch (_e) {
        // best-effort — clone still succeeded; proxy inheritance is gravy
      }
    }
  }

  return {
    ok: true,
    identity: created,
    inherited: {
      fingerprint: !!opts.sameFingerprint && !!src.fingerprintSeed,
      proxy: !!inheritedProxy,
      proxyValue: inheritedProxy,
      ua: !!opts.sameUA && !!src.userAgent,
    },
  }
}

module.exports = { cloneIdentity, resolveCopyName }
