// OZ Browser — Publishing Studio E5: content-plan import + approval workflow.
//
// Lógica PURA (sin DOM) para "cargar un mes de contenido de una":
//   - matrixToPlanRows(matrix): una hoja de Excel (array de arrays, fila 0 =
//     headers) → objetos de fila { date, platform, caption, media, identities }.
//   - parsePlanRows(rows): valida/normaliza → { publications, errors }.
//   - Approval state machine: draft → review → approved → published, con
//     reject (review→draft) y edit (→draft). canTransition/nextStatus.
//   - planToMatrix(publications): export de vuelta a matriz (Excel/CSV).
//
// El store (persistencia) vive en publishing-store.js; la UI en publishing-*.
// Dual-export (node + browser global window.OZ.PublishingPlan).
//
// ADR: 0038 (publishing-studio) · 0005 (modular).

;(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    const root = typeof window !== 'undefined' ? window : globalThis
    root.OZ = root.OZ || {}
    root.OZ.PublishingPlan = factory()
  }
})(function () {
  'use strict'

  const STATUSES = ['draft', 'review', 'approved', 'published']

  // action → { from: nextStatus }
  const TRANSITIONS = {
    submit: { draft: 'review' },
    approve: { review: 'approved' },
    reject: { review: 'draft' },
    publish: { approved: 'published' },
    // edit vuelve cualquier estado no-publicado a draft (re-trabajar).
    edit: { review: 'draft', approved: 'draft' },
  }

  // Header aliases (lowercased) → campo canónico.
  const HEADER_ALIASES = {
    date: 'date',
    fecha: 'date',
    when: 'date',
    platform: 'platform',
    red: 'platform',
    network: 'platform',
    caption: 'caption',
    texto: 'caption',
    text: 'caption',
    mensaje: 'caption',
    media: 'media',
    imagen: 'media',
    image: 'media',
    archivo: 'media',
    file: 'media',
    identities: 'identities',
    identidades: 'identities',
    cuentas: 'identities',
    accounts: 'identities',
  }

  const PLATFORM_ALIASES = {
    ig: 'instagram',
    instagram: 'instagram',
    x: 'x',
    twitter: 'x',
    fb: 'facebook',
    facebook: 'facebook',
    tiktok: 'tiktok',
    tt: 'tiktok',
    threads: 'threads',
    th: 'threads',
  }

  // E5/publish: plataforma → actionId del bulk runner (las que existen hoy).
  const ACTION_BY_PLATFORM = {
    instagram: 'ig_post',
    x: 'x_post',
    facebook: 'fb_post',
    threads: 'threads_post',
  }

  function _str(v) {
    return v == null ? '' : String(v).trim()
  }

  function _splitList(v) {
    return _str(v)
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /** Mapea un header crudo al campo canónico (o null si no se reconoce). */
  function canonicalHeader(h) {
    const key = _str(h).toLowerCase()
    return HEADER_ALIASES[key] || null
  }

  /** Normaliza un nombre de plataforma; '' si no se reconoce. */
  function normalizePlatform(p) {
    return PLATFORM_ALIASES[_str(p).toLowerCase()] || ''
  }

  /**
   * Hoja (array de arrays, fila 0 = headers) → array de objetos de fila.
   * Ignora filas totalmente vacías.
   *
   * @param {Array<Array<any>>} matrix
   * @returns {Array<object>}
   */
  function matrixToPlanRows(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 2) return []
    const headers = (matrix[0] || []).map(canonicalHeader)
    const rows = []
    for (let i = 1; i < matrix.length; i++) {
      const cells = matrix[i] || []
      if (cells.every((c) => _str(c) === '')) continue
      const row = {}
      headers.forEach((field, col) => {
        if (field) row[field] = cells[col]
      })
      rows.push(row)
    }
    return rows
  }

  /**
   * Valida + normaliza filas de plan a publicaciones (status 'draft').
   * Requiere platform reconocida y (caption o media). `date` es opcional
   * (sin date = sin programar).
   *
   * @param {Array<object>} rows
   * @returns {{publications: object[], errors: Array<{row:number,message:string}>}}
   */
  function parsePlanRows(rows) {
    const out = { publications: [], errors: [] }
    if (!Array.isArray(rows)) return out
    rows.forEach((r, idx) => {
      const platform = normalizePlatform(r && r.platform)
      const caption = _str(r && r.caption)
      const media = _splitList(r && r.media)
      const identities = _splitList(r && r.identities)
      const date = _str(r && r.date)
      if (!platform) {
        out.errors.push({ row: idx, message: `fila ${idx + 1}: plataforma inválida` })
        return
      }
      if (!caption && media.length === 0) {
        out.errors.push({ row: idx, message: `fila ${idx + 1}: falta caption o media` })
        return
      }
      out.publications.push({
        status: 'draft',
        platform,
        caption,
        media,
        identities,
        scheduledAt: date || null,
      })
    })
    return out
  }

  /** ¿La acción es válida desde el estado actual? */
  function canTransition(current, action) {
    const t = TRANSITIONS[action]
    return !!(t && t[current])
  }

  /** Próximo estado tras aplicar `action`, o el actual si no aplica. */
  function nextStatus(current, action) {
    const t = TRANSITIONS[action]
    return (t && t[current]) || current
  }

  /**
   * Publicaciones → matriz (headers + filas) para exportar a Excel/CSV.
   * @param {object[]} publications
   * @returns {Array<Array<any>>}
   */
  function planToMatrix(publications) {
    const headers = ['date', 'platform', 'caption', 'media', 'identities', 'status']
    const rows = [headers]
    for (const p of Array.isArray(publications) ? publications : []) {
      rows.push([
        p.scheduledAt || '',
        p.platform || '',
        p.caption || '',
        (Array.isArray(p.media) ? p.media : []).join('; '),
        (Array.isArray(p.identities) ? p.identities : []).join('; '),
        p.status || 'draft',
      ])
    }
    return rows
  }

  /** actionId del bulk runner para publicar en esta plataforma, o null. */
  function platformToActionId(platform) {
    return ACTION_BY_PLATFORM[_str(platform).toLowerCase()] || null
  }

  /**
   * Params exactos que espera la action del bulk runner para esta publicación.
   * ig_post → { imagePath, caption } · x_post → { text }.
   * @returns {object}
   */
  function buildPublishParams(platform, pub) {
    const p = pub || {}
    const media = Array.isArray(p.media) ? p.media : []
    switch (_str(platform).toLowerCase()) {
      case 'instagram':
        return { imagePath: media[0] || '', caption: _str(p.caption) }
      case 'x':
        return { text: _str(p.caption) }
      case 'facebook':
        return { text: _str(p.caption) }
      case 'threads':
        return { text: _str(p.caption) }
      default:
        return {}
    }
  }

  /**
   * Valida una publicación y arma el spec del bulk runner para publicarla
   * (ahora o programada). Una sola fuente de verdad para publish() y schedule().
   * @returns {{spec:{actionId,identityIds,params}} | {__error:{code,message}}}
   */
  function buildBulkSpec(pub) {
    const p = pub || {}
    const actionId = platformToActionId(p.platform)
    if (!actionId) {
      return {
        __error: {
          code: 'UNSUPPORTED_PLATFORM',
          message: `publish not supported for ${p.platform} (only instagram, x, facebook, threads)`,
        },
      }
    }
    const identityIds = (Array.isArray(p.identities) ? p.identities : []).filter(Boolean)
    if (identityIds.length === 0) {
      return { __error: { code: 'NO_TARGETS', message: 'publication has no identities' } }
    }
    const params = buildPublishParams(p.platform, p)
    if (actionId === 'ig_post' && !params.imagePath) {
      return {
        __error: { code: 'NO_MEDIA', message: 'instagram post needs a media path' },
      }
    }
    return { spec: { actionId, identityIds, params } }
  }

  /**
   * Pre-flight de una publicación SIN publicar (Etapa 2 — dry-run). Valida todo
   * lo chequeable estáticamente: plataforma soportada, media presente y EXISTE
   * en disco, identities resueltas y su salud (gating). NO toca el navegador.
   *
   * ctx (todo opcional): {
   *   identitiesById: { [id]: { name } },   // para marcar exists + nombre
   *   healthById:     { [id]: 'red'|'yellow'|'green'|'unknown' },
   *   mediaExists:    (path) => boolean,    // p.ej. fs.existsSync
   * }
   *
   * Devuelve { ok, publicationId, actionId, issues:[{code,message}],
   *            identities:[{ identityId, name, exists, health, willPublish }] }.
   * `ok` = sin issues bloqueantes Y toda identity existe y no está en rojo.
   */
  function dryRunReport(pub, ctx) {
    const p = pub || {}
    const c = ctx || {}
    const report = {
      ok: true,
      publicationId: p.id || null,
      actionId: null,
      issues: [],
      identities: [],
    }
    const actionId = platformToActionId(p.platform)
    if (!actionId) {
      report.ok = false
      report.issues.push({
        code: 'UNSUPPORTED_PLATFORM',
        message: `publish not supported for ${p.platform} (only instagram, x, facebook, threads)`,
      })
      return report
    }
    report.actionId = actionId

    // Media: requerida + debe existir en disco para ig_post.
    const params = buildPublishParams(p.platform, p)
    if (actionId === 'ig_post') {
      if (!params.imagePath) {
        report.ok = false
        report.issues.push({
          code: 'NO_MEDIA',
          message: 'instagram post needs a media path',
        })
      } else if (
        typeof c.mediaExists === 'function' &&
        !c.mediaExists(params.imagePath)
      ) {
        report.ok = false
        report.issues.push({
          code: 'MEDIA_NOT_FOUND',
          message: `media file not found on disk: ${params.imagePath}`,
        })
      }
    }

    // Identities: al menos una, cada una existe y no está en rojo (health gating).
    const ids = (Array.isArray(p.identities) ? p.identities : []).filter(Boolean)
    if (ids.length === 0) {
      report.ok = false
      report.issues.push({ code: 'NO_TARGETS', message: 'publication has no identities' })
    }
    const known = c.identitiesById || {}
    const health = c.healthById || {}
    for (const id of ids) {
      const exists = !!known[id]
      const h = health[id] || 'unknown'
      const willPublish = exists && h !== 'red'
      if (!exists || h === 'red') report.ok = false
      report.identities.push({
        identityId: id,
        name: exists ? known[id].name || id : null,
        exists,
        health: h,
        willPublish,
      })
    }
    return report
  }

  return {
    STATUSES,
    TRANSITIONS,
    ACTION_BY_PLATFORM,
    canonicalHeader,
    normalizePlatform,
    matrixToPlanRows,
    parsePlanRows,
    canTransition,
    nextStatus,
    planToMatrix,
    platformToActionId,
    buildPublishParams,
    buildBulkSpec,
    dryRunReport,
  }
})
