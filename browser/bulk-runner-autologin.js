// OZ Browser — Bulk Runner auto-login retry wrapper (v2 sub-bloque 4).
//
// Cuando la action retorna needs_login, este módulo intenta loguear la
// identity y retry-ea la action UNA vez. Extraído de bulk-runner.js para
// mantener el motor bajo el LOC budget.
//
// Composable: bulk-runner llama `tryLoginAndRetry(...)` solo cuando ya
// detectó el needs_login error. Esto no se mete en el happy path.
//
// Doc: docs/modules/bulk-runner.md (sección "Auto-login retry")

'use strict'

const { spawnIdentityWindow, safeClose } = require('./bulk-action-browser-helpers')
const { attemptLogin } = require('./bulk-action-login')

/**
 * Run the auto-login flow then retry action.run() once.
 *
 * Inputs (passed from bulk-runner):
 *   - action: registry entry with run() + platform
 *   - identity: the OZ identity record
 *   - params: original action params
 *   - ctx: same ctx the action received
 *   - deps: {
 *       identityManager,
 *       accountsAPI,
 *       electron,           // optional; defaults to require('electron')
 *       logger,
 *       timeoutMs?,         // login attempt timeout
 *       attemptLoginFn?,    // override for tests
 *     }
 *
 * Returns:
 *   { loginAttempt: {ok, code?, accountId?, durationMs},
 *     retried: boolean,
 *     result?: any,            // only if retried + ok
 *     retryError?: Error }     // only if retried + failed
 *
 * Never throws — wraps internal failures into the loginAttempt object.
 */
async function tryLoginAndRetry({ action, identity, params, ctx, deps }) {
  const platform = action && action.platform
  // accountsAPI can be passed as a function (lazy lookup) — runner setup
  // wires it that way because account handlers are built AFTER the runner.
  let accountsAPI = deps && deps.accountsAPI
  if (typeof accountsAPI === 'function') accountsAPI = accountsAPI()
  const logger = (deps && deps.logger) || _silentLogger()

  if (!platform) {
    return {
      loginAttempt: {
        ok: false,
        code: 'unsupported-platform',
        message: 'action has no platform field',
        durationMs: 0,
      },
      retried: false,
    }
  }
  if (!accountsAPI) {
    return {
      loginAttempt: {
        ok: false,
        code: 'no-credentials',
        message: 'accountsAPI not configured in runner',
        durationMs: 0,
      },
      retried: false,
    }
  }

  const electron = (deps && deps.electron) || _tryRequireElectron()
  const identityManager = deps && deps.identityManager

  let loginWin = null
  let loginResult
  try {
    loginWin = await spawnIdentityWindow({
      identityManager,
      identityId: identity.id,
      signal: ctx && ctx.signal,
      electron,
    })
    const attemptLoginImpl = (deps && deps.attemptLoginFn) || attemptLogin
    loginResult = await attemptLoginImpl(loginWin, {
      platform,
      identityId: identity.id,
      accountsAPI,
      timeoutMs: (deps && deps.timeoutMs) || 60_000,
      signal: ctx && ctx.signal,
    })
  } catch (err) {
    loginResult = {
      ok: false,
      code: 'login-failed',
      message: `login window spawn/run threw: ${err.message}`,
      durationMs: 0,
    }
  } finally {
    if (loginWin) safeClose(loginWin)
  }

  logger.info('bulk-runner', 'auto-login attempt result', {
    identityId: identity.id,
    platform,
    ok: loginResult.ok,
    code: loginResult.code || null,
    durationMs: loginResult.durationMs,
  })

  if (!loginResult.ok) {
    return { loginAttempt: loginResult, retried: false }
  }

  // Login OK — retry the action ONCE.
  try {
    const retryResult = await action.run(identity, params, ctx)
    return {
      loginAttempt: loginResult,
      retried: true,
      result: retryResult,
    }
  } catch (retryErr) {
    return {
      loginAttempt: loginResult,
      retried: true,
      retryError: retryErr,
    }
  }
}

function _tryRequireElectron() {
  try {
    return require('electron')
  } catch (_e) {
    return null
  }
}

function _silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

module.exports = {
  tryLoginAndRetry,
}
