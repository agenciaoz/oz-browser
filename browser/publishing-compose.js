// OZ Browser — Publishing composer logic, MAIN-side (MCP-first migration).
//
// Migra la lógica del composer del renderer a una capa pura que el MAIN expone
// por MCP: el agente puede componer una publicación (elegir red, derivar campos
// del schema, validar, partir targets por salud y RESOLVER la variación
// anti-huella POR identity) sin tocar el renderer.
//
// Reusa la lógica pura existente:
//   - ui/publishing-helpers : fields desde schema, validación, health partition,
//                             drip, buildPublishSpec.
//   - ui/publishing-variation : spintax + hashtags + rotación de media por id.
//
// El handler (publishing-plan-handlers) inyecta los datos vivos (schema de la
// action vía bulk.listActions, health map, nombres de identities) y, para
// publicar, despacha un bulk run POR identity (params distintos por la
// variación → no caben en un solo run de params compartidos).
//
// ADR: 0038 (publishing-studio · ADR-B/ADR-C) · 0005 (modular).

'use strict'

const Hh = require('./ui/publishing-helpers')
const V = require('./ui/publishing-variation')

// Mapea el resultado de la variación (caption/mediaPath) a los params exactos
// que la action del bulk runner espera. Cae a los params base cuando no hay
// variación de ese campo.
function mapVariationToParams(actionId, resolved, baseParams) {
  const base = baseParams || {}
  const caption = resolved && resolved.caption != null ? resolved.caption : base.caption
  switch (actionId) {
    case 'ig_post':
      return {
        ...base,
        imagePath: (resolved && resolved.mediaPath) || base.imagePath || '',
        caption: caption != null ? caption : '',
      }
    case 'x_post':
    case 'fb_post':
      return { ...base, text: caption != null ? caption : base.text || '' }
    default:
      return { ...base }
  }
}

/**
 * Construye el plan de composición POR identity, sin publicar.
 *
 * @param {object} input
 *   { actionId, params, identityIds, variation?, spacingSec? }
 *   - variation (opcional): spec de ui/publishing-variation
 *     { caption (spintax), hashtags[], hashtagCount, firstCommentHashtags,
 *       mediaList[], vars }. Si está, cada identity recibe params propios.
 * @param {object} ctx
 *   { action: {paramsSchema}, healthMap: Map<id,status>|list, identities:[{id,name}] }
 * @returns {{
 *   ok, actionId, fields, plan:[{identityId, name, params, errors?}],
 *   warned:[{id,status}], blocked:[{id,status}], drip?, code?, errors?
 * }}
 */
function buildComposePlan(input = {}, ctx = {}) {
  const actionId = input.actionId
  const action = ctx.action || { paramsSchema: { type: 'object', properties: {} } }
  const fields = Hh.fieldsFromSchema(action)
  const identityIds = Array.isArray(input.identityIds) ? input.identityIds : []

  // Health gating (red = blocked, yellow = warned-but-allowed).
  const { allowed, warned, blocked } = Hh.partitionTargetsByHealth(
    identityIds,
    ctx.healthMap || new Map(),
  )

  // Top-level preflight (targets count). Param validation is per-identity below.
  const pre = Hh.preflightPublish({
    fields,
    params: input.params || {},
    identityIds: allowed,
  })
  if (!pre.ok && pre.code !== 'invalidParams') {
    return {
      ok: false,
      code: pre.code,
      max: pre.max,
      actionId,
      fields,
      warned,
      blocked,
      plan: [],
    }
  }

  const idMeta = {}
  for (const it of ctx.identities || []) if (it && it.id) idMeta[it.id] = it

  const plan = []
  let allValid = true
  allowed.forEach((id, index) => {
    let params
    if (input.variation && typeof input.variation === 'object') {
      const resolved = V.resolveForIdentity(input.variation, {
        index,
        identity: idMeta[id] || { id },
      })
      params = mapVariationToParams(actionId, resolved, input.params)
    } else {
      params = { ...(input.params || {}) }
    }
    const v = Hh.validatePublishInput(fields, params)
    if (!v.ok) allValid = false
    plan.push({
      identityId: id,
      name: (idMeta[id] && idMeta[id].name) || id,
      params,
      errors: v.errors,
    })
  })

  return {
    ok: allValid && allowed.length > 0,
    actionId,
    fields,
    plan,
    warned,
    blocked,
    drip: Hh.dripOptions(input.spacingSec),
  }
}

module.exports = { buildComposePlan, mapVariationToParams }
