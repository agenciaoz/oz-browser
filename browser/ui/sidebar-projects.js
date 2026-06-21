// OZ Browser — Projects sidebar module (F2 UI, Ghost-style save/restore).
//
// Sección colapsable "Proyectos" en el sidebar: guardar el workspace activo o
// toda la sesión como proyecto con nombre, y listar/abrir/borrar. Los datos
// vienen del backend vía window.oz.projects (NO localStorage). Espeja el patrón
// de sidebar-tasks.js. Lógica pura en sidebar-projects-utils.js.
//
// ADR: 0005 (modular).

;(function () {
  'use strict'

  const COLLAPSED_KEY = 'oz-projects-collapsed'

  class ProjectsModule {
    constructor() {
      this.$root = document.getElementById('oz-projects')
      if (!this.$root) return
      this.$header = document.getElementById('oz-projects-header')
      this.$count = document.getElementById('oz-projects-count')
      this.$list = document.getElementById('oz-projects-list')
      this.$saveWs = document.getElementById('oz-projects-save-ws')
      this.$saveAll = document.getElementById('oz-projects-save-all')
      this.projects = []
      this.collapsed = this._loadCollapsed()
      this._wire()
      this._applyCollapsed()
      this.refresh()
    }

    _loadCollapsed() {
      try {
        return localStorage.getItem(COLLAPSED_KEY) === '1'
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
    _applyCollapsed() {
      if (!this.$root) return
      this.$root.classList.toggle('collapsed', this.collapsed)
    }

    _wire() {
      if (this.$header) {
        this.$header.addEventListener('click', () => {
          this.collapsed = !this.collapsed
          this._applyCollapsed()
          this._saveCollapsed()
        })
      }
      if (this.$saveWs) {
        this.$saveWs.addEventListener('click', () => this._save('workspace'))
      }
      if (this.$saveAll) {
        this.$saveAll.addEventListener('click', () => this._save('session'))
      }
    }

    async refresh() {
      if (!window.oz || !window.oz.projects) return
      let list = []
      try {
        list = (await window.oz.projects.list()) || []
      } catch (_e) {
        list = []
      }
      const U = window.OZ.SidebarProjectsUtils
      this.projects = U ? U.sortProjects(list) : list
      this._render()
    }

    async _save(type) {
      const U = window.OZ.SidebarProjectsUtils
      const label = type === 'session' ? 'todos los workspaces' : 'este workspace'
      let name = await window.OZ.ui.prompt(`Nombre del proyecto (${label})`)
      name = U ? U.cleanName(name) : (name || '').trim()
      if (!name) return
      try {
        await window.oz.projects.save(name, type)
      } catch (_e) {
        /* ignore */
      }
      this.refresh()
    }

    async _open(id) {
      try {
        await window.oz.projects.open(id)
      } catch (_e) {
        /* ignore */
      }
    }

    async _remove(id, name) {
      const ok = await window.OZ.ui.confirm(`¿Borrar el proyecto "${name}"?`)
      if (!ok) return
      try {
        await window.oz.projects.remove(id)
      } catch (_e) {
        /* ignore */
      }
      this.refresh()
    }

    _render() {
      if (!this.$list) return
      const U = window.OZ.SidebarProjectsUtils
      if (this.$count) this.$count.textContent = this.projects.length || ''
      this.$list.innerHTML = ''
      if (this.projects.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'oz-projects-empty'
        empty.textContent = 'Sin proyectos guardados'
        this.$list.appendChild(empty)
        return
      }
      for (const p of this.projects) {
        const row = document.createElement('div')
        row.className = 'oz-projects-row'

        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'oz-projects-open'
        open.title = 'Abrir proyecto'
        const summary = U ? U.projectSummary(p) : ''
        open.innerHTML = `<span class="oz-projects-name"></span><span class="oz-projects-meta"></span>`
        open.querySelector('.oz-projects-name').textContent = p.name
        open.querySelector('.oz-projects-meta').textContent = summary
        open.addEventListener('click', () => this._open(p.id))
        row.appendChild(open)

        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'oz-projects-del'
        del.title = 'Borrar'
        del.textContent = '✕'
        del.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this._remove(p.id, p.name)
        })
        row.appendChild(del)

        this.$list.appendChild(row)
      }
    }
  }

  function init() {
    window.OZ = window.OZ || {}
    if (window.OZ.projectsModule) return
    window.OZ.projectsModule = new ProjectsModule()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
