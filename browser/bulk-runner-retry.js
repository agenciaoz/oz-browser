// OZ Browser — Bulk Runner retry helper (V3-D, scraping/agent-control).
//
// Envuelve la ejecución de una action con reintentos + backoff exponencial,
// usando las piezas puras de scrape-retry.js. Extraído del runner por el
// budget de LOC (ADR 0005), igual que bulk-runner-rate-limit.js.
//
// Respeta la señal de cancelación (AbortSignal) y usa el `clock` inyectable del
// runner para que los tests puedan fakear los delays (clock.sleep(ms, signal)).
//
// ADR: 0030 (bulk-runner) · 0005 (modular).

'use strict'

const {
  buildRetryPolicy,
  classifyError,
  backoffDelay,
  shouldRetry,
} = require('./scrape-retry')

/**
 * Ejecuta `runFn` con reintentos según `policyOpts`. Si no hay policy (o
 * maxAttempts<=1) se comporta como un único intento (cero overhead, preserva
 * el comportamiento histórico del runner).
 *
 * @param {object} args
 * @param {(attempt:number)=>Promise<any>} args.runFn  recibe el nº de intento.
 * @param {object|null} args.policyOpts  opciones crudas (se normalizan acá).
 * @param {{sleep:(ms:number,signal?:any)=>Promise<void>}} [args.clock]
 * @param {{aborted:boolean}} [args.signal]
 * @param {(info:{attempt:number,nextDelayMs:number,errorClass:string,error:any})=>void} [args.onRetry]
 * @returns {Promise<{result:any, attempts:number}>}
 * @throws el último error si se agotan los intentos o no es reintentable.
 */
async function runWithRetry({ runFn, policyOpts, clock, signal, onRetry }) {
  const policy = buildRetryPolicy(policyOpts)
  let attempt = 0
  let lastErr

  while (attempt < policy.maxAttempts) {
    attempt++
    if (signal && signal.aborted) throw _abortError()
    try {
      const result = await runFn(attempt)
      return { result, attempts: attempt }
    } catch (err) {
      lastErr = err
      if (!shouldRetry(err, attempt, policy)) break
      const nextDelayMs = backoffDelay(attempt, policy)
      if (typeof onRetry === 'function') {
        onRetry({
          attempt,
          nextDelayMs,
          errorClass: classifyError(err).class,
          error: err,
        })
      }
      if (clock && typeof clock.sleep === 'function') {
        await clock.sleep(nextDelayMs, signal)
      }
    }
  }

  const e = lastErr != null ? lastErr : new Error('runWithRetry: no attempts executed')
  if (e && typeof e === 'object') {
    try {
      e.retryAttempts = attempt
    } catch (_ignore) {
      /* frozen error — ignore */
    }
  }
  throw e
}

function _abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

/**
 * Ejecuta un item del bulk runner con (o sin) retry y normaliza el resultado a
 * `{ result, error }` para que el loop del runner quede mínimo. Setea
 * `item.attempts` cuando hubo más de un intento. Nunca lanza: devuelve el error
 * en `.error` (igual que el try/catch histórico del runner).
 *
 * @param {object} args
 * @param {()=>Promise<any>} args.runFn
 * @param {object|null} args.retryOpts  null = un único intento (comportamiento histórico).
 * @param {{sleep:Function}} [args.clock]
 * @param {{aborted:boolean}} [args.signal]
 * @param {{warn?:Function}} [args.logger]
 * @param {string} [args.runId]
 * @param {{identityId?:string, attempts?:number}} [args.item]
 * @returns {Promise<{result:any, error:any}>}
 */
async function executeItemWithRetry({
  runFn,
  retryOpts,
  clock,
  signal,
  logger,
  runId,
  item,
}) {
  if (!retryOpts) {
    try {
      return { result: await runFn(), error: null }
    } catch (error) {
      return { result: undefined, error }
    }
  }
  try {
    const outcome = await runWithRetry({
      runFn,
      policyOpts: retryOpts,
      clock,
      signal,
      onRetry: ({ attempt, nextDelayMs, errorClass }) => {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('bulk-runner', 'retrying item', {
            runId,
            identityId: item && item.identityId,
            attempt,
            nextDelayMs,
            errorClass,
          })
        }
      },
    })
    if (item && outcome.attempts > 1) item.attempts = outcome.attempts
    return { result: outcome.result, error: null }
  } catch (error) {
    if (item && error && error.retryAttempts > 1) item.attempts = error.retryAttempts
    return { result: undefined, error }
  }
}

module.exports = { runWithRetry, executeItemWithRetry }
