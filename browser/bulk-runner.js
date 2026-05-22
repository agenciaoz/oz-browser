// OZ Browser — Bulk Runner (v2 sub-bloque 1).
//
// Motor que ejecuta una action registrada (ver bulk-actions-registry.js)
// sobre N identities en orden, con delays randomizados anti-detect,
// reportando progreso per-identity y persistiendo state para survive a
// restarts.
//
// Pattern de uso desde main:
//   const runner = new BulkRunner({ userDataDir, identityManager, registry })
//   const runId = await runner.create({ actionId: 'echo', identityIds: [...], params: {} })
//   await runner.start(runId)                  // dispara la ejecución async
//   runner.on('progress', ({ runId, item }) => …)
//   await runner.cancel(runId)                 // gentle: para entre identities
//   runner.get(runId) → { meta, items: [...] }
//
// Persistencia: cada run vive en `userData/bulk-runs/<runId>.json`. Atómico
// vía tmp+rename. Si OZ se cae a mitad, el run queda en disco con su
// last-known state — un futuro sub-bloque puede agregar resume; por ahora,
// inspección post-mortem.
//
// Concurrency: secuencial dentro de un run (anti-detect). Multiple runs
// pueden correr en paralelo hasta MAX_CONCURRENT_RUNS.
//
// Spread temporal entre identities: delay aleatorio en [MIN_DELAY_MS,
// MAX_DELAY_MS], saltado para el primer item. Override via options.delays.
//
// Cancellation: gentle. `cancel(runId)` setea signal.abort() y marca el
// run como 'cancelling'. La identity en curso recibe la signal — puede
// terminar o abortar. Identities restantes se marcan 'cancelled'.
//
// Doc: docs/modules/bulk-runner.md
// ADR: docs/architecture/0030-bulk-runner.md

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const SCHEMA_VERSION = 1
const MAX_IDENTITIES_PER_RUN = 200
const MAX_CONCURRENT_RUNS = 5
const DEFAULT_MIN_DELAY_MS = 30_000 // 30s
const DEFAULT_MAX_DELAY_MS = 90_000 // 90s
const STATUS_PENDING = 'pending'
const STATUS_RUNNING = 'running'
const STATUS_DONE = 'done'
const STATUS_FAILED = 'failed'
const STATUS_CANCELLED = 'cancelled'
const STATUS_SKIPPED = 'skipped'

const RUN_STATUS_CREATED = 'created'
const RUN_STATUS_RUNNING = 'running'
const RUN_STATUS_COMPLETED = 'completed'
const RUN_STATUS_FAILED = 'failed'
const RUN_STATUS_CANCELLING = 'cancelling'
const RUN_STATUS_CANCELLED = 'cancelled'

class BulkRunnerError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'BulkRunnerError'
  }
}

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function _randomBetween(min, max) {
  return min + Math.random() * (max - min)
}

function _atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

class BulkRunner extends EventEmitter {
  constructor(opts = {}) {
    super()
    if (!opts.userDataDir) throw new Error('BulkRunner: userDataDir required')
    if (!opts.identityManager) {
      throw new Error('BulkRunner: identityManager required')
    }
    if (!opts.registry) throw new Error('BulkRunner: registry required')
    this.userDataDir = opts.userDataDir
    this.identityManager = opts.identityManager
    this.registry = opts.registry
    this.runsDir = path.join(this.userDataDir, 'bulk-runs')
    this.logger = opts.logger || _silentLogger()
    // `clock` allows tests to fake delay timers.
    this.clock = opts.clock || _realClock()
    fs.mkdirSync(this.runsDir, { recursive: true })
    // Cache: runId → { meta, items, controller? }
    this._runs = new Map()
    this._loadAllFromDisk()
  }

  // ---------- public API -----------------------------------------------------

  /**
   * Create a new bulk run. Persists state. Does NOT start execution — call
   * `start(runId)` to dispatch.
   * Returns the runId (string).
   */
  async create({ actionId, identityIds, params = {}, options = {} } = {}) {
    if (typeof actionId !== 'string' || !actionId) {
      throw new BulkRunnerError('actionId required', 'BAD_ACTION_ID')
    }
    const action = this.registry.get(actionId)
    if (!action) {
      throw new BulkRunnerError(`action not registered: ${actionId}`, 'UNKNOWN_ACTION')
    }
    if (!Array.isArray(identityIds) || identityIds.length === 0) {
      throw new BulkRunnerError('identityIds must be a non-empty array', 'BAD_IDENTITIES')
    }
    if (identityIds.length > MAX_IDENTITIES_PER_RUN) {
      throw new BulkRunnerError(
        `identityIds exceeds cap of ${MAX_IDENTITIES_PER_RUN}`,
        'CAP_EXCEEDED',
      )
    }
    if (!_isPlainObject(params)) {
      throw new BulkRunnerError('params must be an object', 'BAD_PARAMS')
    }
    if (!_isPlainObject(options)) {
      throw new BulkRunnerError('options must be an object', 'BAD_OPTIONS')
    }
    const minDelay = Number(
      options.minDelayMs != null ? options.minDelayMs : DEFAULT_MIN_DELAY_MS,
    )
    const maxDelay = Number(
      options.maxDelayMs != null ? options.maxDelayMs : DEFAULT_MAX_DELAY_MS,
    )
    if (!Number.isFinite(minDelay) || minDelay < 0) {
      throw new BulkRunnerError('minDelayMs must be >= 0', 'BAD_DELAY')
    }
    if (!Number.isFinite(maxDelay) || maxDelay < minDelay) {
      throw new BulkRunnerError('maxDelayMs must be >= minDelayMs', 'BAD_DELAY')
    }
    // Resolve identities: must all exist. Order from input is preserved.
    const items = []
    const seen = new Set()
    for (const id of identityIds) {
      if (seen.has(id)) {
        throw new BulkRunnerError(`duplicate identityId: ${id}`, 'DUPLICATE_ID')
      }
      seen.add(id)
      const identity = this.identityManager.get(id)
      if (!identity) {
        throw new BulkRunnerError(`identity not found: ${id}`, 'UNKNOWN_IDENTITY')
      }
      items.push({
        identityId: identity.id,
        identityName: identity.name,
        status: STATUS_PENDING,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      })
    }
    // Cap concurrent active runs.
    const activeCount = this._activeRunCount()
    if (activeCount >= MAX_CONCURRENT_RUNS) {
      throw new BulkRunnerError(
        `max concurrent runs reached (${MAX_CONCURRENT_RUNS})`,
        'CONCURRENT_CAP',
      )
    }
    const runId = _newRunId()
    const meta = {
      runId,
      schemaVersion: SCHEMA_VERSION,
      actionId,
      actionLabel: action.label,
      params,
      options: { minDelayMs: minDelay, maxDelayMs: maxDelay },
      identityCount: items.length,
      status: RUN_STATUS_CREATED,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      stats: { done: 0, failed: 0, skipped: 0, cancelled: 0 },
    }
    const record = { meta, items }
    this._runs.set(runId, { ...record, controller: null, _runningPromise: null })
    this._persist(runId)
    this.logger.info('bulk-runner', 'run created', {
      runId,
      actionId,
      identityCount: items.length,
    })
    this.emit('created', { runId, meta: { ...meta } })
    return runId
  }

  /**
   * Start executing a previously-created run. Returns immediately; the run
   * proceeds in the background. Listen to 'progress' / 'completed' events.
   */
  start(runId) {
    const r = this._runs.get(runId)
    if (!r) throw new BulkRunnerError(`unknown run: ${runId}`, 'UNKNOWN_RUN')
    if (r.meta.status !== RUN_STATUS_CREATED) {
      throw new BulkRunnerError(
        `run ${runId} cannot start from status '${r.meta.status}'`,
        'BAD_STATE',
      )
    }
    r.controller = new AbortController()
    r.meta.status = RUN_STATUS_RUNNING
    r.meta.startedAt = new Date().toISOString()
    this._persist(runId)
    this.emit('started', { runId, meta: { ...r.meta } })
    r._runningPromise = this._runLoop(runId).catch((err) => {
      this.logger.error('bulk-runner', 'run loop crashed', {
        runId,
        message: err.message,
        stack: err.stack,
      })
    })
    return r._runningPromise
  }

  /**
   * Convenience: create + start in one call. Returns runId. Use when you
   * don't need to inspect the created state before dispatching.
   */
  async run(spec) {
    const runId = await this.create(spec)
    this.start(runId)
    return runId
  }

  /**
   * Gentle cancel — sets the abort signal and marks future items as
   * cancelled. The in-flight item gets the signal; whether it aborts is
   * up to the action handler.
   */
  cancel(runId) {
    const r = this._runs.get(runId)
    if (!r) throw new BulkRunnerError(`unknown run: ${runId}`, 'UNKNOWN_RUN')
    if (r.meta.status !== RUN_STATUS_RUNNING) {
      // Idempotent for already-cancelled / completed runs.
      return false
    }
    r.meta.status = RUN_STATUS_CANCELLING
    if (r.controller) r.controller.abort()
    this._persist(runId)
    this.emit('cancelling', { runId })
    return true
  }

  /** Get a deep copy of the run record (safe to expose to UI). */
  get(runId) {
    const r = this._runs.get(runId)
    if (!r) return null
    return {
      meta: { ...r.meta, stats: { ...r.meta.stats } },
      items: r.items.map((it) => ({ ...it })),
    }
  }

  /** Return summary metadata for every known run, newest first. */
  list() {
    const all = []
    for (const r of this._runs.values()) {
      all.push({ ...r.meta, stats: { ...r.meta.stats } })
    }
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return all
  }

  /**
   * Wait until the run reaches a terminal status. Returns the final record.
   */
  async waitFor(runId) {
    const r = this._runs.get(runId)
    if (!r) throw new BulkRunnerError(`unknown run: ${runId}`, 'UNKNOWN_RUN')
    if (r._runningPromise) await r._runningPromise
    return this.get(runId)
  }

  // ---------- internal -------------------------------------------------------

  async _runLoop(runId) {
    const r = this._runs.get(runId)
    const action = this.registry.get(r.meta.actionId)
    if (!action) {
      r.meta.status = RUN_STATUS_FAILED
      r.meta.finishedAt = new Date().toISOString()
      this._persist(runId)
      this.emit('completed', { runId, meta: { ...r.meta } })
      return
    }
    const { minDelayMs, maxDelayMs } = r.meta.options
    for (let i = 0; i < r.items.length; i++) {
      // If cancellation came in, mark the rest as cancelled.
      if (r.controller && r.controller.signal.aborted) {
        for (let j = i; j < r.items.length; j++) {
          if (r.items[j].status === STATUS_PENDING) {
            r.items[j].status = STATUS_CANCELLED
            r.meta.stats.cancelled++
            this.emit('progress', {
              runId,
              item: { ...r.items[j] },
              index: j,
              total: r.items.length,
            })
          }
        }
        break
      }
      const item = r.items[i]
      const identity = this.identityManager.get(item.identityId)
      if (!identity) {
        item.status = STATUS_SKIPPED
        item.error = { message: 'identity vanished mid-run' }
        item.finishedAt = new Date().toISOString()
        r.meta.stats.skipped++
        this._persist(runId)
        this.emit('progress', {
          runId,
          item: { ...item },
          index: i,
          total: r.items.length,
        })
        continue
      }
      // Spread temporal — skip for the first item.
      if (i > 0 && maxDelayMs > 0) {
        const delay = _randomBetween(minDelayMs, maxDelayMs)
        await this.clock.sleep(delay, r.controller.signal)
        if (r.controller.signal.aborted) {
          // Mark this item + the rest as cancelled.
          for (let j = i; j < r.items.length; j++) {
            if (r.items[j].status === STATUS_PENDING) {
              r.items[j].status = STATUS_CANCELLED
              r.meta.stats.cancelled++
              this.emit('progress', {
                runId,
                item: { ...r.items[j] },
                index: j,
                total: r.items.length,
              })
            }
          }
          break
        }
      }
      item.status = STATUS_RUNNING
      item.startedAt = new Date().toISOString()
      this._persist(runId)
      this.emit('progress', {
        runId,
        item: { ...item },
        index: i,
        total: r.items.length,
      })
      try {
        const result = await action.run(identity, r.meta.params, {
          runId,
          identityIndex: i,
          totalIdentities: r.items.length,
          logger: this.logger,
          signal: r.controller.signal,
        })
        item.status = STATUS_DONE
        item.result = result == null ? null : result
        item.finishedAt = new Date().toISOString()
        r.meta.stats.done++
      } catch (err) {
        const aborted =
          (err && err.name === 'AbortError') ||
          (err && err.message === 'aborted') ||
          r.controller.signal.aborted
        item.status = aborted ? STATUS_CANCELLED : STATUS_FAILED
        item.error = { message: err && err.message ? err.message : String(err) }
        item.finishedAt = new Date().toISOString()
        if (aborted) r.meta.stats.cancelled++
        else r.meta.stats.failed++
      }
      this._persist(runId)
      this.emit('progress', {
        runId,
        item: { ...item },
        index: i,
        total: r.items.length,
      })
    }
    // Wrap up.
    if (r.controller && r.controller.signal.aborted) {
      r.meta.status = RUN_STATUS_CANCELLED
    } else if (r.meta.stats.failed > 0 && r.meta.stats.done === 0) {
      r.meta.status = RUN_STATUS_FAILED
    } else {
      r.meta.status = RUN_STATUS_COMPLETED
    }
    r.meta.finishedAt = new Date().toISOString()
    this._persist(runId)
    this.emit('completed', { runId, meta: { ...r.meta } })
  }

  _persist(runId) {
    const r = this._runs.get(runId)
    if (!r) return
    const out = {
      meta: r.meta,
      items: r.items,
    }
    _atomicWriteJson(path.join(this.runsDir, `${runId}.json`), out)
  }

  _loadAllFromDisk() {
    if (!fs.existsSync(this.runsDir)) return
    const files = fs.readdirSync(this.runsDir).filter((f) => f.endsWith('.json'))
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.runsDir, f), 'utf8'))
        if (!raw || !raw.meta || !raw.items) continue
        if (raw.meta.schemaVersion !== SCHEMA_VERSION) continue
        const runId = raw.meta.runId
        if (!runId) continue
        // Restore — but mark any 'running' run as 'failed' (process died).
        if (
          raw.meta.status === RUN_STATUS_RUNNING ||
          raw.meta.status === RUN_STATUS_CANCELLING
        ) {
          raw.meta.status = RUN_STATUS_FAILED
          raw.meta.finishedAt = raw.meta.finishedAt || new Date().toISOString()
          // Items still 'running' get bumped to 'failed' too.
          for (const it of raw.items) {
            if (it.status === STATUS_RUNNING) {
              it.status = STATUS_FAILED
              it.error = { message: 'process restarted mid-run' }
              it.finishedAt = it.finishedAt || new Date().toISOString()
            }
          }
        }
        this._runs.set(runId, {
          meta: raw.meta,
          items: raw.items,
          controller: null,
          _runningPromise: null,
        })
      } catch (_err) {
        // Skip corrupt files silently.
      }
    }
  }

  _activeRunCount() {
    let n = 0
    for (const r of this._runs.values()) {
      if (
        r.meta.status === RUN_STATUS_RUNNING ||
        r.meta.status === RUN_STATUS_CANCELLING
      ) {
        n++
      }
    }
    return n
  }
}

function _newRunId() {
  return 'br-' + crypto.randomBytes(8).toString('hex')
}

function _realClock() {
  return {
    sleep(ms, signal) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, ms)
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        }
      })
    },
  }
}

function _silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }
}

module.exports = {
  BulkRunner,
  BulkRunnerError,
  // Exposed for tests / handlers.
  STATUS_PENDING,
  STATUS_RUNNING,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_CANCELLED,
  STATUS_SKIPPED,
  RUN_STATUS_CREATED,
  RUN_STATUS_RUNNING,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CANCELLING,
  RUN_STATUS_CANCELLED,
}
