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
const P = require('./ui/publishing-plan')
const log = require('./logger')

function buildPublishingHandlers(browser) {
  void browser
  const store = new PublishingPlanStore({ userDataDir: app.getPath('userData') })

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
  }
}

module.exports = { buildPublishingHandlers }
