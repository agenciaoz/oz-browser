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

// Nombre reservado del step de evidencia (screenshot por página). Se strippea
// de `data` antes de devolver — no es dato de la página, es para el timeline.
const EVIDENCE_STEP = '__ozEvidence'

/**
 * @param {object} args
 * @param {object} args.driver       page-handlers (o fake).
 * @param {string} args.identityId
 * @param {object} [args.recipe]     { steps:[...] } extra tras navegar (extract/getText/etc).
 * @param {object} [args.clock]
 * @param {string} [args.linksName]  nombre del step cuyo resultado (array de urls) se
 *                                   usa como links a seguir (follow-links). Opcional.
 * @param {boolean} [args.captureEvidence]  si true, saca un screenshot por página
 *                                   y devuelve `screenshot` (path) para el observer 6c.
 * @param {(a:{identityId:string,base64:string,url:string})=>string|null} [args.writeEvidence]
 *                                   persiste el PNG y devuelve su path (inyectable en tests).
 * @returns {(task:{url:string})=>Promise<{ok:boolean,data?:any,links?:string[],screenshot?:string,bytes?:number,retryable?:boolean,error?:any}>}
 */
function makeRecipeWorker({
  driver,
  identityId,
  recipe,
  clock,
  linksName,
  captureEvidence,
  writeEvidence,
} = {}) {
  const extraSteps = recipe && Array.isArray(recipe.steps) ? recipe.steps : []
  const persist = writeEvidence || defaultWriteEvidence
  return async function worker(task) {
    const steps = [{ op: 'navigate', url: task.url }, ...extraSteps]
    if (captureEvidence) {
      // optional:true → un fallo de captura no tumba la página scrapeada.
      steps.push({ op: 'screenshot', name: EVIDENCE_STEP, optional: true })
    }
    const res = await runHeadlessRecipe({
      recipe: { steps },
      driver,
      identityId,
      // El frontier maneja el reintento → un intento por pasada.
      retry: { maxAttempts: 1 },
      clock,
    })
    if (res.ok) {
      const data = res.data || {}
      // Extraer + strippear la evidencia del data real.
      let screenshot = null
      const ev = data[EVIDENCE_STEP]
      if (ev && ev.base64) {
        screenshot = persist({ identityId, base64: ev.base64, url: task.url }) || null
      }
      if (EVIDENCE_STEP in data) delete data[EVIDENCE_STEP]

      const out = { ok: true, data, bytes: _estimateBytes(data) }
      if (screenshot) out.screenshot = screenshot
      if (linksName && Array.isArray(data[linksName])) {
        out.links = data[linksName].filter((u) => typeof u === 'string')
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

// Estima bytes del payload extraído (para el cost tracker del observer). No es
// el bandwidth de red real (eso lo mide proxy-bandwidth.js) — es el tamaño de
// lo que el recipe se llevó de cada página.
function _estimateBytes(data) {
  if (data == null) return 0
  try {
    return JSON.stringify(data).length
  } catch (_e) {
    return 0
  }
}

// Persistencia por defecto de la evidencia: escribe el PNG en
// userData/scrape-evidence/. Best-effort — devuelve null si algo falla.
// (Se carga electron/fs perezosamente para no romper los tests puros que
// inyectan su propio writeEvidence.)
function defaultWriteEvidence({ identityId, base64 }) {
  try {
    const fs = require('fs')
    const path = require('path')
    const { app } = require('electron')
    const dir = path.join(app.getPath('userData'), 'scrape-evidence')
    fs.mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `${identityId || 'id'}-${ts}.png`)
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    return file
  } catch (_e) {
    return null
  }
}

module.exports = { makeRecipeWorker, EVIDENCE_STEP }
