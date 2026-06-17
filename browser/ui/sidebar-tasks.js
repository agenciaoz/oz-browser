// OZ Browser — Tasks module (alpha.45, Ghost parity).
//
// A collapsible checklist at the bottom of the sidebar: add tasks, check them
// off, remove, clear completed, with a done/total progress indicator. UI-only
// persistence in localStorage (oz-tasks + oz-tasks-collapsed), consistent with
// the App Dock / sidebar prefs. Pure list logic lives in sidebar-tasks-utils.js.
//
// Global list for v1 (one checklist across workspaces). Per-workspace lists are
// a possible future enhancement.

;(function () {
  'use strict'

  const TASKS_KEY = 'oz-tasks'
  const COLLAPSED_KEY = 'oz-tasks-collapsed'

  function t(key) {
    if (window.oz && window.oz.i18n && typeof window.oz.i18n.t === 'function') {
      return window.oz.i18n.t(key)
    }
    return key
  }

  function load() {
    const U = window.OZ.SidebarTasksUtils
    try {
      const raw = localStorage.getItem(TASKS_KEY)
      return U.sanitize(raw ? JSON.parse(raw) : [])
    } catch (_e) {
      return []
    }
  }
  function save(tasks) {
    try {
      localStorage.setItem(TASKS_KEY, JSON.stringify(tasks || []))
    } catch (_e) {
      /* ignore */
    }
  }

  class TasksModule {
    constructor() {
      this.$root = document.getElementById('oz-tasks')
      if (!this.$root) return
      this.$header = document.getElementById('oz-tasks-header')
      this.$progress = document.getElementById('oz-tasks-progress')
      this.$list = document.getElementById('oz-tasks-list')
      this.$form = document.getElementById('oz-tasks-add')
      this.$input = document.getElementById('oz-tasks-input')
      this.$clear = document.getElementById('oz-tasks-clear')
      this.tasks = load()
      this.collapsed = this._loadCollapsed()
      this._wire()
      this._render()
    }

    _loadCollapsed() {
      try {
        return localStorage.getItem(COLLAPSED_KEY) !== '0' // default collapsed
      } catch (_e) {
        return true
      }
    }
    _saveCollapsed() {
      try {
        localStorage.setItem(COLLAPSED_KEY, this.collapsed ? '1' : '0')
      } catch (_e) {
        /* ignore */
      }
    }

    _wire() {
      if (this.$header) {
        this.$header.addEventListener('click', () => {
          this.collapsed = !this.collapsed
          this._saveCollapsed()
          this._render()
        })
      }
      if (this.$form) {
        this.$form.addEventListener('submit', (ev) => {
          ev.preventDefault()
          const U = window.OZ.SidebarTasksUtils
          this.tasks = U.addTask(this.tasks, this.$input.value)
          this.$input.value = ''
          this._persistAndRender()
        })
      }
      if (this.$clear) {
        this.$clear.addEventListener('click', () => {
          const U = window.OZ.SidebarTasksUtils
          this.tasks = U.clearCompleted(this.tasks)
          this._persistAndRender()
        })
      }
    }

    _persistAndRender() {
      save(this.tasks)
      this._render()
    }

    _render() {
      const U = window.OZ.SidebarTasksUtils
      this.$root.classList.toggle('collapsed', this.collapsed)

      const chevron = this.$header && this.$header.querySelector('.oz-tasks-chevron')
      if (chevron) chevron.classList.toggle('expanded', !this.collapsed)

      const p = U.progress(this.tasks)
      if (this.$progress) {
        this.$progress.textContent = p.total ? `${p.done}/${p.total}` : ''
      }

      if (this.collapsed || !this.$list) return

      this.$list.innerHTML = ''
      if (this.tasks.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'oz-tasks-empty'
        empty.textContent = t('tasks.empty')
        this.$list.appendChild(empty)
      } else {
        for (const task of this.tasks) {
          this.$list.appendChild(this._renderRow(task))
        }
      }
      if (this.$input) this.$input.placeholder = t('tasks.addPlaceholder')
      if (this.$clear) {
        this.$clear.textContent = t('tasks.clearDone')
        this.$clear.style.display = p.done > 0 ? '' : 'none'
      }
    }

    _renderRow(task) {
      const U = window.OZ.SidebarTasksUtils
      const row = document.createElement('div')
      row.className = 'oz-task-row' + (task.done ? ' done' : '')

      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = task.done
      cb.addEventListener('change', () => {
        this.tasks = U.toggleTask(this.tasks, task.id)
        this._persistAndRender()
      })
      row.appendChild(cb)

      const label = document.createElement('span')
      label.className = 'oz-task-text'
      label.textContent = task.text
      row.appendChild(label)

      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'oz-task-del'
      del.textContent = '✕'
      del.title = t('tasks.remove')
      del.addEventListener('click', () => {
        this.tasks = U.removeTask(this.tasks, task.id)
        this._persistAndRender()
      })
      row.appendChild(del)

      return row
    }
  }

  function init() {
    window.OZ = window.OZ || {}
    if (window.OZ.tasksModule) return
    window.OZ.tasksModule = new TasksModule()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
