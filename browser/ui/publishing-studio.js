// OZ Browser — Publishing Studio controller (v2 Etapa 1).
//
// Wires the schema-driven composer + target selector to the Bulk Runner
// engine (window.oz.bulk). "Publish now" runs ig_post / x_post across the
// chosen identities, after a safety summary + health gating. Live progress
// comes from oz:bulk:progress / oz:bulk:completed.
//
// ADR: docs/architecture/0038-publishing-studio.md.

;(function () {
  'use strict'

  const H = (window.OZ && window.OZ.publishingHelpers) || {}
  const t = (key, params) => (window.OZ && window.OZ.t ? window.OZ.t(key, params) : key)

  const state = {
    composer: null,
    targets: null,
    history: null,
    schedule: null,
    scheduledList: null,
    variation: null,
    activeRunId: null,
    items: new Map(), // identityId -> { name, status }
  }

  function $(id) {
    return document.getElementById(id)
  }

  async function boot() {
    if (window.OZ && window.OZ.i18n && window.OZ.i18n.init) {
      try {
        await window.OZ.i18n.init()
      } catch (_e) {
        /* i18n best-effort */
      }
    }
    state.composer = new window.OZ.PublishingComposer({
      container: $('pub-composer'),
      onChange: refreshPublishButton,
    })
    state.composer.mount()
    state.targets = new window.OZ.PublishingTargets({
      container: $('pub-targets'),
      onChange: refreshPublishButton,
    })
    state.targets.mount()

    if (window.OZ.PublishingVariationUI) {
      state.variation = new window.OZ.PublishingVariationUI({
        container: $('pub-variation'),
        getCaption: () => state.composer.getCaptionValue(),
        setCaption: (text) => state.composer.setCaptionValue(text),
        getIdentities: () =>
          state.targets ? state.targets.getSelectedIdentityObjects() : [],
        store: window.OZ.publishingStore,
      })
      state.variation.mount()
    }
    if (window.OZ.PublishingSchedule) {
      state.schedule = new window.OZ.PublishingSchedule({
        container: $('pub-when'),
        onChange: refreshPublishButton,
      })
      state.schedule.mount()
    }
    if (window.OZ.PublishingScheduledList) {
      state.scheduledList = new window.OZ.PublishingScheduledList({
        container: $('pub-scheduled'),
      })
      state.scheduledList.mount()
    }
    if (window.OZ.PublishingHistory) {
      state.history = new window.OZ.PublishingHistory({
        container: $('pub-history'),
        onRetry: () =>
          setStatus(t('publishingStudio.publishing', 'Publishing…'), 'yellow'),
      })
      state.history.mount()
    }

    await loadActions()
    await state.targets.load()
    if (state.scheduledList) await state.scheduledList.load()
    if (state.history) await state.history.load()
    wireEvents()
    refreshPublishButton()
  }

  async function loadActions() {
    let actions = []
    try {
      actions = await window.oz.bulk.listActions()
    } catch (_e) {
      actions = []
    }
    const publishable = H.pickPublishActions(actions)
    state.composer.setActions(publishable)
    if (!publishable.length) {
      setStatus(t('publishingStudio.noActions', 'No publish actions available'), 'red')
    }
  }

  function wireEvents() {
    $('pub-publish-btn').addEventListener('click', onPublish)
    $('pub-refresh-btn').addEventListener('click', async () => {
      await state.targets.load()
      if (state.history) await state.history.load()
      refreshPublishButton()
    })
    if (window.oz.bulk.onProgress) window.oz.bulk.onProgress(onProgress)
    if (window.oz.bulk.onCompleted) window.oz.bulk.onCompleted(onCompleted)
  }

  function refreshPublishButton() {
    const sel = state.composer.getSelection()
    const ids = state.targets ? state.targets.getSelectedIds() : []
    const btn = $('pub-publish-btn')
    const enabled = !!sel && ids.length > 0 && !state.activeRunId
    btn.disabled = !enabled
    const mode = state.schedule ? state.schedule.getMode() : 'now'
    btn.textContent =
      mode === 'schedule'
        ? t('publishingStudio.sched.scheduleBtn', 'Schedule')
        : t('publishingStudio.publishNow', 'Publish now')
  }

  async function onPublish() {
    const sel = state.composer.getSelection()
    if (!sel) return
    const part = state.targets.getPartition()
    const allowed = part.allowed

    const pre = H.preflightPublish({
      fields: sel.fields,
      params: sel.params,
      identityIds: allowed,
    })
    if (!pre.ok) {
      if (pre.code === 'invalidParams') {
        state.composer.showErrors(pre.errors)
        setStatus(t('publishingStudio.fixErrors', 'Fix the highlighted fields'), 'red')
      } else if (pre.code === 'noTargets') {
        setStatus(
          part.blocked.length
            ? t(
                'publishingStudio.allBlocked',
                'All selected identities are blocked by health',
              )
            : t('publishingStudio.pickTargets', 'Select at least one identity'),
          'red',
        )
      } else if (pre.code === 'tooManyTargets') {
        setStatus(t('publishingStudio.tooMany', { max: pre.max }), 'red')
      }
      return
    }
    state.composer.showErrors([])

    const platformLabel = H.platformLabel(sel.platform)
    const drip = state.schedule ? state.schedule.getDripOptions() : undefined
    const mode = state.schedule ? state.schedule.getMode() : 'now'

    if (mode === 'schedule') {
      await schedulePublish(sel, allowed, platformLabel, drip)
      return
    }

    const msg = t('publishingStudio.confirm', {
      count: allowed.length,
      platform: platformLabel,
      blocked: part.blocked.length,
      warned: part.warned.length,
    })
    const okLabel = t('publishingStudio.confirmOk', 'Publish now')
    const cancelLabel = t('common.cancel', 'Cancel')
    let confirmed = true
    if (window.OZ && window.OZ.ui && window.OZ.ui.confirm) {
      confirmed = await window.OZ.ui.confirm(msg, { okLabel, cancelLabel })
    }
    if (!confirmed) return

    const spec = H.buildPublishSpec({
      actionId: sel.actionId,
      identityIds: allowed,
      params: sel.params,
      options: drip,
    })
    await runPublish(spec, allowed)
  }

  async function schedulePublish(sel, allowed, platformLabel, drip) {
    const schedule = state.schedule.getSchedule()
    if (!schedule) {
      setStatus(t('publishingStudio.sched.invalid', 'Check the schedule fields'), 'red')
      return
    }
    const msg = t('publishingStudio.sched.confirm', {
      count: allowed.length,
      platform: platformLabel,
    })
    const okLabel = t('publishingStudio.sched.scheduleBtn', 'Schedule')
    const cancelLabel = t('common.cancel', 'Cancel')
    let confirmed = true
    if (window.OZ && window.OZ.ui && window.OZ.ui.confirm) {
      confirmed = await window.OZ.ui.confirm(msg, { okLabel, cancelLabel })
    }
    if (!confirmed) return

    const input = H.buildScheduleInput({
      name: t('publishingStudio.sched.nameAuto', { platform: platformLabel }),
      actionId: sel.actionId,
      identityIds: allowed,
      params: sel.params,
      schedule,
      options: drip,
    })
    try {
      await window.oz.scheduledActions.create(input)
      setStatus(t('publishingStudio.sched.created', 'Scheduled ✓'), 'green')
      if (state.scheduledList) await state.scheduledList.load()
    } catch (err) {
      setStatus(
        t('publishingStudio.publishFailed', { msg: (err && err.message) || 'error' }),
        'red',
      )
    }
  }

  async function runPublish(spec, allowed) {
    state.items = new Map()
    for (const id of allowed) state.items.set(id, { status: 'pending' })
    renderProgress()
    setStatus(t('publishingStudio.publishing', 'Publishing…'), 'yellow')
    try {
      const runId = await window.oz.bulk.run(spec)
      state.activeRunId = typeof runId === 'string' ? runId : runId && runId.runId
      refreshPublishButton()
    } catch (err) {
      setStatus(
        t('publishingStudio.publishFailed', { msg: (err && err.message) || 'error' }),
        'red',
      )
    }
  }

  function onProgress(payload) {
    if (!payload || (state.activeRunId && payload.runId !== state.activeRunId)) return
    const item = payload.item || {}
    if (item.identityId) {
      state.items.set(item.identityId, {
        name: item.identityName || item.identityId,
        status: item.status || 'running',
      })
      renderProgress()
    }
  }

  function onCompleted(payload) {
    if (!payload || (state.activeRunId && payload.runId !== state.activeRunId)) return
    state.activeRunId = null
    const summary = payload.summary || {}
    const ok = summary.success != null ? summary.success : countByStatus('success')
    const failed = summary.failed != null ? summary.failed : countByStatus('failed')
    setStatus(t('publishingStudio.done', { ok, failed }), failed > 0 ? 'yellow' : 'green')
    refreshPublishButton()
    if (state.history) state.history.load()
  }

  function countByStatus(status) {
    let n = 0
    for (const v of state.items.values()) if (v.status === status) n++
    return n
  }

  function renderProgress() {
    const box = $('pub-progress')
    box.innerHTML = ''
    for (const [id, info] of state.items.entries()) {
      const row = document.createElement('div')
      row.className = 'pub-prog-row'
      row.setAttribute('data-status', info.status || 'pending')
      const dot = document.createElement('span')
      dot.className = 'pub-prog-dot'
      const name = document.createElement('span')
      name.textContent = info.name || id
      const st = document.createElement('span')
      st.className = 'pub-prog-status'
      st.textContent = t(
        'publishingStudio.status.' + (info.status || 'pending'),
        info.status || 'pending',
      )
      row.appendChild(dot)
      row.appendChild(name)
      row.appendChild(st)
      box.appendChild(row)
    }
  }

  function setStatus(text, tone) {
    const elx = $('pub-status')
    elx.textContent = text
    elx.setAttribute('data-tone', tone || 'gray')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
