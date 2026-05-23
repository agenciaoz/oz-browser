// OZ Browser — Bulk Runner modal UI (v2 sub-bloque 2).
//
// Composer + live progress + result reporter en un modal único con dos
// fases: 'compose' (form para crear run) y 'running' (tabla en vivo).
//
// Triggers wired (sub-bloque 2 ships con uno; el resto se agregan después):
//   - Cmd+K palette entry "Bulk Run" (sub-bloque 2)
//   - Cmd+Shift+B accelerator (sub-bloque 2)
//   - Sidebar button (TODO sub-bloque siguiente)
//
// Markup: oz-br-* ids en webui.html. La modal usa el pattern de account-manager:
// header + sections con `hidden` toggling.
//
// IIFE-wrapped — ver oz-utils.js comment.

;(function () {
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  function _escapeHtml(s) {
    if (s == null) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  // Friendly explanations per error code. Shown as tooltip on hover so
  // Jose no needs to read source to understand what failed.
  const ERROR_CODE_EXPLAIN = {
    needs_login:
      'Identity is not logged in to the platform. Auto-login retry will use vault credentials if wired.',
    captcha: 'Platform showed a captcha/security challenge. Solve manually then retry.',
    'not-found':
      'Target element (button/post/profile) not found. Selectors may be stale or URL invalid.',
    'click-failed':
      'Click registered but state did not flip. Usually rate-limit or action-block.',
    'submit-failed':
      'Form submit clicked but no confirmation. Usually rate-limit or platform-side reject.',
    'rate-limit':
      'Identity hit the daily cap for this action. Will reset at UTC midnight.',
    'image-missing': 'imagePath does not exist on disk.',
    aborted: 'Run was cancelled mid-action.',
  }

  const LOGIN_CODE_EXPLAIN = {
    'vault-locked': 'Vault is locked. Open Account Manager and unlock it.',
    'no-credentials':
      'No account stored for this (identity, platform). Add one in Account Manager.',
    'totp-needed-no-secret':
      'Platform asked for 2FA code but the account has no totpSecret stored. Add it in Account Manager.',
    'login-failed':
      'Filled the form + submitted but page still shows login. Wrong password / rate-limited / captcha.',
    'unsupported-platform': 'No login flow registered for this platform yet.',
    aborted: 'Login attempt was cancelled by the run signal.',
  }

  // Map de status → label corto + clase CSS.
  const STATUS_LABELS = {
    pending: { text: '⏳', cls: 'oz-br-st-pending' },
    running: { text: '▶︎', cls: 'oz-br-st-running' },
    done: { text: '✓', cls: 'oz-br-st-done' },
    failed: { text: '✗', cls: 'oz-br-st-failed' },
    cancelled: { text: '⊘', cls: 'oz-br-st-cancelled' },
    skipped: { text: '⤼', cls: 'oz-br-st-skipped' },
  }

  class BulkRunnerUI {
    constructor() {
      this.$modal = document.getElementById('oz-br-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/bulk-runner', 'modal markup missing')
        }
        return
      }
      this.$compose = document.getElementById('oz-br-compose')
      this.$running = document.getElementById('oz-br-running')
      this.$error = document.getElementById('oz-br-error')

      // Compose phase elements.
      this.$action = document.getElementById('oz-br-action')
      this.$actionDesc = document.getElementById('oz-br-action-desc')
      this.$paramsContainer = document.getElementById('oz-br-params-container')
      this.$idList = document.getElementById('oz-br-id-list')
      this.$idSearch = document.getElementById('oz-br-id-search')
      this.$idSelectAll = document.getElementById('oz-br-id-select-all')
      this.$idCount = document.getElementById('oz-br-id-count')
      this.$minDelay = document.getElementById('oz-br-min-delay')
      this.$maxDelay = document.getElementById('oz-br-max-delay')
      this.$submit = document.getElementById('oz-br-submit')
      this.$schedule = document.getElementById('oz-br-schedule')

      // Running phase elements.
      this.$runActionLabel = document.getElementById('oz-br-run-action-label')
      this.$runStatus = document.getElementById('oz-br-run-status')
      this.$stats = document.getElementById('oz-br-stats')
      this.$tableBody = document.getElementById('oz-br-table-body')
      this.$cancelRun = document.getElementById('oz-br-cancel-run')
      this.$newRun = document.getElementById('oz-br-new-run')

      // State.
      this.actions = []
      this.currentAction = null
      this.identities = []
      this.selected = new Set()
      this.searchTerm = ''
      this.activeRunId = null
      this.activeRun = null
      this.unsubProgress = null
      this.unsubCompleted = null

      this._wire()
    }

    // ---------- public ------------------------------------------------------

    async open() {
      try {
        this.$error.hidden = true
        await this._reloadActions()
        await this._reloadIdentities()
        this._setPhase('compose')
        this.$modal.hidden = false
      } catch (err) {
        this._showError(err && err.message ? err.message : String(err))
      }
    }

    close() {
      this.$modal.hidden = true
      this._teardownLiveListeners()
      this.activeRunId = null
    }

    // ---------- wire --------------------------------------------------------

    _wire() {
      // Close handlers.
      for (const el of this.$modal.querySelectorAll('[data-close]')) {
        el.addEventListener('click', () => this.close())
      }
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.$modal.hidden) this.close()
      })

      this.$action.addEventListener('change', () => this._onActionChanged())
      this.$idSearch.addEventListener('input', (e) => {
        this.searchTerm = e.target.value.toLowerCase()
        this._renderIdList()
      })
      this.$idSelectAll.addEventListener('change', (e) => {
        const visible = this._visibleIdentities()
        if (e.target.checked) {
          for (const id of visible) this.selected.add(id.id)
        } else {
          for (const id of visible) this.selected.delete(id.id)
        }
        this._renderIdList()
        this._updateIdCount()
      })

      this.$submit.addEventListener('click', () => this._submit())
      if (this.$schedule) {
        this.$schedule.addEventListener('click', () => this._schedule())
      }
      this.$cancelRun.addEventListener('click', () => this._cancelRun())
      this.$newRun.addEventListener('click', () => this._setPhase('compose'))

      // i18n re-render on locale switch.
      if (window.OZ && window.OZ.i18n && window.OZ.i18n.onChange) {
        window.OZ.i18n.onChange(() => {
          if (this.$modal.hidden) return
          this._renderActionOptions()
          this._renderActionDesc()
          this._renderIdList()
          this._updateIdCount()
          if (this.activeRun) this._renderRunningView()
        })
      }
    }

    // ---------- data load ---------------------------------------------------

    async _reloadActions() {
      if (!window.oz || !window.oz.bulk) {
        throw new Error('bulk runner not available')
      }
      this.actions = (await window.oz.bulk.listActions()) || []
      this._renderActionOptions()
      this._onActionChanged()
    }

    async _reloadIdentities() {
      this.identities = (await window.oz.identities.list()) || []
      // Default: select all.
      this.selected = new Set(this.identities.map((i) => i.id))
      this._renderIdList()
      this._updateIdCount()
    }

    // ---------- compose phase -----------------------------------------------

    _renderActionOptions() {
      this.$action.innerHTML = ''
      for (const a of this.actions) {
        const opt = document.createElement('option')
        opt.value = a.id
        opt.textContent = a.label
        this.$action.appendChild(opt)
      }
    }

    _onActionChanged() {
      const id = this.$action.value
      this.currentAction = this.actions.find((a) => a.id === id) || null
      this._renderActionDesc()
      this._renderParamsForm()
    }

    _renderActionDesc() {
      this.$actionDesc.textContent = this.currentAction
        ? this.currentAction.description || ''
        : ''
    }

    _renderParamsForm() {
      this.$paramsContainer.innerHTML = ''
      if (!this.currentAction) return
      const schema = this.currentAction.paramsSchema || {}
      const props = schema.properties || {}
      const required = new Set(schema.required || [])
      for (const [key, def] of Object.entries(props)) {
        const wrap = document.createElement('label')
        wrap.className = 'oz-br-param-field'
        const span = document.createElement('span')
        span.textContent = key + (required.has(key) ? ' *' : '')
        wrap.appendChild(span)
        let input
        if (def.type === 'number') {
          input = document.createElement('input')
          input.type = 'number'
          if (def.minimum != null) input.min = def.minimum
          if (def.maximum != null) input.max = def.maximum
          input.step = '1'
        } else if (def.enum && Array.isArray(def.enum)) {
          input = document.createElement('select')
          for (const v of def.enum) {
            const o = document.createElement('option')
            o.value = v
            o.textContent = v
            input.appendChild(o)
          }
        } else {
          input = document.createElement('input')
          input.type = 'text'
        }
        input.name = key
        input.dataset.param = key
        input.dataset.paramType = def.type || 'string'
        if (def.description) input.title = def.description
        wrap.appendChild(input)
        this.$paramsContainer.appendChild(wrap)
      }
    }

    _collectParams() {
      const out = {}
      for (const el of this.$paramsContainer.querySelectorAll('[data-param]')) {
        const key = el.dataset.param
        const type = el.dataset.paramType
        const v = el.value
        if (v === '' || v == null) continue
        if (type === 'number') {
          const n = Number(v)
          if (Number.isFinite(n)) out[key] = n
        } else {
          out[key] = v
        }
      }
      return out
    }

    _visibleIdentities() {
      if (!this.searchTerm) return this.identities
      return this.identities.filter((i) =>
        (i.name || '').toLowerCase().includes(this.searchTerm),
      )
    }

    _renderIdList() {
      this.$idList.innerHTML = ''
      const visible = this._visibleIdentities()
      for (const id of visible) {
        const li = document.createElement('li')
        const lbl = document.createElement('label')
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = this.selected.has(id.id)
        cb.addEventListener('change', () => {
          if (cb.checked) this.selected.add(id.id)
          else this.selected.delete(id.id)
          this._updateIdCount()
        })
        const swatch = document.createElement('span')
        swatch.className = 'oz-id-swatch'
        if (id.color) swatch.style.background = '#' + String(id.color).replace(/^#/, '')
        lbl.appendChild(cb)
        lbl.appendChild(swatch)
        const name = document.createElement('span')
        name.className = 'oz-id-name'
        name.textContent = id.name || id.id
        lbl.appendChild(name)
        li.appendChild(lbl)
        this.$idList.appendChild(li)
      }
    }

    _updateIdCount() {
      this.$idCount.textContent = t('bulkRunner.compose.countLabel', {
        n: this.selected.size,
      })
    }

    // v2 Etapa 2.1 — delegate to bulk-runner-schedule.js helper.
    async _schedule() {
      this.$error.hidden = true
      const spec = this._buildSpec()
      if (!spec) return
      const helper = window.OZ && window.OZ.bulkRunnerSchedule
      if (!helper) return this._showError('Schedule helper not loaded.')
      await helper.scheduleBulkRun({
        spec,
        onError: (msg) => this._showError(msg),
        onSuccess: (name, sched) =>
          window.alert(
            `Scheduled "${name}".\nNext run: ${helper.describeSchedule(sched)}.\nManage in Settings → Scheduled Actions.`,
          ),
      })
    }

    _buildSpec() {
      if (!this.currentAction) {
        this._showError(t('bulkRunner.error.noAction'))
        return null
      }
      if (this.selected.size === 0) {
        this._showError(t('bulkRunner.error.noIdentities'))
        return null
      }
      const params = this._collectParams()
      const required = new Set(
        (this.currentAction.paramsSchema && this.currentAction.paramsSchema.required) ||
          [],
      )
      for (const req of required) {
        if (!(req in params) || params[req] === '') {
          this._showError(t('bulkRunner.error.missingParam', { param: req }))
          return null
        }
      }
      const minS = Number(this.$minDelay.value)
      const maxS = Number(this.$maxDelay.value)
      if (!Number.isFinite(minS) || !Number.isFinite(maxS) || minS < 0 || maxS < minS) {
        this._showError(t('bulkRunner.error.badDelays'))
        return null
      }
      return {
        actionId: this.currentAction.id,
        identityIds: Array.from(this.selected),
        params,
        options: { minDelayMs: minS * 1000, maxDelayMs: maxS * 1000 },
      }
    }

    async _submit() {
      this.$error.hidden = true
      const spec = this._buildSpec()
      if (!spec) return
      this.$submit.disabled = true
      try {
        const res = await window.oz.bulk.run(spec)
        if (res && res.__error) {
          this.$submit.disabled = false
          return this._showError(res.__error.message || 'failed')
        }
        if (!res || !res.runId) {
          this.$submit.disabled = false
          return this._showError('unexpected response')
        }
        this.activeRunId = res.runId
        await this._loadActiveRun()
        this._setupLiveListeners()
        this._setPhase('running')
      } catch (err) {
        this.$submit.disabled = false
        this._showError(err && err.message ? err.message : String(err))
      }
    }

    async _loadActiveRun() {
      this.activeRun = await window.oz.bulk.get(this.activeRunId)
      this._renderRunningView()
    }

    _setupLiveListeners() {
      this._teardownLiveListeners()
      this.unsubProgress = window.oz.bulk.onProgress((evt) => {
        if (!this.activeRunId || evt.runId !== this.activeRunId) return
        if (!this.activeRun) return
        this.activeRun.items[evt.index] = evt.item
        // Recompute stats on the fly.
        this._recomputeStats()
        this._renderRunningView()
      })
      this.unsubCompleted = window.oz.bulk.onCompleted((evt) => {
        if (!this.activeRunId || evt.runId !== this.activeRunId) return
        if (this.activeRun) this.activeRun.meta = evt.meta
        this._renderRunningView()
        this.$cancelRun.hidden = true
        this.$newRun.hidden = false
      })
    }

    _teardownLiveListeners() {
      if (this.unsubProgress) {
        try {
          this.unsubProgress()
        } catch (_e) {
          // noop
        }
        this.unsubProgress = null
      }
      if (this.unsubCompleted) {
        try {
          this.unsubCompleted()
        } catch (_e) {
          // noop
        }
        this.unsubCompleted = null
      }
    }

    _recomputeStats() {
      if (!this.activeRun) return
      const s = { done: 0, failed: 0, skipped: 0, cancelled: 0 }
      for (const it of this.activeRun.items) {
        if (it.status === 'done') s.done++
        else if (it.status === 'failed') s.failed++
        else if (it.status === 'skipped') s.skipped++
        else if (it.status === 'cancelled') s.cancelled++
      }
      this.activeRun.meta.stats = s
    }

    // ---------- running phase -----------------------------------------------

    _renderRunningView() {
      if (!this.activeRun) return
      const { meta, items } = this.activeRun
      this.$runActionLabel.textContent = meta.actionLabel || meta.actionId
      this.$runStatus.textContent = meta.status
      this.$runStatus.dataset.status = meta.status
      const total = items.length
      const stats = meta.stats || {}
      this.$stats.textContent = t('bulkRunner.running.statsText', {
        total,
        done: stats.done || 0,
        failed: stats.failed || 0,
        cancelled: stats.cancelled || 0,
      })
      // Table rows.
      this.$tableBody.innerHTML = ''
      for (const it of items) {
        const tr = document.createElement('tr')
        const tdId = document.createElement('td')
        tdId.textContent = it.identityName || it.identityId
        const tdSt = document.createElement('td')
        const st = STATUS_LABELS[it.status] || { text: it.status, cls: '' }
        tdSt.innerHTML = `<span class="oz-br-st ${st.cls}">${st.text}</span> ${it.status}`
        const tdRes = document.createElement('td')
        if (it.status === 'skipped' && it.error && it.error.code === 'rate-limit') {
          const tip = ERROR_CODE_EXPLAIN['rate-limit'] || ''
          tdRes.innerHTML =
            `<strong title="${_escapeHtml(tip)}">⏱️ rate-limit</strong> · ` +
            _escapeHtml(it.error.message || 'daily cap reached')
          tdRes.className = 'oz-br-cell-error'
        } else if (it.status === 'failed' && it.error) {
          // Surface error.code as a bold prefix with explain tooltip.
          let codePart = ''
          if (it.error.code) {
            const tip = ERROR_CODE_EXPLAIN[it.error.code] || ''
            codePart = `<strong title="${_escapeHtml(tip)}">${_escapeHtml(it.error.code)}</strong> · `
          }
          let inner = codePart + _escapeHtml(it.error.message || 'error')
          // Surface loginAttempt info if the runner tried auto-login and it failed.
          if (it.loginAttempt && it.loginAttempt.ok === false) {
            const la = it.loginAttempt
            const laTip = LOGIN_CODE_EXPLAIN[la.code] || ''
            inner +=
              `<br /><span class="oz-br-loginattempt">🔐 ` +
              `auto-login: <strong title="${_escapeHtml(laTip)}">${_escapeHtml(la.code || 'unknown')}</strong>` +
              (la.message ? ` — ${_escapeHtml(la.message)}` : '') +
              `</span>`
          }
          tdRes.innerHTML = inner
          tdRes.className = 'oz-br-cell-error'
        } else if (it.result) {
          let inner =
            typeof it.result === 'string'
              ? _escapeHtml(it.result)
              : _escapeHtml(JSON.stringify(it.result).slice(0, 120))
          // Surface successful auto-login retry as a small badge.
          if (it.loginAttempt && it.loginAttempt.ok === true) {
            inner =
              `<span class="oz-br-loginattempt-ok" title="Auto-login retry succeeded">🔐 re-logged</span> ` +
              inner
          }
          tdRes.innerHTML = inner
        } else {
          tdRes.textContent = '—'
        }
        tr.appendChild(tdId)
        tr.appendChild(tdSt)
        tr.appendChild(tdRes)
        this.$tableBody.appendChild(tr)
      }
      // Toggle action buttons based on status.
      const terminal = ['completed', 'failed', 'cancelled'].includes(meta.status)
      this.$cancelRun.hidden = terminal
      this.$newRun.hidden = !terminal
      this.$submit.disabled = false
    }

    async _cancelRun() {
      if (!this.activeRunId) return
      try {
        await window.oz.bulk.cancel(this.activeRunId)
      } catch (err) {
        this._showError(err && err.message ? err.message : String(err))
      }
    }

    // ---------- helpers -----------------------------------------------------

    _setPhase(phase) {
      this.$compose.hidden = phase !== 'compose'
      this.$running.hidden = phase !== 'running'
      this.$error.hidden = true
      if (phase === 'compose') {
        // Reset submit state and clear any prior active run; live listeners
        // stay torn down — _setupLiveListeners is idempotent.
        this.activeRunId = null
        this.activeRun = null
        this._teardownLiveListeners()
        this.$submit.disabled = false
      }
    }

    _showError(msg) {
      this.$error.textContent = msg
      this.$error.hidden = false
    }
  }

  // Expose singleton on window.OZ for command-palette / keyboard shortcut
  // wiring (sub-bloque 2 + later).
  if (!window.OZ) window.OZ = {}
  let _instance = null
  function getInstance() {
    if (!_instance) _instance = new BulkRunnerUI()
    return _instance
  }
  window.OZ.bulkRunnerUI = {
    open: () => getInstance().open(),
    close: () => getInstance().close(),
  }

  // Cmd+Shift+B accelerator.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'B') {
      e.preventDefault()
      window.OZ.bulkRunnerUI.open()
    }
  })
})()
