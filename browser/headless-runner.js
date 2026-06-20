// OZ Browser — Headless recipe runner (V3-D, scraping/agent-control).
//
// Ejecuta un "recipe" de pasos de página bajo una identity, en modo headless.
// El `driver` se inyecta: es el objeto de page-handlers.js (navigate/click/
// type/getText/getAttr/queryAll/extract/eval/scroll/waitFor/screenshot/captcha),
// cada método con la firma `({ identityId, tabId, ...args })` y devolviendo el
// resultado o `{ __error: { code, message } }`. En tests se inyecta un fake.
//
// Reintentos: errores transitorios de un paso (red/timeout/navegación) se
// reintentan con backoff exponencial (scrape-retry.js). captcha/needs_login/
// fatales NO se reintentan. Un paso puede marcarse `optional:true` para no
// abortar el recipe si falla.
//
// Recipe (JSON):
//   { "steps": [ { "op": "navigate", "url": "https://..." },
//                { "op": "waitFor", "selector": ".feed" },
//                { "op": "extract", "name": "items", "schema": {...} } ] }
//
// Pieza testeable sin Electron (driver + clock inyectables). El bootstrap real
// (hidden window + page-handlers) vive en headless-setup.js.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

const { classifyError, buildRetryPolicy, backoffDelay } = require('./scrape-retry')

// Ops válidos = métodos esperados en el driver (page-handlers).
const VALID_OPS = [
  'navigate',
  'click',
  'type',
  'scroll',
  'waitFor',
  'getText',
  'getAttr',
  'queryAll',
  'extract',
  'eval',
  'screenshot',
  'captcha',
]

/**
 * Valida la forma de un recipe. No ejecuta nada.
 *
 * @param {any} recipe
 * @returns {{valid:boolean, errors:string[]}}
 */
function validateRecipe(recipe) {
  const errors = []
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { valid: false, errors: ['recipe must be an object'] }
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push('recipe.steps must be a non-empty array')
    return { valid: false, errors }
  }
  recipe.steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') {
      errors.push(`step ${i}: must be an object`)
      return
    }
    if (typeof step.op !== 'string' || VALID_OPS.indexOf(step.op) < 0) {
      errors.push(`step ${i}: unknown op '${step && step.op}'`)
    }
  })
  return { valid: errors.length === 0, errors }
}

/**
 * Convierte el resultado de un driver-op en un error si trae `__error`.
 * @returns {Error|null}
 */
function _errorFromResult(res) {
  if (res && typeof res === 'object' && res.__error) {
    const e = new Error(res.__error.message || res.__error.code || 'driver error')
    e.code = res.__error.code
    return e
  }
  return null
}

/**
 * Ejecuta un solo paso con reintentos. Devuelve `{ ok, result?, error?, attempts }`.
 */
async function _runStep({ driver, step, identityId, tabId, policy, clock, signal }) {
  const fn = driver[step.op]
  if (typeof fn !== 'function') {
    return {
      ok: false,
      error: { code: 'BAD_OP', message: `driver has no op ${step.op}` },
      attempts: 0,
    }
  }
  const args = Object.assign({}, step, { identityId, tabId })
  delete args.op
  delete args.optional

  let attempt = 0
  let lastErr
  while (attempt < policy.maxAttempts) {
    attempt++
    if (signal && signal.aborted) {
      return {
        ok: false,
        error: { code: 'aborted', message: 'aborted' },
        attempts: attempt,
      }
    }
    let res
    try {
      res = await fn(args)
    } catch (thrown) {
      res = {
        __error: { code: thrown && thrown.code, message: thrown && thrown.message },
      }
    }
    const err = _errorFromResult(res)
    if (!err) return { ok: true, result: res, attempts: attempt }
    lastErr = err
    const info = classifyError(err)
    const more = attempt < policy.maxAttempts && info.retryable
    if (!more) break
    if (clock && typeof clock.sleep === 'function') {
      await clock.sleep(backoffDelay(attempt, policy), signal)
    }
  }
  return {
    ok: false,
    error: { code: lastErr && lastErr.code, message: lastErr && lastErr.message },
    attempts: attempt,
  }
}

/**
 * Corre un recipe completo. Aborta en el primer paso no-opcional que falla.
 *
 * @param {object} args
 * @param {object} args.recipe
 * @param {object} args.driver       page-handlers (o fake).
 * @param {string} args.identityId
 * @param {string} [args.tabId]
 * @param {object} [args.retry]      opts de retry (scrape-retry policy).
 * @param {object} [args.clock]      { sleep(ms,signal) } inyectable.
 * @param {object} [args.signal]     AbortSignal-like.
 * @param {object} [args.logger]
 * @returns {Promise<{ok:boolean, steps:Array, data:object}>}
 */
async function runHeadlessRecipe({
  recipe,
  driver,
  identityId,
  tabId,
  retry,
  clock,
  signal,
  logger,
}) {
  const v = validateRecipe(recipe)
  if (!v.valid) return { ok: false, steps: [], data: {}, errors: v.errors }
  if (!identityId)
    return { ok: false, steps: [], data: {}, errors: ['identityId required'] }

  const policy = buildRetryPolicy(retry)
  const steps = []
  const data = {}
  let ok = true

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]
    const outcome = await _runStep({
      driver,
      step,
      identityId,
      tabId,
      policy,
      clock,
      signal,
    })
    steps.push({
      index: i,
      op: step.op,
      ok: outcome.ok,
      attempts: outcome.attempts,
      error: outcome.error || null,
    })
    if (logger && typeof logger.info === 'function') {
      logger.info('headless', 'step done', { index: i, op: step.op, ok: outcome.ok })
    }
    if (outcome.ok) {
      if (step.name && outcome.result != null) data[step.name] = outcome.result
    } else if (!step.optional) {
      ok = false
      break // hard stop on a required step failure
    }
  }

  return { ok, steps, data }
}

module.exports = { runHeadlessRecipe, validateRecipe, VALID_OPS }
