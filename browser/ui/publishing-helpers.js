// OZ Browser — Publishing Studio pure helpers (v2 Etapa 1).
//
// Pure, DOM-free functions consumed by the Publishing Studio UI layer
// (publishing-studio.js / publishing-composer.js / publishing-targets.js)
// AND by tests/publishing-helpers.smoketest.js (Node, no DOM).
//
// Loaded as a regular <script> in publishing-studio.html BEFORE the UI
// modules so the browser side reads it from
// `window.OZ.publishingHelpers`. In Node it is `require()`d as CommonJS.
//
// ADR: docs/architecture/0038-publishing-studio.md (ADR-A + ADR-B).

;(function (factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    const helpers = factory()
    const root = typeof window !== 'undefined' ? window : globalThis
    root.OZ = root.OZ || {}
    root.OZ.publishingHelpers = helpers
  }
})(function () {
  'use strict'

  // Etapa 1 ships the two publish actions that already exist in the bulk
  // registry. Etapa 6 adds fb_post / tiktok_post; once registered they only
  // need to be appended here (ADR-B keeps the composer schema-driven, so no
  // form code changes — just the allow-list + platform map below).
  const PUBLISHABLE_ACTION_IDS = ['ig_post', 'x_post', 'fb_post']

  const PLATFORM_BY_ACTION = {
    ig_post: 'instagram',
    x_post: 'x',
    fb_post: 'facebook',
    tiktok_post: 'tiktok',
  }

  const PLATFORM_LABEL = {
    instagram: 'Instagram',
    x: 'X (Twitter)',
    facebook: 'Facebook',
    tiktok: 'TikTok',
  }

  // Health gating thresholds. 'red' is blocked by default (anti-detect risk);
  // 'yellow' is surfaced as a warning but still allowed.
  const HEALTH_BLOCK = 'red'
  const HEALTH_WARN = 'yellow'

  // Mirror of bulk-runner.js MAX_IDENTITIES_PER_RUN so the UI can warn early
  // instead of letting the engine throw. Keep in sync if the engine changes.
  const MAX_IDENTITIES_PER_RUN = 50

  // Schema params that are real-but-not-user-facing; hidden from the composer.
  const HIDDEN_PARAM_NAMES = ['timeoutMs', 'durationMs']

  // Sensible caption/text caps when the action's paramsSchema omits maxLength.
  const FALLBACK_MAXLEN = { caption: 2200, text: 280 }

  function platformOf(actionId) {
    return PLATFORM_BY_ACTION[actionId] || null
  }

  function platformLabel(platform) {
    return PLATFORM_LABEL[platform] || String(platform || '')
  }

  // Filter a raw `oz:bulk:listActions()` result down to the publish actions
  // we support, annotated for the composer. Defensive against partial data.
  function pickPublishActions(actions) {
    if (!Array.isArray(actions)) return []
    const out = []
    for (const a of actions) {
      if (!a || typeof a !== 'object') continue
      const id = a.id || a.actionId
      if (!PUBLISHABLE_ACTION_IDS.includes(id)) continue
      out.push({
        actionId: id,
        label: a.label || id,
        platform: platformOf(id),
        paramsSchema: a.paramsSchema || { type: 'object', properties: {} },
      })
    }
    // Stable order matching PUBLISHABLE_ACTION_IDS.
    out.sort(
      (x, y) =>
        PUBLISHABLE_ACTION_IDS.indexOf(x.actionId) -
        PUBLISHABLE_ACTION_IDS.indexOf(y.actionId),
    )
    return out
  }

  // Derive the user-facing field list from a publish action's paramsSchema.
  // Keeps the composer generic (ADR-B): any new action's fields render from
  // its own schema with zero form-specific code.
  function fieldsFromSchema(action) {
    const schema = (action && action.paramsSchema) || {}
    const props = schema.properties || {}
    const required = Array.isArray(schema.required) ? schema.required : []
    const fields = []
    for (const name of Object.keys(props)) {
      if (HIDDEN_PARAM_NAMES.includes(name)) continue
      const p = props[name] || {}
      const isImage = name === 'imagePath'
      const isLongText = name === 'caption' || name === 'text' || name === 'body'
      let control = 'text'
      if (isImage) control = 'image'
      else if (isLongText) control = 'textarea'
      else if (p.type === 'number' || p.type === 'integer') control = 'number'
      const maxLength =
        typeof p.maxLength === 'number' ? p.maxLength : FALLBACK_MAXLEN[name] || null
      fields.push({
        name,
        control,
        type: p.type || 'string',
        required: required.includes(name),
        maxLength,
      })
    }
    return fields
  }

  // Build a params object from raw input values keyed by field name. Drops
  // empty optional fields; coerces numbers. Does NOT validate (see validate).
  function coercePublishParams(fields, rawValues) {
    const params = {}
    const values = rawValues || {}
    for (const f of fields || []) {
      let v = values[f.name]
      if (v == null) v = ''
      if (typeof v === 'string') v = v.trim()
      if (v === '' && !f.required) continue
      if (f.control === 'number') {
        const n = Number(v)
        if (!Number.isNaN(n)) params[f.name] = n
        continue
      }
      params[f.name] = v
    }
    return params
  }

  // Validate composed params against the field list. Returns
  // { ok, errors:[{ field, code }] }. Codes are i18n keys resolved by the UI.
  function validatePublishInput(fields, params) {
    const errors = []
    const p = params || {}
    for (const f of fields || []) {
      const v = p[f.name]
      const empty = v == null || (typeof v === 'string' && v.trim() === '')
      if (f.required && empty) {
        errors.push({ field: f.name, code: 'required' })
        continue
      }
      if (!empty && f.maxLength && String(v).length > f.maxLength) {
        errors.push({ field: f.name, code: 'tooLong' })
      }
    }
    return { ok: errors.length === 0, errors }
  }

  // Normalize an `oz:health:list()` result (array of records OR map keyed by
  // identityId) into a Map of identityId -> overall status string.
  function normalizeHealthMap(healthList) {
    const map = new Map()
    if (!healthList) return map
    const records = Array.isArray(healthList) ? healthList : Object.values(healthList)
    for (const r of records) {
      if (!r || typeof r !== 'object') continue
      const id = r.identityId || r.id
      if (!id) continue
      map.set(id, r.overall || r.status || 'unknown')
    }
    return map
  }

  // Split chosen identity ids into allowed / warned / blocked by health.
  // blocked = red (skipped by default), warned = yellow (allowed w/ notice).
  function partitionTargetsByHealth(identityIds, healthList, opts) {
    const block = (opts && opts.block) || HEALTH_BLOCK
    const map = healthList instanceof Map ? healthList : normalizeHealthMap(healthList)
    const allowed = []
    const warned = []
    const blocked = []
    for (const id of identityIds || []) {
      const status = map.get(id) || 'unknown'
      if (status === block) blocked.push({ id, status })
      else if (status === HEALTH_WARN) {
        warned.push({ id, status })
        allowed.push(id)
      } else allowed.push(id)
    }
    return { allowed, warned, blocked }
  }

  // Build the exact spec shape `oz:bulk:create` / `oz:bulk:run` expects.
  // `options` (drip: { minDelayMs, maxDelayMs }) is included only when set,
  // so callers that don't drip keep the original 3-key shape.
  function buildPublishSpec({ actionId, identityIds, params, options } = {}) {
    const spec = {
      actionId,
      identityIds: Array.isArray(identityIds) ? identityIds.slice() : [],
      params: params || {},
    }
    if (options && typeof options === 'object' && Object.keys(options).length) {
      spec.options = options
    }
    return spec
  }

  // Pre-flight a publish request. Returns { ok, code? } where code is an i18n
  // key the UI surfaces ('noTargets' | 'tooManyTargets' | 'invalidParams').
  function preflightPublish({ fields, params, identityIds } = {}) {
    if (!Array.isArray(identityIds) || identityIds.length === 0) {
      return { ok: false, code: 'noTargets' }
    }
    if (identityIds.length > MAX_IDENTITIES_PER_RUN) {
      return { ok: false, code: 'tooManyTargets', max: MAX_IDENTITIES_PER_RUN }
    }
    const v = validatePublishInput(fields, params)
    if (!v.ok) return { ok: false, code: 'invalidParams', errors: v.errors }
    return { ok: true }
  }

  // ─── Etapa 2-A: publish run history helpers ──────────────────────────

  // Is this bulk run (summary { meta } or meta itself) a publish run?
  function isPublishRun(runOrMeta) {
    if (!runOrMeta) return false
    const meta = runOrMeta.meta || runOrMeta
    return PUBLISHABLE_ACTION_IDS.includes(meta && meta.actionId)
  }

  // Filter a `oz:bulk:list()` result down to publish runs only.
  function filterPublishRuns(rows) {
    if (!Array.isArray(rows)) return []
    return rows.filter((r) => isPublishRun(r))
  }

  // Human platform label for a run summary (via its actionId).
  function runPlatformLabel(runOrMeta) {
    const meta = (runOrMeta && (runOrMeta.meta || runOrMeta)) || {}
    return platformLabel(platformOf(meta.actionId))
  }

  // Tally item statuses for a hydrated run ({ items: [...] }). Always returns
  // every known bucket so the UI can render counts without guards.
  function countItems(items) {
    const out = { success: 0, failed: 0, skipped: 0, pending: 0, running: 0, total: 0 }
    if (!Array.isArray(items)) return out
    for (const it of items) {
      out.total++
      const s = it && it.status
      if (s && Object.prototype.hasOwnProperty.call(out, s)) out[s]++
    }
    return out
  }

  // ─── Etapa 3: scheduling + drip helpers ──────────────────────────────

  const TIME_RE = /^[0-2]\d:[0-5]\d$/

  // Translate a "spacing between accounts" (seconds) into the runner's drip
  // options. 0 / empty → undefined (engine default 30-90s applies).
  function dripOptions(spacingSec) {
    const s = Number(spacingSec)
    if (!Number.isFinite(s) || s <= 0) return undefined
    const minDelayMs = Math.round(s * 1000)
    const maxDelayMs = Math.round(s * 1500)
    return { minDelayMs, maxDelayMs }
  }

  // Build a recurring schedule object the scheduler accepts. Returns null on
  // invalid input so the UI can surface an error. One-shot ('once') is NOT
  // supported by the engine yet — tracked as Etapa 3-B.
  function buildSchedule({ mode, time, day, minutes } = {}) {
    if (mode === 'daily') {
      return TIME_RE.test(time) ? { type: 'daily', time } : null
    }
    if (mode === 'weekly') {
      if (!TIME_RE.test(time)) return null
      if (!['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(day)) return null
      return { type: 'weekly', day, time }
    }
    if (mode === 'everyMinutes') {
      const m = Math.floor(Number(minutes))
      if (!Number.isFinite(m) || m < 1 || m > 1440) return null
      return { type: 'every-minutes', minutes: m }
    }
    return null
  }

  // Build the `oz:scheduledActions.create` input for a scheduled publication.
  function buildScheduleInput({
    name,
    actionId,
    identityIds,
    params,
    schedule,
    options,
  } = {}) {
    return {
      name: String(name || 'Publish').slice(0, 80),
      action: 'bulk',
      enabled: true,
      schedule,
      params: { spec: buildPublishSpec({ actionId, identityIds, params, options }) },
    }
  }

  // Is this scheduled action a publish (bulk ig_post/x_post)?
  function isPublishScheduledAction(a) {
    const spec = a && a.params && a.params.spec
    return !!(
      a &&
      a.action === 'bulk' &&
      spec &&
      PUBLISHABLE_ACTION_IDS.includes(spec.actionId)
    )
  }

  // Human platform label for a scheduled publication.
  function scheduledPlatformLabel(a) {
    const spec = (a && a.params && a.params.spec) || {}
    return platformLabel(platformOf(spec.actionId))
  }

  return {
    PUBLISHABLE_ACTION_IDS,
    PLATFORM_BY_ACTION,
    PLATFORM_LABEL,
    HEALTH_BLOCK,
    HEALTH_WARN,
    MAX_IDENTITIES_PER_RUN,
    HIDDEN_PARAM_NAMES,
    platformOf,
    platformLabel,
    pickPublishActions,
    fieldsFromSchema,
    coercePublishParams,
    validatePublishInput,
    normalizeHealthMap,
    partitionTargetsByHealth,
    buildPublishSpec,
    preflightPublish,
    isPublishRun,
    filterPublishRuns,
    runPlatformLabel,
    countItems,
    dripOptions,
    buildSchedule,
    buildScheduleInput,
    isPublishScheduledAction,
    scheduledPlatformLabel,
  }
})
