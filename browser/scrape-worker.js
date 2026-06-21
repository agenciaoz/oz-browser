// OZ Browser — Real scrape worker factory (V3-D close).
//
// Convierte el page-driver (page-handlers) en un `worker(task)` para
// runScrapeJob: por cada URL del frontier, navega y corre el recipe
// (reutiliza runHeadlessRecipe), y mapea el resultado a la forma que el
// orquestador espera: { ok, data?, links?, retryable?, error? }.
//
// Retry: el worker NO reintenta internamente (recipe con maxAttempts:1); el
// reintento lo maneja el frontier/orquestador (clase de error → retryable vía
// scrape-retry). Así no se duplican reintentos.
//
// Pieza testeable: `driver` y `clock` se inyectan (fake en tests; page-handlers
// reales en runtime, vía scrape-handlers.js).
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const { runHeadlessRecipe } = require('./headless-runner')
const { classifyError } = require('./scrape-retry')

/**
 * @param {object} args
 * @param {object} args.driver       page-handlers (o fake).
 * @param {string} args.identityId
 * @param {object} [args.recipe]     { steps:[...] } extra tras navegar (extract/getText/etc).
 * @param {object} [args.clock]
 * @param {string} [args.linksName]  nombre del step cuyo resultado (array de urls) se
 *                                   usa como links a seguir (follow-links). Opcional.
 * @returns {(task:{url:string})=>Promise<{ok:boolean,data?:any,links?:string[],retryable?:boolean,error?:any}>}
 */
function makeRecipeWorker({ driver, identityId, recipe, clock, linksName } = {}) {
  const extraSteps = recipe && Array.isArray(recipe.steps) ? recipe.steps : []
  return async function worker(task) {
    const steps = [{ op: 'navigate', url: task.url }, ...extraSteps]
    const res = await runHeadlessRecipe({
      recipe: { steps },
      driver,
      identityId,
      // El frontier maneja el reintento → un intento por pasada.
      retry: { maxAttempts: 1 },
      clock,
    })
    if (res.ok) {
      const out = { ok: true, data: res.data }
      if (linksName && Array.isArray(res.data && res.data[linksName])) {
        out.links = res.data[linksName].filter((u) => typeof u === 'string')
      }
      return out
    }
    const firstFail = (res.steps || []).find((s) => !s.ok)
    const err = firstFail
      ? firstFail.error
      : { message: (res.errors && res.errors[0]) || 'failed' }
    return { ok: false, retryable: classifyError(err).retryable, error: err }
  }
}

module.exports = { makeRecipeWorker }
