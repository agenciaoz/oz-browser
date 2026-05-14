// OZ Browser — Scheduled Actions (Bloque F-1, v1).
//
// Cron-lite scheduler for "wake-up routines" — periodic, deterministic
// tasks that an OZ operator wants to run on a schedule WITHOUT writing
// any code or running shell crons. v1 use cases (handlers wired in F-2):
//   - `open-workspace` — bring a workspace to foreground at HH:MM
//   - `sync-push` — force a sync push (e.g. nightly)
//   - `backup-snapshot` — take an encrypted Time Machine snapshot
//
// NON-GOALS (this is v1 — internal agency tool, not v2 automation engine):
//   - Comment / posting automation → that's v2 (`docs/PLAN-AUTOMATION-F-K.md`).
//   - Multi-step recipes → also v2.
//   - Sub-minute precision — the runner ticks at 60s, schedule resolution
//     is "minute-granularity good enough for humans".
//
// Storage: `userData/scheduled-actions.json` (atomic tmp+rename, like
//   sync-queue). Schema versioned. Bad JSON / schema mismatch → start
//   fresh + emit `'warn'` (same policy as sync-queue / sync-state).
//
// Schedule shapes (validated up front, stored verbatim):
//   { type: 'every-minutes', minutes: <int 1..1440> }
//   { type: 'daily',          time: 'HH:MM' }           // local time
//   { type: 'weekly',         day: 'mon'..'sun', time: 'HH:MM' }
//
// Time math is pure (`computeNextRunAt(schedule, lastRunAt, now, createdAt)`),
// so tests don't have to wait wall-clock. The runner (`tick(nowMs)`) is
// also test-driven by passing an explicit clock — see the smoketest for
// the full pattern.
//
// Concurrency: at most ONE handler can be in-flight per action at a time
// (a re-tick mid-handler skips already-running actions and logs a warn).
// Two different actions can be in-flight simultaneously — F-2 handlers
// are expected to be idempotent. `stop()` resolves once all in-flight
// handlers settle, so `before-quit` ordering in main.js stays clean.
//
// Spec: see `docs/PLAN-AUTOMATION-F-K.md` §F0 for the "v1 simple cron"
// carveout (the v2 ActionRunner replaces this module wholesale; v1 ships
// the dumb-but-honest version).

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const SCHEMA_VERSION = 1
// Cap so a corrupt file or buggy import can't blow the heap.
const MAX_ACTIONS = 200
const MAX_NAME_LEN = 100
const MAX_ACTION_LEN = 64
// Default runner cadence. 60s gives minute-precision schedules a sane
// floor; tests override via `tick(now)` instead of waiting.
const DEFAULT_TICK_MS = 60_000
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

class ScheduledActionsError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'ScheduledActionsError'
  }
}

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function _validateTimeHHMM(s) {
  if (typeof s !== 'string' || !/^[0-2]\d:[0-5]\d$/.test(s)) return false
  const [hStr, mStr] = s.split(':')
  const h = Number(hStr)
  const m = Number(mStr)
  return h >= 0 && h <= 23 && m >= 0 && m <= 59
}

function _validateSchedule(sched) {
  if (!_isPlainObject(sched)) {
    throw new ScheduledActionsError('schedule must be an object', 'BAD_SCHEDULE')
  }
  if (sched.type === 'every-minutes') {
    if (!Number.isInteger(sched.minutes) || sched.minutes < 1 || sched.minutes > 1440) {
      throw new ScheduledActionsError(
        'every-minutes.minutes must be integer 1..1440',
        'BAD_MINUTES',
      )
    }
    return
  }
  if (sched.type === 'daily') {
    if (!_validateTimeHHMM(sched.time)) {
      throw new ScheduledActionsError('daily.time must be HH:MM', 'BAD_TIME')
    }
    return
  }
  if (sched.type === 'weekly') {
    if (typeof sched.day !== 'string' || !DAYS.includes(sched.day)) {
      throw new ScheduledActionsError(
        `weekly.day must be one of ${DAYS.join(',')}`,
        'BAD_DAY',
      )
    }
    if (!_validateTimeHHMM(sched.time)) {
      throw new ScheduledActionsError('weekly.time must be HH:MM', 'BAD_TIME')
    }
    return
  }
  throw new ScheduledActionsError(
    `unknown schedule.type ${JSON.stringify(sched.type)}`,
    'BAD_SCHEDULE_TYPE',
  )
}

function _validateActionShape(a) {
  if (!_isPlainObject(a)) {
    throw new ScheduledActionsError('action must be an object', 'BAD_ACTION')
  }
  if (typeof a.name !== 'string' || a.name.length < 1 || a.name.length > MAX_NAME_LEN) {
    throw new ScheduledActionsError(`name must be string 1..${MAX_NAME_LEN}`, 'BAD_NAME')
  }
  if (
    typeof a.action !== 'string' ||
    a.action.length < 1 ||
    a.action.length > MAX_ACTION_LEN
  ) {
    throw new ScheduledActionsError(
      `action must be string 1..${MAX_ACTION_LEN}`,
      'BAD_ACTION_NAME',
    )
  }
  if (a.params !== undefined && !_isPlainObject(a.params)) {
    throw new ScheduledActionsError('params must be a plain object', 'BAD_PARAMS')
  }
  _validateSchedule(a.schedule)
  if (typeof a.enabled !== 'boolean') {
    throw new ScheduledActionsError('enabled must be boolean', 'BAD_ENABLED')
  }
}

function _cloneAction(a) {
  // Deep-ish clone — actions are tiny + serializable.
  return JSON.parse(JSON.stringify(a))
}

// ---------- Pure time math ---------------------------------------------------

/**
 * Compute the next-run epoch-ms for `schedule`, given when the action last
 * ran (`lastRunAt` ms or null), the current wall clock (`now` ms), and the
 * action's createdAt (ms) as the anchor for `every-minutes` first-fire.
 *
 * Pure function — no Date.now(), no side effects. Callers pass `now`.
 *
 * Semantics:
 *   - every-minutes: anchor = lastRunAt ?? createdAt; next = anchor + N*60000.
 *     If next <= now we still return it (the runner will fire on the next
 *     tick and advance lastRunAt). Cron-style "catch up exactly once after
 *     a long sleep" — we do NOT replay missed runs.
 *   - daily HH:MM (local time): smallest timestamp ≥ now whose local
 *     wall-clock matches HH:MM. If lastRunAt is on the same calendar day
 *     ≥ today's HH:MM, push to tomorrow's HH:MM.
 *   - weekly DAY HH:MM (local time): same idea, but locked to a weekday.
 *
 * Returns an epoch-ms integer (may be ≤ now → fire on next tick).
 */
function computeNextRunAt(schedule, lastRunAt, now, createdAt) {
  if (schedule.type === 'every-minutes') {
    const anchor = lastRunAt != null ? lastRunAt : createdAt
    return anchor + schedule.minutes * 60_000
  }
  if (schedule.type === 'daily') {
    return _nextWallClock(schedule.time, now, lastRunAt, /*weekday*/ null)
  }
  if (schedule.type === 'weekly') {
    return _nextWallClock(
      schedule.time,
      now,
      lastRunAt,
      /*weekday*/ DAYS.indexOf(schedule.day),
    )
  }
  // Defense-in-depth — validateSchedule should have caught this.
  throw new ScheduledActionsError(
    `unknown schedule.type ${JSON.stringify(schedule.type)}`,
    'BAD_SCHEDULE_TYPE',
  )
}

function _nextWallClock(timeHHMM, now, lastRunAt, weekday) {
  const [hStr, mStr] = timeHHMM.split(':')
  const targetH = Number(hStr)
  const targetM = Number(mStr)

  // Start from today's HH:MM in the LOCAL timezone of the runtime.
  const d = new Date(now)
  d.setHours(targetH, targetM, 0, 0)
  let candidate = d.getTime()

  // If the candidate is already past, push forward day-by-day.
  // We also push if it equals lastRunAt (no double-fire on the same slot).
  const sameAsLast = lastRunAt != null && candidate === lastRunAt
  if (candidate < now || sameAsLast) {
    candidate += 86_400_000 // +1 day
  }

  if (weekday == null) {
    // daily — done
    return candidate
  }

  // Weekly — advance until the local weekday matches.
  // Cap at 7 iterations to be safe.
  for (let i = 0; i < 7; i++) {
    const wd = new Date(candidate).getDay() // 0..6 (Sun..Sat)
    if (wd === weekday) return candidate
    candidate += 86_400_000
  }
  // Should never reach here unless weekday is out of range — defensive.
  throw new ScheduledActionsError(
    `failed to find weekday ${weekday} within 7 days`,
    'WEEKDAY_NOT_FOUND',
  )
}

// ---------- Store + runner ---------------------------------------------------

class ScheduledActions extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.filePath - userData/scheduled-actions.json (tmp in tests)
   * @param {() => number} [opts.clock] - epoch-ms clock (default Date.now)
   * @param {Record<string, (params, ctx) => Promise<any>>} [opts.handlers] - F-2 plug-ins
   * @param {(id: string) => string} [opts.idGen] - test seam
   */
  constructor(opts = {}) {
    super()
    if (!opts.filePath || typeof opts.filePath !== 'string') {
      throw new ScheduledActionsError('filePath required', 'BAD_ARG')
    }
    this.filePath = opts.filePath
    this._clock = opts.clock || (() => Date.now())
    this._handlers = opts.handlers || {}
    this._idGen = opts.idGen || (() => crypto.randomUUID())
    // Map preserves insertion order → list() is stable.
    this._actions = new Map()
    this._loaded = false
    // Reentrancy guard per action id (prevents overlapping firings).
    this._inFlight = new Set()
    // setInterval handle.
    this._timer = null
    this._stopped = false
  }

  // -------- Persistence -----------------------------------------------------

  load() {
    if (this._loaded) return this
    this._loaded = true

    if (!fs.existsSync(this.filePath)) return this

    let raw
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      this.emit('warn', { reason: 'read-failed', message: err.message })
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.emit('warn', { reason: 'parse-failed', message: err.message })
      return this
    }
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(parsed.actions)
    ) {
      this.emit('warn', {
        reason: 'schema-mismatch',
        seenSchemaVersion: parsed && parsed.schemaVersion,
      })
      return this
    }

    for (const a of parsed.actions) {
      try {
        _validateActionShape(a)
      } catch (err) {
        this.emit('warn', {
          reason: 'invalid-action-skipped',
          actionId: a && a.id,
          message: err.message,
        })
        continue
      }
      if (typeof a.id !== 'string' || a.id.length < 1) {
        this.emit('warn', { reason: 'missing-id-skipped' })
        continue
      }
      if (this._actions.size >= MAX_ACTIONS) {
        this.emit('warn', { reason: 'max-actions-reached-on-load' })
        break
      }
      this._actions.set(a.id, a)
    }
    return this
  }

  save() {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      actions: Array.from(this._actions.values()),
    }
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
  }

  // -------- CRUD ------------------------------------------------------------

  list() {
    return Array.from(this._actions.values()).map(_cloneAction)
  }

  get(id) {
    const a = this._actions.get(id)
    return a ? _cloneAction(a) : null
  }

  /**
   * Create a new action. Generates id, stamps createdAt/updatedAt, persists.
   * Returns the stored shape (clone).
   */
  create({ name, action, params, schedule, enabled = true }) {
    if (this._actions.size >= MAX_ACTIONS) {
      throw new ScheduledActionsError(
        `would exceed MAX_ACTIONS=${MAX_ACTIONS}`,
        'TOO_MANY_ACTIONS',
      )
    }
    // Validate params BEFORE spread — spread silently turns arrays into
    // plain-looking objects ({0:'a',1:'b'}), so the post-spread check in
    // _validateActionShape never catches array inputs.
    if (params !== undefined && params !== null && !_isPlainObject(params)) {
      throw new ScheduledActionsError('params must be a plain object', 'BAD_PARAMS')
    }
    const now = this._clock()
    const a = {
      id: this._idGen(),
      name: String(name || '').trim(),
      action: String(action || '').trim(),
      params: params ? { ...params } : {},
      schedule,
      enabled: Boolean(enabled),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastResult: null, // { ok: boolean, error?: string, durationMs: number, firedAt: number }
    }
    _validateActionShape(a)
    this._actions.set(a.id, a)
    this.save()
    const clone = _cloneAction(a)
    this.emit('action-created', clone)
    return clone
  }

  /**
   * Patch an existing action. Disallows mutation of id/createdAt; bumps
   * updatedAt; re-validates the whole shape after the merge.
   */
  update(id, patch) {
    const current = this._actions.get(id)
    if (!current) {
      throw new ScheduledActionsError(`unknown action ${id}`, 'UNKNOWN_ACTION')
    }
    if (!_isPlainObject(patch)) {
      throw new ScheduledActionsError('patch must be an object', 'BAD_PATCH')
    }
    const blocked = ['id', 'createdAt', 'lastRunAt', 'lastResult']
    for (const k of blocked) {
      if (k in patch) {
        throw new ScheduledActionsError(
          `cannot patch reserved field "${k}"`,
          'RESERVED_FIELD',
        )
      }
    }
    // Same array-via-spread defense as create().
    if (
      patch.params !== undefined &&
      patch.params !== null &&
      !_isPlainObject(patch.params)
    ) {
      throw new ScheduledActionsError('params must be a plain object', 'BAD_PARAMS')
    }
    const next = { ...current, ...patch, updatedAt: this._clock() }
    if (patch.params !== undefined) {
      next.params = patch.params ? { ...patch.params } : {}
    }
    _validateActionShape(next)
    this._actions.set(id, next)
    this.save()
    const clone = _cloneAction(next)
    this.emit('action-updated', clone)
    return clone
  }

  remove(id) {
    const a = this._actions.get(id)
    if (!a) return false
    this._actions.delete(id)
    this.save()
    this.emit('action-deleted', { id, action: _cloneAction(a) })
    return true
  }

  setEnabled(id, enabled) {
    return this.update(id, { enabled: Boolean(enabled) })
  }

  size() {
    return this._actions.size
  }

  // -------- Handler registry ------------------------------------------------

  /**
   * Register / replace a handler for an action type. Returns previous
   * handler (if any) so callers can compose. Called by F-2.
   */
  setHandler(actionType, fn) {
    if (typeof actionType !== 'string' || actionType.length < 1) {
      throw new ScheduledActionsError('actionType required', 'BAD_HANDLER')
    }
    if (typeof fn !== 'function') {
      throw new ScheduledActionsError('handler must be a function', 'BAD_HANDLER')
    }
    const prev = this._handlers[actionType]
    this._handlers[actionType] = fn
    return prev
  }

  hasHandler(actionType) {
    return typeof this._handlers[actionType] === 'function'
  }

  // -------- Scheduling / firing --------------------------------------------

  /**
   * Compute the next-run timestamp (ms) for an action given current state.
   * Returns null if the action is disabled.
   */
  nextRunAt(id) {
    const a = this._actions.get(id)
    if (!a) return null
    if (!a.enabled) return null
    return computeNextRunAt(a.schedule, a.lastRunAt, this._clock(), a.createdAt)
  }

  /**
   * One tick of the runner. Examines every enabled action; for those whose
   * nextRunAt ≤ nowMs, fires the corresponding handler asynchronously
   * (non-blocking; multiple actions can fire in the same tick).
   *
   * Reentrancy: an action that's already firing is skipped until it
   * settles. The next tick will pick it up if still due.
   *
   * Returns a promise that resolves once every handler launched THIS tick
   * has settled. Errors inside handlers are caught and surfaced via
   * `'action-failed'`; they do NOT propagate.
   */
  async tick(nowMs) {
    if (this._stopped) return
    const now = typeof nowMs === 'number' ? nowMs : this._clock()
    const launched = []
    for (const a of this._actions.values()) {
      if (!a.enabled) continue
      if (this._inFlight.has(a.id)) {
        this.emit('action-skipped', { id: a.id, reason: 'in-flight' })
        continue
      }
      const due = computeNextRunAt(a.schedule, a.lastRunAt, now, a.createdAt)
      if (due > now) continue
      launched.push(this._fireOne(a.id, now))
    }
    await Promise.allSettled(launched)
  }

  async _fireOne(id, firedAt) {
    const a = this._actions.get(id)
    if (!a) return
    const handler = this._handlers[a.action]
    this._inFlight.add(id)
    const start = this._clock()
    let result
    try {
      if (!handler) {
        throw new ScheduledActionsError(
          `no handler registered for action "${a.action}"`,
          'NO_HANDLER',
        )
      }
      const ret = await handler({ ...(a.params || {}) }, { actionId: id, firedAt })
      const durationMs = this._clock() - start
      result = { ok: true, durationMs, firedAt, value: _safeReturn(ret) }
      a.lastRunAt = firedAt
      a.lastResult = result
      a.updatedAt = this._clock()
      this.save()
      this.emit('action-fired', { id, result: { ...result } })
    } catch (err) {
      const durationMs = this._clock() - start
      result = {
        ok: false,
        durationMs,
        firedAt,
        error: err && err.message ? String(err.message) : String(err),
        code: err && err.code,
      }
      a.lastRunAt = firedAt
      a.lastResult = result
      a.updatedAt = this._clock()
      this.save()
      this.emit('action-failed', { id, result: { ...result } })
    } finally {
      this._inFlight.delete(id)
    }
  }

  /**
   * Start the runner loop. Subsequent calls are no-ops (use stop+start to
   * change interval). `intervalMs` defaults to 60s; tests pass a tiny
   * value or call `tick()` directly instead.
   */
  start({ intervalMs = DEFAULT_TICK_MS } = {}) {
    if (this._timer) return
    this._stopped = false
    this._timer = setInterval(() => {
      // Fire-and-forget — tick() catches its own errors.
      this.tick().catch((err) => {
        this.emit('warn', {
          reason: 'tick-threw',
          message: err && err.message ? String(err.message) : String(err),
        })
      })
    }, intervalMs)
    // Don't keep the event loop alive on its own — main.js owns lifetimes.
    if (this._timer.unref) this._timer.unref()
    this.emit('runner-started', { intervalMs })
  }

  /**
   * Stop the runner. Resolves once all in-flight handlers settle, so
   * callers can `await scheduled.stop()` from before-quit safely.
   */
  async stop() {
    this._stopped = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    // Wait for in-flight handlers to drain. Poll because they're tracked
    // by id in a Set — there's no Promise registry. Polling is cheap.
    while (this._inFlight.size > 0) {
      await new Promise((r) => setTimeout(r, 10))
    }
    this.emit('runner-stopped')
  }

  isRunning() {
    return this._timer != null && !this._stopped
  }
}

function _safeReturn(v) {
  // Don't persist arbitrary handler return values verbatim — many handlers
  // return BrowserWindow refs / streams that JSON.stringify can't handle.
  // We only keep cheap scalars/objects.
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v
  }
  if (_isPlainObject(v)) {
    try {
      const s = JSON.stringify(v)
      if (s.length > 4000) return { truncated: true }
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  return null
}

module.exports = {
  ScheduledActions,
  ScheduledActionsError,
  computeNextRunAt,
  SCHEMA_VERSION,
  MAX_ACTIONS,
  DEFAULT_TICK_MS,
  DAYS,
}
