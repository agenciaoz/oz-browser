// OZ Browser — Bulk History pure helpers (v2 Etapa 4.1).
//
// Pure functions consumed by bulk-history.js (the IIFE UI layer) AND by
// tests/bulk-history-ui.smoketest.js (Node, no DOM). Keep this file DOM-free.
//
// Loaded as a regular <script> in webui.html BEFORE bulk-history.js so the
// UI side can read it from `window.OZ.bulkHistoryHelpers`. In Node it is
// `require()`d as a CommonJS module.
//
// ADR: docs/architecture/0032-bulk-history-dashboard.md

;(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    const helpers = factory()
    const root = typeof window !== 'undefined' ? window : globalThis
    root.OZ = root.OZ || {}
    root.OZ.bulkHistoryHelpers = helpers
  }
})(function () {
  'use strict'

  const DATE_RANGES = {
    '7d': 7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000,
    all: Infinity,
  }

  /**
   * Apply filters to a list of {meta, items?} entries.
   * Returns a new array; original untouched.
   *
   *   filters = {
   *     status?:     'all' | RUN_STATUS,
   *     actionId?:   string | 'all',
   *     identityId?: string | 'all',  // requires items to be populated
   *     dateRange?:  '7d' | '30d' | 'all',
   *     search?:     string,
   *     nowMs?:      number,  // injectable for tests
   *   }
   *
   * Entries may be raw `meta` objects OR `{meta, items}` wrappers — both work.
   */
  function filterRuns(rows, filters = {}) {
    if (!Array.isArray(rows)) return []
    const status = filters.status || 'all'
    const actionId = filters.actionId || 'all'
    const identityId = filters.identityId || 'all'
    const dateRange = filters.dateRange || 'all'
    const search = (filters.search || '').trim().toLowerCase()
    const nowMs = filters.nowMs != null ? filters.nowMs : Date.now()
    const cutoff =
      DATE_RANGES[dateRange] === Infinity || DATE_RANGES[dateRange] == null
        ? -Infinity
        : nowMs - DATE_RANGES[dateRange]
    return rows.filter((row) => {
      if (!row || typeof row !== 'object') return false
      const meta = row.meta || row
      if (status !== 'all' && meta.status !== status) return false
      if (actionId !== 'all' && meta.actionId !== actionId) return false
      if (cutoff !== -Infinity) {
        const ts = Date.parse(meta.createdAt || '') || 0
        if (ts < cutoff) return false
      }
      if (identityId !== 'all') {
        const items = row.items || []
        if (!Array.isArray(items) || items.length === 0) return false
        if (!items.some((it) => it && it.identityId === identityId)) return false
      }
      if (search) {
        const haystack =
          `${meta.runId || ''} ${meta.actionId || ''} ${meta.actionLabel || ''}`.toLowerCase()
        if (!haystack.includes(search)) return false
      }
      return true
    })
  }

  /**
   * Sort runs. Stable. Returns a new array.
   *   mode='newest' (default) | 'oldest' | 'status'
   *
   * status order (most-attention-first): failed → running/cancelling →
   * cancelled → completed → created. Within a status, newest first.
   */
  function sortRuns(rows, mode = 'newest') {
    if (!Array.isArray(rows)) return []
    const copy = rows.slice()
    if (mode === 'oldest') {
      copy.sort((a, b) => {
        const aT = ((a && a.meta) || a || {}).createdAt || ''
        const bT = ((b && b.meta) || b || {}).createdAt || ''
        return aT.localeCompare(bT)
      })
    } else if (mode === 'status') {
      const ORDER = {
        failed: 0,
        running: 1,
        cancelling: 1,
        cancelled: 2,
        completed: 3,
        created: 4,
      }
      copy.sort((a, b) => {
        const aM = (a && a.meta) || a || {}
        const bM = (b && b.meta) || b || {}
        const aS = ORDER[aM.status] != null ? ORDER[aM.status] : 9
        const bS = ORDER[bM.status] != null ? ORDER[bM.status] : 9
        if (aS !== bS) return aS - bS
        return (bM.createdAt || '').localeCompare(aM.createdAt || '')
      })
    } else {
      copy.sort((a, b) => {
        const aT = ((a && a.meta) || a || {}).createdAt || ''
        const bT = ((b && b.meta) || b || {}).createdAt || ''
        return bT.localeCompare(aT)
      })
    }
    return copy
  }

  /**
   * Aggregate stats across a list of runs (meta-level).
   * Returns { total, completed, failed, cancelled, running }.
   */
  function buildStats(rows) {
    const out = { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0 }
    if (!Array.isArray(rows)) return out
    for (const row of rows) {
      const meta = (row && row.meta) || row
      // Skip entries that aren't valid run metadata. A real run always has
      // a `status` string; this guard prevents `{}`, `null`, `{meta:null}`
      // from being counted as a run.
      if (!meta || typeof meta !== 'object' || typeof meta.status !== 'string') {
        continue
      }
      out.total += 1
      const s = meta.status
      if (s === 'completed') out.completed += 1
      else if (s === 'failed') out.failed += 1
      else if (s === 'cancelled') out.cancelled += 1
      else if (s === 'running' || s === 'cancelling') out.running += 1
    }
    return out
  }

  /**
   * Build dropdown options for {actionId} and {identityId} from a pool of runs.
   * Returns { actions:[{id,label}], identities:[{id,name}] }. Sorted alpha
   * by label / name.
   */
  function buildFilterOptions(rows) {
    const actions = new Map()
    const identities = new Map()
    if (!Array.isArray(rows)) return { actions: [], identities: [] }
    for (const row of rows) {
      const meta = (row && row.meta) || row
      if (!meta) continue
      if (meta.actionId) {
        actions.set(meta.actionId, meta.actionLabel || meta.actionId)
      }
      const items = (row && row.items) || []
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it && it.identityId && !identities.has(it.identityId)) {
            identities.set(it.identityId, it.identityName || it.identityId)
          }
        }
      }
    }
    return {
      actions: Array.from(actions, ([id, label]) => ({ id, label })).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
      identities: Array.from(identities, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }
  }

  // ─── Retry helpers (v2 Etapa 4.3) ────────────────────────────────────

  // Item statuses considered "retryable" — failed because of a transient
  // error OR explicitly cancelled mid-flight. We exclude `skipped` because
  // that means rate-limit gate fired and re-running would just hit it again,
  // and `done` because it succeeded.
  const RETRYABLE_ITEM_STATUSES = new Set(['failed', 'cancelled'])

  // Run statuses that allow a retry to be initiated. We require the run to
  // be in a terminal state — retrying a still-running run would race with
  // the in-flight loop.
  const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

  /**
   * Return identityIds whose item is in a retryable status.
   * `run` is a `{meta, items}` record (items REQUIRED — hydrate before
   * calling). Returns [] if items missing.
   */
  function getRetryableIdentityIds(run) {
    if (!run || !Array.isArray(run.items)) return []
    const out = []
    for (const it of run.items) {
      if (it && RETRYABLE_ITEM_STATUSES.has(it.status) && it.identityId) {
        out.push(it.identityId)
      }
    }
    return out
  }

  /**
   * Strict subset: items with status === 'failed' only. Used by the
   * "Retry failed items" button (default action) — excludes cancelled
   * because the user explicitly cancelled those.
   */
  function getFailedIdentityIds(run) {
    if (!run || !Array.isArray(run.items)) return []
    const out = []
    for (const it of run.items) {
      if (it && it.status === 'failed' && it.identityId) {
        out.push(it.identityId)
      }
    }
    return out
  }

  /**
   * Build the spec to pass to `oz.bulk.run()` for a retry.
   * Caller MUST verify the run is terminal and identityIds is non-empty
   * before invoking the runner — those checks live in the UI layer so
   * errors can be surfaced friendly.
   *
   *   buildRetrySpec(originalMeta, identityIds) → { actionId, identityIds, params, options }
   */
  function buildRetrySpec(originalMeta, identityIds) {
    if (!originalMeta || typeof originalMeta !== 'object') {
      throw new Error('buildRetrySpec: meta required')
    }
    if (!Array.isArray(identityIds) || identityIds.length === 0) {
      throw new Error('buildRetrySpec: non-empty identityIds required')
    }
    return {
      actionId: originalMeta.actionId,
      identityIds: identityIds.slice(),
      params: { ...(originalMeta.params || {}) },
      options: { ...(originalMeta.options || {}) },
    }
  }

  /**
   * Quick predicate: can this run be retried at all?
   * Returns true if (a) run is in terminal status AND (b) at least one
   * item is retryable. Items must be hydrated.
   */
  function canRetryRun(run) {
    if (!run || !run.meta) return false
    if (!TERMINAL_RUN_STATUSES.has(run.meta.status)) return false
    return getRetryableIdentityIds(run).length > 0
  }

  // ─── CSV export helpers (v2 Etapa 4.5) ───────────────────────────────

  // RFC 4180 cell escape: if value contains comma, quote, CR, or LF —
  // wrap in double-quotes and double any internal quote. null/undefined
  // become empty string. Objects are JSON-stringified.
  function toCsvCell(value) {
    if (value == null) return ''
    let s
    if (typeof value === 'object') {
      try {
        s = JSON.stringify(value)
      } catch {
        s = String(value)
      }
    } else {
      s = String(value)
    }
    if (s.length === 0) return ''
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }

  function _csvLine(values) {
    return values.map(toCsvCell).join(',')
  }

  const RUNS_CSV_HEADERS = [
    'createdAt',
    'runId',
    'actionId',
    'actionLabel',
    'identityCount',
    'status',
    'done',
    'failed',
    'skipped',
    'cancelled',
    'finishedAt',
  ]

  /**
   * Serialize a list of {meta, items?} rows to a CSV string. Header row +
   * one row per run. Used by the list-view export button (exports the
   * filtered+sorted set).
   */
  function runsToCSV(rows) {
    if (!Array.isArray(rows)) rows = []
    const lines = [_csvLine(RUNS_CSV_HEADERS)]
    for (const row of rows) {
      const meta = (row && row.meta) || row
      // Same validity guard as buildStats: a real run always has a
      // string `status`. This avoids exporting blank rows for `{}`,
      // `null`, `{meta:null}`.
      if (!meta || typeof meta !== 'object' || typeof meta.status !== 'string') {
        continue
      }
      const s = meta.stats || {}
      lines.push(
        _csvLine([
          meta.createdAt,
          meta.runId,
          meta.actionId,
          meta.actionLabel,
          meta.identityCount,
          meta.status,
          s.done,
          s.failed,
          s.skipped,
          s.cancelled,
          meta.finishedAt,
        ]),
      )
    }
    return lines.join('\r\n') + '\r\n'
  }

  const DETAIL_CSV_HEADERS = [
    'runId',
    'identityId',
    'identityName',
    'status',
    'result',
    'errorCode',
    'errorMessage',
    'startedAt',
    'finishedAt',
  ]

  /**
   * Serialize a single run's items to a CSV string. Header row + one row
   * per identity item. Used by the detail-view export button.
   */
  function runDetailToCSV(run) {
    const lines = [_csvLine(DETAIL_CSV_HEADERS)]
    if (!run || typeof run !== 'object') return lines.join('\r\n') + '\r\n'
    const meta = run.meta || {}
    const items = Array.isArray(run.items) ? run.items : []
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      lines.push(
        _csvLine([
          meta.runId,
          it.identityId,
          it.identityName,
          it.status,
          it.result,
          it.error ? it.error.code : '',
          it.error ? it.error.message : '',
          it.startedAt,
          it.finishedAt,
        ]),
      )
    }
    return lines.join('\r\n') + '\r\n'
  }

  return {
    DATE_RANGES,
    RETRYABLE_ITEM_STATUSES,
    TERMINAL_RUN_STATUSES,
    RUNS_CSV_HEADERS,
    DETAIL_CSV_HEADERS,
    filterRuns,
    sortRuns,
    buildStats,
    buildFilterOptions,
    getRetryableIdentityIds,
    getFailedIdentityIds,
    buildRetrySpec,
    canRetryRun,
    toCsvCell,
    runsToCSV,
    runDetailToCSV,
  }
})
