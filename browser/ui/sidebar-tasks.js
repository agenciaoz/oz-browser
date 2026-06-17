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

  // alpha.46: store is per-workspace ({ [wsId]: Task[] }); migrateStore lifts
  // the alpha.45 flat array into the 'general' bucket.
  function loadStore() {
    const U = window.OZ.SidebarTasksUtils
    try {
      const raw = localStorage.getItem(TASKS_KEY)
      return U.migrateStore(raw ? JSON.parse(raw) : {})
    } catch (_e) {
      return {}
    }
  }
  function saveStore(store) {
    try {
      localStorage.setItem(TASKS_KEY, JSON.stringify(store || {}))
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
      // alpha.46: per-workspace store + the active workspace id (resolved async).
      this.store = loadStore()
      this.wsId = null
      this.windowId = null
      this.collapsed = this._loadCollapsed()
      this._wire()
      this._render()
      this._initWorkspace()
    }

    /** The current workspace's task list. */
    _list() {
      return window.OZ.SidebarTasksUtils.listFor(this.store, this.wsId)
    }

    /** Resolve our window + active workspace, and follow workspace switches. */
    async _initWorkspace() {
      if (!window.oz || !window.oz.workspaces) return
      if (typeof window.oz.getWindowId === 'function') {
        try {
          this.windowId = await window.oz.getWindowId()
        } catch (_e) {
          /* ignore */
        }
      }
      try {
        this.wsId = await window.oz.workspaces.getActive()
      } catch (_e) {
        /* ignore */
      }
      this._render()
      if (window.oz.workspaces.onActiveChanged) {
        window.oz.workspaces.onActiveChanged((payload) => {
          // Broadcast to every window — only react to our own (when known).
          if (
            this.windowId != null &&
            payload &&
            payload.windowId != null &&
            payload.windowId !== this.windowId
          ) {
            return
          }
          const id = payload && payload.workspaceId
          if (id && id !== this.wsId) {
            this.wsId = id
            this._render()
          }
        })
      }
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
          if (!this.wsId) return
          const U = window.OZ.SidebarTasksUtils
          this._setList(U.addTask(this._list(), this.$input.value))
          this.$input.value = ''
        })
      }
      if (this.$clear) {
        this.$clear.addEventListener('click', () => {
          if (!this.wsId) return
          const U = window.OZ.SidebarTasksUtils
          this._setList(U.clearCompleted(this._list()))
        })
      }
    }

    /** Replace the current workspace's list, persist, re-render. */
    _setList(list) {
      const U = window.OZ.SidebarTasksUtils
      this.store = U.withList(this.store, this.wsId, list)
      saveStore(this.store)
      this._render()
    }

    _render() {
      const U = window.OZ.SidebarTasksUtils
      const tasks = this._list()
      this.$root.classList.toggle('collapsed', this.collapsed)

      const chevron = this.$header && this.$header.querySelector('.oz-tasks-chevron')
      if (chevron) chevron.classList.toggle('expanded', !this.collapsed)

      const p = U.progress(tasks)
      if (this.$progress) {
        this.$progress.textContent = p.total ? `${p.done}/${p.total}` : ''
      }

      if (this.collapsed || !this.$list) return

      this.$list.innerHTML = ''
      if (tasks.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'oz-tasks-empty'
        empty.textContent = t('tasks.empty')
        this.$list.appendChild(empty)
      } else {
        for (const task of tasks) {
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
        this._setList(U.toggleTask(this._list(), task.id))
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
        this._setList(U.removeTask(this._list(), task.id))
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
