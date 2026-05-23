// OZ Browser — Bulk Runner schedule helper (v2 Etapa 2.1).
//
// Extracted from bulk-runner-ui.js to keep that file under the 500 LOC
// budget (ADR 0005). This module owns the "Schedule…" button flow:
// prompts the user for daily/weekly + time + name, builds the scheduled
// action input, and calls window.oz.scheduledActions.create.
//
// The richer UI (inline panel with date picker, day chips, etc) is a
// deferred polish — for alpha.18 we ship the functional flow with
// native prompts. Anyone preferring a richer experience can build the
// scheduled action from chat via the oz.sched.create MCP tool (which
// is the actual production path Claude uses).
//
// API contract (consumed by bulk-runner-ui.js):
//   await scheduleBulkRun({ spec, onError, onSuccess })
//     - spec: { actionId, identityIds[], params, options }
//     - onError(msg): called when user input is invalid or backend fails
//     - onSuccess(name, schedule): called after successful create
//   describeSchedule(s) → human-readable string

;(function () {
  'use strict'

  const VALID_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

  function describeSchedule(s) {
    if (!s) return ''
    if (s.type === 'daily') return `daily at ${s.time}`
    if (s.type === 'weekly') return `every ${s.day} at ${s.time}`
    if (s.type === 'every-minutes') return `every ${s.minutes} minutes`
    return s.type
  }

  function _promptSchedule(onError) {
    const kindRaw = window.prompt(
      'Schedule type? (1) daily   (2) weekly\nEnter 1 or 2:',
      '1',
    )
    if (!kindRaw) return null
    const kind = kindRaw.trim()
    if (kind === '1') {
      const time = window.prompt('Daily at what time? (HH:MM, 24h)', '09:00')
      if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        onError('Time must be HH:MM (e.g. 09:00).')
        return null
      }
      return { type: 'daily', time }
    }
    if (kind === '2') {
      const day = window.prompt(
        'Weekly on which day? (mon/tue/wed/thu/fri/sat/sun)',
        'mon',
      )
      if (!day || !VALID_DAYS.includes(day)) {
        onError('Day must be mon/tue/wed/thu/fri/sat/sun.')
        return null
      }
      const time = window.prompt('Weekly at what time? (HH:MM, 24h)', '09:00')
      if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        onError('Time must be HH:MM (e.g. 09:00).')
        return null
      }
      return { type: 'weekly', day, time }
    }
    onError('Schedule type must be 1 (daily) or 2 (weekly).')
    return null
  }

  async function scheduleBulkRun({ spec, onError, onSuccess }) {
    if (!spec) return
    const schedule = _promptSchedule(onError)
    if (!schedule) return
    const defaultName = `Bulk ${spec.actionId} × ${spec.identityIds.length}`
    const name = (window.prompt('Name for this scheduled run:', defaultName) || '').trim()
    if (!name) return
    const api = window.oz && window.oz.scheduledActions
    if (!api || typeof api.create !== 'function') {
      onError('Scheduled Actions API not available in this build.')
      return
    }
    const res = await api.create({
      name,
      action: 'bulk',
      params: { spec },
      schedule,
      enabled: true,
    })
    if (!res || !res.ok) {
      onError(`Schedule failed: ${(res && (res.message || res.reason)) || 'unknown'}`)
      return
    }
    if (typeof onSuccess === 'function') {
      onSuccess(name, schedule)
    }
  }

  if (!window.OZ) window.OZ = {}
  window.OZ.bulkRunnerSchedule = {
    scheduleBulkRun,
    describeSchedule,
  }
})()
