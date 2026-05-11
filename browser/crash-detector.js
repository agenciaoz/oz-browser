// OZ Browser — Crash detector (E2-C-2 fase 1).
//
// Qué hace: detecta si la sesión previa terminó limpiamente o crasheó usando
// un lockfile con PID. Al boot, si existe un lockfile cuyo PID ya NO está vivo
// (o cuyo JSON está corrupto), inferimos que la sesión anterior crasheó.
//
// Doc: docs/modules/crash-detector.md
// ADR: docs/architecture/0024-crash-recovery.md
//
// Cómo funciona:
//   1. init() lee userData/running.lock — si existe, evalúa el PID.
//      - PID vivo (proceso aún activo) + distinto al actual → multi-instance,
//        NO es crash, NO sobrescribimos.
//      - PID vivo + igual al actual → imposible bajo flujo normal; tratamos
//        como stale (probablemente fork raro o test).
//      - PID muerto (ESRCH) o JSON corrupto → wasCrashed=true.
//      - No existe → arranque limpio; wasCrashed=false.
//   2. Escribe lockfile nuevo con PID actual + startedAt + ozVersion.
//   3. markCleanShutdown() borra el lockfile — debe llamarse en before-quit
//      LATE, después de flushear todos los managers (workspace snapshot, etc).
//   4. Si el proceso muere sin llegar a markCleanShutdown(), el próximo boot
//      verá el lockfile + el PID muerto → reportará crash.
//
// API:
//   const cd = new CrashDetector({ userDataDir, ozVersion })
//   const { wasCrashed, multiInstance } = cd.init()
//   ...
//   cd.markCleanShutdown() // en before-quit
//
// Inyección para tests:
//   - procIsAlive(pid) — default usa process.kill(pid, 0); throw ESRCH = muerto.
//   - clock() — default Date.now(); usar fake en tests.

const fs = require('fs')
const path = require('path')
const log = require('./logger')

const LOCKFILE_NAME = 'running.lock'

function defaultProcIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 doesn't actually send a signal — it just checks reachability.
    // Throws ESRCH if the process doesn't exist, EPERM if it does but we
    // can't signal it (which still means: alive).
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err.code === 'EPERM') return true
    return false
  }
}

class CrashDetector {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir — Electron app.getPath('userData')
   * @param {string} [opts.ozVersion] — app.getVersion(), recorded in lockfile
   * @param {(pid:number)=>boolean} [opts.procIsAlive] — for tests
   * @param {()=>number} [opts.clock] — for tests; defaults to Date.now
   */
  constructor({ userDataDir, ozVersion, procIsAlive, clock } = {}) {
    if (!userDataDir) {
      throw new Error('CrashDetector: userDataDir is required')
    }
    this.userDataDir = userDataDir
    this.lockfilePath = path.join(userDataDir, LOCKFILE_NAME)
    this.ozVersion = ozVersion || 'unknown'
    this.procIsAlive = procIsAlive || defaultProcIsAlive
    this.clock = clock || (() => Date.now())
    this._initialized = false
    this._wasCrashed = false
    this._multiInstance = false
  }

  /**
   * Read existing lockfile (if any), classify state, then write a new
   * lockfile with the current PID. Returns:
   *   { wasCrashed, multiInstance, prior?: {pid,startedAt,ozVersion} }
   *
   * Idempotent: calling init() twice from the same process returns the same
   * answer (without re-classifying).
   */
  init() {
    if (this._initialized) {
      return {
        wasCrashed: this._wasCrashed,
        multiInstance: this._multiInstance,
        prior: this._prior || null,
      }
    }
    this._initialized = true
    this._wasCrashed = false
    this._multiInstance = false
    this._prior = null

    let prior = null
    let raw = null
    try {
      raw = fs.readFileSync(this.lockfilePath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('crash-detector', 'lockfile read failed', { message: err.message })
      }
    }

    if (raw) {
      try {
        prior = JSON.parse(raw)
      } catch (_err) {
        log.warn('crash-detector', 'lockfile JSON corrupt — treating as crash')
        this._wasCrashed = true
      }
    }

    if (prior && typeof prior === 'object') {
      this._prior = prior
      const priorPid = Number(prior.pid)
      if (!Number.isInteger(priorPid) || priorPid <= 0) {
        log.warn('crash-detector', 'lockfile has invalid PID — treating as crash', {
          priorPid: prior.pid,
        })
        this._wasCrashed = true
      } else if (priorPid === process.pid) {
        // Same PID — probably a fork or test re-init; treat as stale, not crash.
        log.info('crash-detector', 'lockfile PID matches current process — stale')
      } else if (this.procIsAlive(priorPid)) {
        // Another OZ instance is currently running. NOT a crash — this is a
        // legitimate concurrent run (rare in packaged builds thanks to the
        // single-instance lock in protocol-handler.js, but possible in dev or
        // when running tests in parallel).
        this._multiInstance = true
        log.info('crash-detector', 'multi-instance detected — prior PID alive', {
          priorPid,
          currentPid: process.pid,
        })
      } else {
        // PID dead — last session ended without markCleanShutdown().
        this._wasCrashed = true
        log.warn('crash-detector', 'crash detected — prior PID is dead', {
          priorPid,
          startedAt: prior.startedAt,
          ozVersion: prior.ozVersion,
        })
      }
    }

    // Write the new lockfile UNLESS multi-instance (don't clobber the live
    // sibling's lockfile — the original process owns it).
    if (!this._multiInstance) {
      const payload = {
        pid: process.pid,
        startedAt: new Date(this.clock()).toISOString(),
        ozVersion: this.ozVersion,
      }
      try {
        fs.mkdirSync(this.userDataDir, { recursive: true })
        fs.writeFileSync(this.lockfilePath, JSON.stringify(payload, null, 2))
        log.info('crash-detector', 'lockfile written', payload)
      } catch (err) {
        log.error('crash-detector', 'lockfile write failed', {
          message: err.message,
          path: this.lockfilePath,
        })
        // Continue — we just won't detect a crash if we crash now. Don't
        // throw: the user can still use the browser.
      }
    }

    return {
      wasCrashed: this._wasCrashed,
      multiInstance: this._multiInstance,
      prior: this._prior,
    }
  }

  /**
   * Delete the lockfile to mark this session as cleanly terminated.
   * Idempotent — safe to call twice or before init().
   *
   * Should be called LATE in app.before-quit, after all managers have flushed
   * their state. If we crash between init() and markCleanShutdown(), the
   * NEXT boot will detect it.
   */
  markCleanShutdown() {
    try {
      fs.unlinkSync(this.lockfilePath)
      log.info('crash-detector', 'clean shutdown marked — lockfile removed')
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return true // already gone, also fine
      log.warn('crash-detector', 'markCleanShutdown failed', {
        message: err.message,
      })
      return false
    }
  }

  /** True if init() detected a crash. False before init() runs. */
  wasCrashed() {
    return this._wasCrashed
  }

  /** True if init() detected another live OZ instance (rare). */
  isMultiInstance() {
    return this._multiInstance
  }
}

module.exports = { CrashDetector, LOCKFILE_NAME }
