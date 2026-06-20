// OZ Browser — Retry / backoff helpers (V3-D, scraping/agent-control).
//
// Clasifica errores por clase y calcula el delay de backoff exponencial con
// jitter para reintentar acciones transitorias durante un scrape/orquestación.
//
// Política (ver docs/PLAN-V3-SCRAPING.md §3 V3-D):
//   - Reintentamos SOLO errores transitorios (red, timeout, navegación).
//   - NO reintentamos clases que requieren intervención: captcha (humano),
//     needs_login (lo maneja la capa de auto-login del bulk runner),
//     rate-limit (se skipea aguas arriba), aborted (cancelación del usuario),
//     ni errores fatales de programación (TypeError/ReferenceError/Syntax).
//
// Piezas PURAS (sin Electron/DOM/fs): este archivo es 100% testeable en node.
// El glue que envuelve action.run vive en bulk-runner-retry.js; la integración
// en el loop vive en bulk-runner.js.
//
// ADR: 0030 (bulk-runner) · 0005 (modular) · 0036 (page-control).

'use strict'

// Clases que NUNCA reintenta esta capa (requieren otra acción o son fatales).
const NON_RETRYABLE_CLASSES = ['captcha', 'needs_login', 'rate-limit', 'aborted', 'fatal']

const DEFAULTS = Object.freeze({
  maxAttempts: 3, // total de intentos (1 original + 2 reintentos)
  baseMs: 1000,
  factor: 2,
  maxMs: 30_000,
  jitter: true,
  // null = todas las clases retryables; o un array para restringir.
  retryClasses: null,
})

/**
 * Clasifica un error en una clase estable y dice si es reintentable.
 *
 * @param {any} err  Error, objeto {code,message,name} o string.
 * @returns {{class:string, retryable:boolean}}
 */
function classifyError(err) {
  if (err == null) return { class: 'unknown', retryable: true }

  const code = (err && typeof err === 'object' && err.code) || ''
  const name = (err && typeof err === 'object' && err.name) || ''
  const message =
    typeof err === 'string'
      ? err
      : (err && typeof err === 'object' && (err.message || '')) || String(err)

  // 1) Códigos explícitos de nuestras propias capas.
  const codeStr = String(code)
  if (codeStr === 'needs_login') return _cls('needs_login')
  if (codeStr === 'rate-limit') return _cls('rate-limit')
  if (codeStr === 'captcha') return _cls('captcha')

  // 2) Cancelación / abort.
  if (name === 'AbortError' || /\baborted\b/i.test(message)) return _cls('aborted')

  // 3) Errores fatales de programación → no tiene sentido reintentar.
  if (name === 'TypeError' || name === 'ReferenceError' || name === 'SyntaxError') {
    return _cls('fatal')
  }

  // 4) Captcha por mensaje (defensivo).
  if (/captcha|challenge|are you a robot|verify you('| a)re human/i.test(message)) {
    return _cls('captcha')
  }

  // 5) Timeout.
  if (
    /timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT|deadline/i.test(message) ||
    codeStr === 'ETIMEDOUT'
  ) {
    return _cls('timeout')
  }

  // 6) Red / proxy / DNS / conexión.
  if (
    /net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|tunnel|proxy|ERR_PROXY|ERR_CONNECTION|ERR_NETWORK|ERR_NAME_NOT_RESOLVED/i.test(
      message,
    ) ||
    /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(codeStr)
  ) {
    return _cls('network')
  }

  // 7) Navegación.
  if (
    /navigation|ERR_ABORTED|frame was detached|cannot navigate|navigation failed/i.test(
      message,
    )
  ) {
    return _cls('navigation')
  }

  // 8) Desconocido → reintentable conservadoramente (transitorio probable).
  return _cls('unknown')
}

function _cls(klass) {
  return { class: klass, retryable: NON_RETRYABLE_CLASSES.indexOf(klass) < 0 }
}

/**
 * Normaliza opciones parciales a una policy completa. Tolera basura.
 *
 * @param {object|null} opts
 * @returns {{maxAttempts:number, baseMs:number, factor:number, maxMs:number, jitter:boolean, retryClasses:(string[]|null)}}
 */
function buildRetryPolicy(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const maxAttempts = _posInt(o.maxAttempts, DEFAULTS.maxAttempts)
  return {
    maxAttempts: Math.max(1, maxAttempts),
    baseMs: _posNum(o.baseMs, DEFAULTS.baseMs),
    factor: _posNum(o.factor, DEFAULTS.factor),
    maxMs: _posNum(o.maxMs, DEFAULTS.maxMs),
    jitter: o.jitter == null ? DEFAULTS.jitter : !!o.jitter,
    retryClasses: Array.isArray(o.retryClasses) ? o.retryClasses.slice() : null,
  }
}

/**
 * Delay de backoff exponencial (con equal-jitter por defecto) para el intento
 * `attempt` (1-based: el delay que se espera DESPUÉS de que falle el intento N,
 * antes del intento N+1).
 *
 * Equal jitter: mitad determinística + mitad aleatoria → suaviza thundering
 * herd sin que el delay colapse a ~0.
 *
 * @param {number} attempt  1-based.
 * @param {object} [opts]   {baseMs, factor, maxMs, jitter, rng}
 * @returns {number} ms (entero >= 0)
 */
function backoffDelay(attempt, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const baseMs = _posNum(o.baseMs, DEFAULTS.baseMs)
  const factor = _posNum(o.factor, DEFAULTS.factor)
  const maxMs = _posNum(o.maxMs, DEFAULTS.maxMs)
  const jitter = o.jitter == null ? DEFAULTS.jitter : !!o.jitter
  const rng = typeof o.rng === 'function' ? o.rng : Math.random

  const n = Math.max(1, _posInt(attempt, 1))
  const raw = baseMs * Math.pow(factor, n - 1)
  const capped = Math.min(raw, maxMs)
  if (!jitter) return Math.round(capped)
  const half = capped / 2
  return Math.round(half + rng() * half)
}

/**
 * ¿Conviene reintentar este error tras `attempt` intentos ya hechos?
 *
 * @param {any} err
 * @param {number} attempt  Número de intentos YA ejecutados (1-based).
 * @param {object} policy   Resultado de buildRetryPolicy().
 * @returns {boolean}
 */
function shouldRetry(err, attempt, policy) {
  const p = policy && typeof policy === 'object' ? policy : DEFAULTS
  const done = _posInt(attempt, 1)
  if (done >= p.maxAttempts) return false
  const info = classifyError(err)
  if (!info.retryable) return false
  if (Array.isArray(p.retryClasses) && p.retryClasses.indexOf(info.class) < 0) {
    return false
  }
  return true
}

// ---------- internals --------------------------------------------------------

function _posInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function _posNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

module.exports = {
  classifyError,
  buildRetryPolicy,
  backoffDelay,
  shouldRetry,
  NON_RETRYABLE_CLASSES,
  DEFAULTS,
}
