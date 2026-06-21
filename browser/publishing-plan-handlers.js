// OZ Browser — Publishing plan handlers (E5, MAIN). Expuesto por IPC
// (oz:publishing:*) y MCP (oz.publishing.*) bajo browser.handlers.publishing.
// Una sola fuente de verdad en main (PublishingPlanStore) → el MCP puede
// importar un plan, listar, mover de estado, editar y exportar.
//
// Reusa la lógica pura de ui/publishing-plan.js (parse + state machine + export).
//
// ADR: 0038 (publishing-studio) · 0005 (modular) · 0012 (oz-mcp-server).

'use strict'

const { app } = require('electron')
const { PublishingPlanStore } = require('./publishing-plan-store')
const { PublishingLibraryStore } = require('./publishing-library-store')
const P = require('./ui/publishing-plan')
const V = require('./ui/publishing-variation')
const log = require('./logger')

function buildPublishingHandlers(browser) {
  void browser
  const store = new PublishingPlanStore({ userDataDir: app.getPath('userData') })
  const library = new PublishingLibraryStore({ userDataDir: app.getPath('userData') })

  return {
    /**
     * Importa un plan de contenido. Acepta `matrix` (hoja Excel: array de
     * arrays, fila 0 = headers) o `rows` (objetos ya mapeados). Devuelve
     * { added, errors }.
     */
    import({ matrix, rows } = {}) {
      const planRows = Array.isArray(matrix) ? P.matrixToPlanRows(matrix) : rows
      const { publications, errors } = P.parsePlanRows(planRows)
      const added = store.addMany(publications)
      log.info('publishing', 'plan imported', { added, errors: errors.length })
      return { added, errors }
    },

    list(status) {
      return status ? store.listByStatus(status) : store.list()
    },
    get(id) {
      return store.get(id)
    },

    /**
     * Aplica una acción del workflow (submit/approve/reject/publish/edit).
     * Devuelve la publicación actualizada o { __error }.
     */
    status(id, action) {
      const pub = store.get(id)
      if (!pub)
        return { __error: { code: 'NOT_FOUND', message: 'publication not found' } }
      if (!P.canTransition(pub.status, action)) {
        return {
          __error: {
            code: 'BAD_TRANSITION',
            message: `cannot ${action} from ${pub.status}`,
          },
        }
      }
      return store.setStatus(id, P.nextStatus(pub.status, action))
    },

    /**
     * Publica una publicación AHORA vía el bulk runner (MCP-first end-to-end):
     * mapea plataforma→actionId (ig_post/x_post), corre sobre sus identities y,
     * si se despachó, marca la publicación como 'published'.
     */
    async publish(id) {
      const pub = store.get(id)
      if (!pub)
        return { __error: { code: 'NOT_FOUND', message: 'publication not found' } }
      const built = P.buildBulkSpec(pub)
      if (built.__error) return built
      const bulk = browser.handlers && browser.handlers.bulk
      if (!bulk || typeof bulk.run !== 'function') {
        return { __error: { code: 'NO_BULK', message: 'bulk runner unavailable' } }
      }
      const res = await bulk.run(built.spec)
      if (res && res.ok) {
        store.setStatus(id, 'published')
        log.info('publishing', 'published via bulk', {
          id,
          actionId: built.spec.actionId,
          runId: res.runId,
        })
      }
      return res
    },

    /**
     * Programa una publicación (MCP-first end-to-end): crea una Scheduled Action
     * tipo 'bulk' con el spec de la publicación. `schedule` usa el shape del
     * runner: { type:'daily', time:'HH:MM' } | { type:'weekly', day, time } |
     * { type:'every-minutes', minutes }. Guarda el scheduledActionId en la
     * publicación para poder cancelarla luego. Devuelve { ok, action } o __error.
     */
    schedule(id, schedule) {
      const pub = store.get(id)
      if (!pub)
        return { __error: { code: 'NOT_FOUND', message: 'publication not found' } }
      const built = P.buildBulkSpec(pub)
      if (built.__error) return built
      const sched = browser.handlers && browser.handlers.scheduled
      if (!sched || typeof sched.create !== 'function') {
        return { __error: { code: 'NO_SCHED', message: 'scheduler unavailable' } }
      }
      const res = sched.create({
        name: `publish:${pub.platform}:${id}`,
        action: 'bulk',
        params: { spec: built.spec },
        schedule,
        enabled: true,
      })
      if (res && res.ok && res.action) {
        store.update(id, { scheduledAt: schedule, scheduledActionId: res.action.id })
        log.info('publishing', 'scheduled via bulk', {
          id,
          actionId: built.spec.actionId,
          scheduledActionId: res.action.id,
        })
      }
      return res
    },

    /** Cancela la programación de una publicación (borra su Scheduled Action). */
    unschedule(id) {
      const pub = store.get(id)
      if (!pub)
        return { __error: { code: 'NOT_FOUND', message: 'publication not found' } }
      const sched = browser.handlers && browser.handlers.scheduled
      let removed = false
      if (pub.scheduledActionId && sched && typeof sched.remove === 'function') {
        const r = sched.remove(pub.scheduledActionId)
        removed = !!(r && r.removed)
      }
      store.update(id, { scheduledAt: null, scheduledActionId: null })
      return { ok: true, removed }
    },

    update(id, patch) {
      const r = store.update(id, patch || {})
      return r || { __error: { code: 'NOT_FOUND', message: 'publication not found' } }
    },
    remove(id) {
      return store.remove(id)
    },
    /** Exporta el plan como matriz (headers + filas) para Excel/CSV. */
    export() {
      return P.planToMatrix(store.list())
    },

    // ── Content variation (anti-footprint) — MCP-first ──────────────────
    /**
     * Previsualiza el contenido VARIADO por identity (spintax + subset de
     * hashtags + rotación de media). Determinístico por identityId. Devuelve
     * una fila por identity: { identityId, name, caption, mediaPath, firstComment }.
     * El agente puede ver exactamente qué postearía cada cuenta antes de disparar.
     */
    preview(spec, identities) {
      return V.previewVariations(spec || {}, identities || [])
    },
    /**
     * Resuelve el contenido variado para UNA identity (mismo motor que preview).
     * opts: { index, identity:{id,name}, vars }. Devuelve
     * { caption, hashtags, hashtagsText, mediaPath, firstComment }.
     */
    resolve(spec, opts) {
      return V.resolveForIdentity(spec || {}, opts || {})
    },
    /** Cuenta variantes posibles de un spintax (alerta "poca variedad"). */
    variety(text) {
      return { variants: V.spintaxVariety(text) }
    },

    // ── Library (templates | hashtags | media) — MCP-first ──────────────
    libList(kind) {
      return library.list(kind)
    },
    libSave(kind, item) {
      const r = library.save(kind, item || {})
      return r || { __error: { code: 'BAD_KIND', message: `invalid kind: ${kind}` } }
    },
    libDel(kind, id) {
      return library.remove(kind, id)
    },
  }
}

module.exports = { buildPublishingHandlers }
