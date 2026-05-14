// OZ Browser — Scheduled Actions Settings UI (Bloque F-4b, v1).
//
// Renderiza la sección "Scheduled" del modal Settings. Cubre:
//   - status pill (running / stopped / not configured + actionCount)
//   - lista de acciones con toggle, edit, run-now, delete inline
//   - inline form para crear / editar acción, con conditional fields
//     según action type + schedule type
//
// Pattern: IIFE wrap (igual que el resto de UI scripts), instancia
// auto-inicializada cuando settings.js está cargado. Settings.js
// llama refresh() al activar la sección "scheduled" (showSection hook).
//
// Backend: window.oz.scheduledActions.* (preload bindings de F-3).
// Workspace list: window.oz.workspaces.list().
//
// La UI es deliberadamente minimalista — v1 es producto interno
// agencia, "wake-up routines simples". La automation engine completa
// con UI por cuenta de cliente es v2.

;(function () {
  class ScheduledActionsUI {
    constructor() {
      this.$section = document.querySelector('section[data-section="scheduled"]')
      if (!this.$section) return // markup no presente — modal viejo

      this.$pill = document.getElementById('oz-stg-scheduledStatusPill')
      this.$desc = document.getElementById('oz-stg-scheduledStatusDesc')
      this.$list = document.getElementById('oz-stg-scheduledList')
      this.$err = document.getElementById('oz-stg-scheduledError')
      this.$form = document.getElementById('oz-stg-scheduledForm')
      this.$newBtn = document.getElementById('oz-stg-scheduledNewBtn')
      this.$saveBtn = document.getElementById('oz-stg-schedFormSave')
      this.$cancelBtn = document.getElementById('oz-stg-schedFormCancel')

      this.$fName = document.getElementById('oz-stg-schedFormName')
      this.$fAction = document.getElementById('oz-stg-schedFormAction')
      this.$fWorkspace = document.getElementById('oz-stg-schedFormWorkspace')
      this.$fWorkspaceRow = document.getElementById('oz-stg-schedFormWorkspaceRow')
      this.$fSchedType = document.getElementById('oz-stg-schedFormSchedType')
      this.$fMinutesRow = document.getElementById('oz-stg-schedFormMinutesRow')
      this.$fMinutes = document.getElementById('oz-stg-schedFormMinutes')
      this.$fTimeRow = document.getElementById('oz-stg-schedFormTimeRow')
      this.$fTime = document.getElementById('oz-stg-schedFormTime')
      this.$fDayRow = document.getElementById('oz-stg-schedFormDayRow')
      this.$fDay = document.getElementById('oz-stg-schedFormDay')
      this.$fEnabled = document.getElementById('oz-stg-schedFormEnabled')

      this._editingId = null
      this._workspaces = []

      this._wire()
    }

    _wire() {
      if (this.$newBtn) this.$newBtn.addEventListener('click', () => this.openForm(null))
      if (this.$saveBtn) this.$saveBtn.addEventListener('click', () => this.save())
      if (this.$cancelBtn)
        this.$cancelBtn.addEventListener('click', () => this.closeForm())

      if (this.$fAction)
        this.$fAction.addEventListener('change', () => this._syncConditionalFields())
      if (this.$fSchedType)
        this.$fSchedType.addEventListener('change', () => this._syncConditionalFields())
    }

    async refresh() {
      if (!this.$section) return
      this.clearError()

      // Workspaces (for the selector in open-workspace mode)
      if (window.oz && window.oz.workspaces) {
        try {
          this._workspaces = (await window.oz.workspaces.list()) || []
        } catch {
          this._workspaces = []
        }
      }

      // Status pill
      if (window.oz && window.oz.scheduledActions) {
        try {
          const status = await window.oz.scheduledActions.getStatus()
          this._renderStatus(status)
        } catch {
          this._renderStatus(null)
        }

        const res = await window.oz.scheduledActions.list()
        if (res && res.ok) {
          this._renderList(res.actions || [])
        } else {
          this._renderList([])
        }
      }
    }

    _renderStatus(s) {
      if (!this.$pill || !this.$desc) return
      if (!s || !s.configured) {
        this.$pill.textContent = 'Not configured'
        this.$pill.className = 'oz-sync-pill oz-sync-pill-warning'
        this.$desc.textContent = 'Scheduled actions are not available in this build.'
        return
      }
      const count = s.actionCount || 0
      const word = count === 1 ? 'action' : 'actions'
      if (s.running) {
        this.$pill.textContent = `Running · ${count} ${word}`
        this.$pill.className = 'oz-sync-pill oz-sync-pill-running'
        this.$desc.textContent =
          count === 0
            ? 'Runner is on; create an action to schedule something.'
            : 'Runner is on, ticking every 60 s. Locked vault skips firing automatically.'
      } else {
        this.$pill.textContent = `Stopped · ${count} ${word}`
        this.$pill.className = 'oz-sync-pill oz-sync-pill-stopped'
        this.$desc.textContent = 'Runner is off.'
      }
    }

    _renderList(actions) {
      if (!this.$list) return
      if (actions.length === 0) {
        this.$list.innerHTML =
          '<div class="stg-desc" style="padding:12px 0">No scheduled actions yet. Click "+ New action" to create one.</div>'
        return
      }
      const rows = actions.map((a) => this._renderRow(a)).join('')
      this.$list.innerHTML = rows
      // Bind row events via delegation
      this.$list
        .querySelectorAll('[data-sa-toggle]')
        .forEach((el) =>
          el.addEventListener('change', () =>
            this.toggleEnabled(el.dataset.saToggle, el.checked),
          ),
        )
      this.$list
        .querySelectorAll('[data-sa-edit]')
        .forEach((el) =>
          el.addEventListener('click', () => this.openForm(el.dataset.saEdit)),
        )
      this.$list
        .querySelectorAll('[data-sa-run]')
        .forEach((el) =>
          el.addEventListener('click', () => this.runNow(el.dataset.saRun)),
        )
      this.$list
        .querySelectorAll('[data-sa-delete]')
        .forEach((el) =>
          el.addEventListener('click', () => this.deleteAction(el.dataset.saDelete)),
        )
    }

    _renderRow(a) {
      const checked = a.enabled ? 'checked' : ''
      const last = a.lastRunAt
        ? `Last fired ${new Date(a.lastRunAt).toLocaleString()}`
        : 'Never fired'
      const lastResult =
        a.lastResult && a.lastResult.ok === false
          ? ` · last error: ${esc(a.lastResult.error || 'unknown')}`
          : ''
      return `
        <div class="stg-row" data-id="${esc(a.id)}" style="padding:8px 0;border-top:1px solid var(--oz-border, #2a2a2a)">
          <div style="display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0">
            <input type="checkbox" data-sa-toggle="${esc(a.id)}" ${checked} title="Enable/disable"/>
            <div style="flex:1;min-width:0">
              <div class="stg-label" style="font-weight:600">${esc(a.name)}</div>
              <div class="stg-desc">${esc(this._summary(a))}</div>
              <div class="stg-desc" style="opacity:.7;font-size:11px">${esc(last)}${lastResult}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" class="stg-action-btn" data-sa-run="${esc(a.id)}">Run now</button>
            <button type="button" class="stg-action-btn" data-sa-edit="${esc(a.id)}">Edit</button>
            <button type="button" class="stg-action-btn" data-sa-delete="${esc(a.id)}">Delete</button>
          </div>
        </div>
      `
    }

    _summary(a) {
      const action = a.action
      const s = a.schedule || {}
      if (s.type === 'every-minutes') return `${action} · every ${s.minutes} min`
      if (s.type === 'daily') return `${action} · daily at ${s.time}`
      if (s.type === 'weekly') return `${action} · weekly on ${s.day} at ${s.time}`
      return `${action} · (unknown schedule)`
    }

    async openForm(id) {
      this._editingId = id
      this.clearError()
      // Populate workspace selector
      this._populateWorkspaceSelector()

      let action = null
      if (id && window.oz && window.oz.scheduledActions) {
        const res = await window.oz.scheduledActions.get(id)
        if (res && res.ok) action = res.action
      }

      if (action) {
        this.$fName.value = action.name
        this.$fAction.value = action.action
        if (action.params && action.params.workspaceId) {
          this.$fWorkspace.value = action.params.workspaceId
        }
        this.$fSchedType.value = action.schedule.type
        if (action.schedule.type === 'every-minutes') {
          this.$fMinutes.value = action.schedule.minutes
        } else if (action.schedule.type === 'daily') {
          this.$fTime.value = action.schedule.time
        } else if (action.schedule.type === 'weekly') {
          this.$fTime.value = action.schedule.time
          this.$fDay.value = action.schedule.day
        }
        this.$fEnabled.checked = action.enabled !== false
      } else {
        // Defaults for new action
        this.$fName.value = ''
        this.$fAction.value = 'open-workspace'
        this.$fWorkspace.value = this._workspaces.length > 0 ? this._workspaces[0].id : ''
        this.$fSchedType.value = 'daily'
        this.$fMinutes.value = 60
        this.$fTime.value = '09:00'
        this.$fDay.value = 'mon'
        this.$fEnabled.checked = true
      }
      this._syncConditionalFields()
      this.$form.hidden = false
    }

    closeForm() {
      this.$form.hidden = true
      this._editingId = null
      this.clearError()
    }

    _populateWorkspaceSelector() {
      if (!this.$fWorkspace) return
      const opts = this._workspaces
        .map((w) => `<option value="${esc(w.id)}">${esc(w.name || w.id)}</option>`)
        .join('')
      this.$fWorkspace.innerHTML = opts || '<option value="">(no workspaces yet)</option>'
    }

    _syncConditionalFields() {
      if (!this.$fAction || !this.$fSchedType) return
      const action = this.$fAction.value
      const sched = this.$fSchedType.value
      // Workspace row only when action needs it
      if (this.$fWorkspaceRow) {
        this.$fWorkspaceRow.hidden = action !== 'open-workspace'
      }
      // Schedule conditional fields
      if (this.$fMinutesRow) this.$fMinutesRow.hidden = sched !== 'every-minutes'
      if (this.$fTimeRow)
        this.$fTimeRow.hidden = !(sched === 'daily' || sched === 'weekly')
      if (this.$fDayRow) this.$fDayRow.hidden = sched !== 'weekly'
    }

    async save() {
      this.clearError()
      const input = this._collectFormInput()
      if (!input) return
      let res
      if (this._editingId) {
        // Update — only mutable fields, no params for actions that don't need it
        const patch = {
          name: input.name,
          action: input.action,
          params: input.params,
          schedule: input.schedule,
          enabled: input.enabled,
        }
        res = await window.oz.scheduledActions.update(this._editingId, patch)
      } else {
        res = await window.oz.scheduledActions.create(input)
      }
      if (!res || !res.ok) {
        this.showError(
          `Save failed: ${(res && (res.reason || res.message)) || 'unknown'}`,
        )
        return
      }
      this.closeForm()
      await this.refresh()
    }

    _collectFormInput() {
      const name = (this.$fName.value || '').trim()
      if (!name) {
        this.showError('Name is required.')
        return null
      }
      const action = this.$fAction.value
      const schedType = this.$fSchedType.value
      let schedule = null
      if (schedType === 'every-minutes') {
        const m = parseInt(this.$fMinutes.value, 10)
        if (!Number.isFinite(m) || m < 1 || m > 1440) {
          this.showError('Minutes must be between 1 and 1440.')
          return null
        }
        schedule = { type: 'every-minutes', minutes: m }
      } else if (schedType === 'daily') {
        if (!/^\d{2}:\d{2}$/.test(this.$fTime.value)) {
          this.showError('Time must be HH:MM.')
          return null
        }
        schedule = { type: 'daily', time: this.$fTime.value }
      } else if (schedType === 'weekly') {
        if (!/^\d{2}:\d{2}$/.test(this.$fTime.value)) {
          this.showError('Time must be HH:MM.')
          return null
        }
        schedule = {
          type: 'weekly',
          day: this.$fDay.value,
          time: this.$fTime.value,
        }
      }
      const params = {}
      if (action === 'open-workspace') {
        if (!this.$fWorkspace.value) {
          this.showError('Pick a workspace to open.')
          return null
        }
        params.workspaceId = this.$fWorkspace.value
      }
      return {
        name,
        action,
        params,
        schedule,
        enabled: this.$fEnabled.checked,
      }
    }

    async toggleEnabled(id, enabled) {
      this.clearError()
      const res = await window.oz.scheduledActions.setEnabled(id, enabled)
      if (!res || !res.ok) {
        this.showError(
          `Toggle failed: ${(res && (res.reason || res.message)) || 'unknown'}`,
        )
      }
      await this.refresh()
    }

    async runNow(id) {
      this.clearError()
      // Force a tick; in v1 this iterates all due actions, not just this one.
      // For pinpoint "run this one now" we'd need a force-fire API in F-1;
      // good v2 candidate. For v1, "Run now" still feels useful because the
      // user can tweak schedule then click to see it fire immediately.
      const res = await window.oz.scheduledActions.tickNow()
      if (!res || !res.ok) {
        this.showError(`Run failed: ${(res && (res.reason || res.message)) || 'unknown'}`)
      }
      // Highlight the row that was likely the target so the user has feedback
      // about which row's last-fired timestamp got refreshed.
      void id
      await this.refresh()
    }

    async deleteAction(id) {
      this.clearError()
      const res = await window.oz.scheduledActions.remove(id)
      if (!res || !res.ok) {
        this.showError(
          `Delete failed: ${(res && (res.reason || res.message)) || 'unknown'}`,
        )
      }
      await this.refresh()
    }

    showError(msg) {
      if (this.$err) {
        this.$err.textContent = msg
        this.$err.hidden = false
      }
    }
    clearError() {
      if (this.$err) {
        this.$err.hidden = true
        this.$err.textContent = ''
      }
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    )
  }

  // Expose so settings.js showSection hook can call refresh() on activate.
  window.OZ = window.OZ || {}
  window.OZ.scheduledActionsUI = new ScheduledActionsUI()
})()
