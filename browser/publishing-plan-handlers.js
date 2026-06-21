// OZ Browser — Publishing plan handlers (E5, MAIN). Expuesto por IPC
// (oz:publishing:*) y MCP (oz.publishing.*) bajo browser.handlers.publishing.
// Una sola fuente de verdad en main (PublishingPlanStore) → el MCP puede
// importar un plan, listar, mover de estado, editar y exportar.
//
// Reusa la lógica pura de ui/publishing-plan.js (parse + state machine + export).
//
// ADR: 0038 (publishing-studio) · 0005 (modular) · 0012 (oz-mcp-server).

'use strict'

const fs = require('fs')
const { app } = require('electron')
const { PublishingPlanStore } = require('./publishing-plan-store')
const { PublishingLibraryStore } = require('./publishing-library-store')
const P = require('./ui/publishing-plan')
const V = require('./ui/publishing-variation')
const A = require('./publishing-analytics')
const Hh = require('./ui/publishing-helpers')
const C = require('./publishing-compose')
const log = require('./logger')

function buildPublishingHandlers(browser) {
  void browser
  const store = new PublishingPlanStore({ userDataDir: app.getPath('userData') })
  const library = new PublishingLibraryStore({ userDataDir: app.getPath('userData') })

  // Resolve the publishable actions (id+label+platform+paramsSchema) from the
  // bulk registry, annotated with their composer fields. Single source so the
  // agent and the UI derive the form from the SAME schema (ADR-B).
  function listPublishActions() {
    const bulk = browser.handlers && browser.handlers.bulk
    const all = bulk && typeof bulk.listActions === 'function' ? bulk.listActions() : []
    return Hh.pickPublishActions(all).map((a) => ({
      ...a,
      fields: Hh.fieldsFromSchema(a),
    }))
  }

  // Gather the live context buildComposePlan needs: the action schema, a health
  // map for the targets, and identity name metadata (for {{identity}} vars).
  async function gatherComposeCtx(actionId, identityIds) {
    const action = listPublishActions().find((a) => a.actionId === actionId) || null
    const idsH = browser.handlers && browser.handlers.ids
    const healthH = browser.handlers && browser.handlers.health
    const identities = []
    if (idsH && typeof idsH.list === 'function') {
      for (const it of idsH.list() || []) if (it && it.id) identities.push(it)
    }
    const healthMap = new Map()
    if (healthH && typeof healthH.get === 'function') {
      for (const idn of identityIds || []) {
        try {
          const rec = await healthH.get(idn)
          if (rec && !rec.__error) healthMap.set(idn, rec.overall || 'unknown')
        } catch (_e) {
          /* health best-effort */
        }
      }
    }
    return { action, healthMap, identities }
  }

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

    /**
     * Dry-run / pre-flight (Etapa 2): valida una publicación SIN publicar.
     * Resuelve identities (existen?), su salud (gating), y que la media exista
     * en disco. Reusa la lógica pura `P.dryRunReport`. NO toca el navegador
     * (la validación de login/selectores en vivo es trabajo del runner real).
     */
    async dryRun(id) {
      const pub = store.get(id)
      if (!pub)
        return { __error: { code: 'NOT_FOUND', message: 'publication not found' } }
      const idsH = browser.handlers && browser.handlers.ids
      const healthH = browser.handlers && browser.handlers.health
      const identitiesById = {}
      if (idsH && typeof idsH.list === 'function') {
        for (const it of idsH.list() || []) if (it && it.id) identitiesById[it.id] = it
      }
      const healthById = {}
      const targets = (Array.isArray(pub.identities) ? pub.identities : []).filter(
        Boolean,
      )
      if (healthH && typeof healthH.get === 'function') {
        for (const idn of targets) {
          try {
            const rec = await healthH.get(idn)
            if (rec && !rec.__error) healthById[idn] = rec.overall || 'unknown'
          } catch (_e) {
            /* health best-effort */
          }
        }
      }
      return P.dryRunReport(pub, {
        identitiesById,
        healthById,
        mediaExists: (pth) => {
          try {
            return fs.existsSync(pth)
          } catch (_e) {
            return false
          }
        },
      })
    },

    /**
     * Analytics de publicaciones (E7): tasa de éxito por red / por identity /
     * por hora (UTC), sobre el historial de bulk runs de actions de publicar
     * (ig_post/x_post/fb_post). Reusa la lógica pura `publishing-analytics`.
     * Devuelve { overall, byNetwork, byIdentity, byHour } (cada bucket con
     * successRate). MCP-first: "¿cómo van mis posteos?" sin abrir la UI.
     */
    analytics(opts) {
      const bulk = browser.handlers && browser.handlers.bulk
      if (!bulk || typeof bulk.list !== 'function' || typeof bulk.get !== 'function') {
        return { __error: { code: 'NO_BULK', message: 'bulk runner unavailable' } }
      }
      const summaries = bulk.list() || []
      const records = []
      for (const s of summaries) {
        const full = bulk.get(s.runId)
        if (full) records.push(full)
      }
      return A.computeAnalytics(records, opts || {})
    },

    // ── Composer (migrado del renderer a main, MCP-first) ───────────────
    /**
     * Lista las redes publicables con sus campos derivados del schema de la
     * action (ADR-B). El agente sabe qué campos pide cada red sin la UI.
     */
    actions() {
      return listPublishActions()
    },

    /**
     * Compone una publicación SIN publicar: deriva campos, parte los targets
     * por salud (rojo=bloqueado), y RESUELVE la variación anti-huella por
     * identity. Devuelve el plan { plan:[{identityId,name,params,errors}],
     * warned, blocked, ok }. Es el "preview de composición" del agente.
     */
    async compose(input = {}) {
      const actionId = input.actionId || P.platformToActionId(input.platform)
      if (!actionId)
        return {
          __error: { code: 'UNSUPPORTED_PLATFORM', message: 'unknown platform/action' },
        }
      const ctx = await gatherComposeCtx(actionId, input.identityIds)
      if (!ctx.action)
        return {
          __error: {
            code: 'UNKNOWN_ACTION',
            message: `not a publish action: ${actionId}`,
          },
        }
      return C.buildComposePlan({ ...input, actionId }, ctx)
    },

    /**
     * Compone Y publica AHORA en un solo paso (MCP-first end-to-end). Si hay
     * variación, despacha UN bulk run por identity (params propios); si no, un
     * único run con todas. Devuelve { ok, dispatched:[{identityId,runId|error}],
     * warned, blocked } o { __error }.
     */
    async composePublish(input = {}) {
      const c = await this.compose(input)
      if (c.__error) return c
      if (!c.ok)
        return {
          __error: {
            code: 'INVALID_COMPOSE',
            message: 'compose plan not valid',
            plan: c.plan,
            blocked: c.blocked,
          },
        }
      const bulk = browser.handlers && browser.handlers.bulk
      if (!bulk || typeof bulk.run !== 'function')
        return { __error: { code: 'NO_BULK', message: 'bulk runner unavailable' } }
      const options =
        input.options && Object.keys(input.options).length
          ? input.options
          : c.drip || undefined
      const dispatched = []
      if (input.variation) {
        // Per-identity params → one run each.
        for (const row of c.plan) {
          try {
            const res = await bulk.run(
              Hh.buildPublishSpec({
                actionId: c.actionId,
                identityIds: [row.identityId],
                params: row.params,
                options,
              }),
            )
            dispatched.push({
              identityId: row.identityId,
              runId: res && res.runId,
              ok: !!(res && res.ok),
            })
          } catch (e) {
            dispatched.push({ identityId: row.identityId, error: e.message })
          }
        }
      } else {
        const ids = c.plan.map((r) => r.identityId)
        const res = await bulk.run(
          Hh.buildPublishSpec({
            actionId: c.actionId,
            identityIds: ids,
            params: input.params || {},
            options,
          }),
        )
        for (const id of ids)
          dispatched.push({
            identityId: id,
            runId: res && res.runId,
            ok: !!(res && res.ok),
          })
      }
      log.info('publishing', 'composePublish dispatched', {
        actionId: c.actionId,
        count: dispatched.length,
      })
      return {
        ok: true,
        actionId: c.actionId,
        dispatched,
        warned: c.warned,
        blocked: c.blocked,
      }
    },

    /**
     * Programa una publicación desde input CRUDO del composer (sin pasar por
     * el plan store): arma el ScheduledAction tipo bulk con buildScheduleInput
     * y lo crea. Mueve el armado del spec/schedule del renderer a main.
     * input: { actionId|platform, identityIds, params, schedule, options, name }.
     */
    scheduleCompose(input = {}) {
      const actionId = input.actionId || P.platformToActionId(input.platform)
      if (!actionId)
        return {
          __error: { code: 'UNSUPPORTED_PLATFORM', message: 'unknown platform/action' },
        }
      const sched = browser.handlers && browser.handlers.scheduled
      if (!sched || typeof sched.create !== 'function')
        return { __error: { code: 'NO_SCHED', message: 'scheduler unavailable' } }
      const create = Hh.buildScheduleInput({
        name: input.name,
        actionId,
        identityIds: input.identityIds || [],
        params: input.params || {},
        schedule: input.schedule,
        options: input.options,
      })
      return sched.create(create)
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
