// OZ Browser — Workspace switcher (pills horizontales arriba del sidebar) + CRUD inline.
//
// Renderiza una pill por cada workspace activo (archivados ocultos por default,
// con toggle "Show archived"). Click switchea, right-click abre context menu
// con rename / duplicate / archive / freeze / delete.
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope reasoning.

;(function () {
  const { safe } = window.OZ.utils

  class WorkspaceSwitcher {
    workspaces = []
    activeWorkspaceId = null
    showArchived = false

    constructor() {
      if (!window.oz || !window.oz.workspaces) {
        console.error(
          '[oz-workspace-switcher] window.oz.workspaces missing — preload not run.',
        )
        return
      }
      this.$root = document.getElementById('oz-workspace-switcher')
      this.$pills = document.getElementById('oz-workspace-pills')
      this.$newBtn = document.getElementById('oz-new-workspace')
      this.$archivedToggle = document.getElementById('oz-workspace-show-archived')

      if (this.$newBtn)
        this.$newBtn.addEventListener('click', () => this.handleNewWorkspace())
      if (this.$archivedToggle) {
        this.$archivedToggle.addEventListener('click', () => {
          this.showArchived = !this.showArchived
          this.render()
        })
      }
    }

    async init() {
      await this.refresh()
      window.oz.workspaces.onChanged(() => this.refresh())
      window.oz.workspaces.onActiveChanged((payload) => {
        if (payload && payload.workspaceId) {
          this.activeWorkspaceId = payload.workspaceId
          this.render()
        }
      })
    }

    async refresh() {
      this.workspaces = await window.oz.workspaces.list()
      this.activeWorkspaceId = await window.oz.workspaces.getActive()
      this.render()
    }

    // --- new workspace inline editor (window.prompt blocked in Electron) -----

    handleNewWorkspace() {
      if (this.$newBtn.dataset.editing) return
      this.$newBtn.dataset.editing = '1'
      const originalText = this.$newBtn.textContent
      this.$newBtn.textContent = ''
      const input = document.createElement('input')
      input.placeholder = 'Workspace name…'
      input.style.cssText =
        'background: transparent; border: none; outline: none; color: var(--text-color); font: inherit; width: 100%;'
      this.$newBtn.appendChild(input)
      input.focus()
      let committed = false
      const cleanup = () => {
        this.$newBtn.textContent = originalText
        delete this.$newBtn.dataset.editing
      }
      const commit = async () => {
        if (committed) return
        committed = true
        const name = input.value.trim()
        cleanup()
        if (name) {
          const ws = await safe(
            window.oz.workspaces.create({ name }),
            'workspaces.create',
          )
          if (ws && ws.id) {
            // Switch a la ventana actual al nuevo WS.
            const result = await safe(
              window.oz.workspaces.setActive(ws.id),
              'workspaces.setActive',
            )
            if (result && result.ok === false && result.reason === 'already-open') {
              alert(`Workspace "${ws.name}" already open in another window.`)
            }
          }
        }
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur()
        if (e.key === 'Escape') {
          committed = true
          cleanup()
        }
      })
    }

    // --- per-workspace actions -----------------------------------------------

    async handleSelectWorkspace(workspaceId) {
      if (workspaceId === this.activeWorkspaceId) return
      const result = await safe(
        window.oz.workspaces.setActive(workspaceId),
        'workspaces.setActive',
      )
      if (result && result.ok === false) {
        if (result.reason === 'already-open') {
          alert('This workspace is already open in another window.')
        } else if (result.reason === 'not-found') {
          alert('Workspace not found.')
        }
      }
    }

    handleRenameWorkspace(workspace, pillEl) {
      if (workspace.isFrozen) {
        alert(`Workspace "${workspace.name}" is frozen. Unfreeze first to rename.`)
        return
      }
      const nameEl = pillEl.querySelector('.workspace-name')
      if (!nameEl) return
      const currentName = workspace.name
      nameEl.innerHTML = ''
      const input = document.createElement('input')
      input.value = currentName
      nameEl.appendChild(input)
      input.focus()
      input.select()
      let committed = false
      const commit = async () => {
        if (committed) return
        committed = true
        const v = input.value.trim()
        if (v && v !== currentName) {
          await safe(window.oz.workspaces.rename(workspace.id, v), 'workspaces.rename')
        } else {
          this.render()
        }
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') input.blur()
        if (e.key === 'Escape') {
          committed = true
          this.render()
        }
      })
    }

    async handleDuplicateWorkspace(workspace) {
      const dup = await safe(
        window.oz.workspaces.duplicate(workspace.id),
        'workspaces.duplicate',
      )
      if (dup && dup.id) {
        // No auto-switch — el copy queda disponible pero el user sigue donde estaba.
      }
    }

    async handleArchiveWorkspace(workspace) {
      if (workspace.isDefault) {
        alert('Cannot archive the Default workspace.')
        return
      }
      await safe(window.oz.workspaces.archive(workspace.id), 'workspaces.archive')
    }

    async handleRestoreWorkspace(workspace) {
      await safe(window.oz.workspaces.restore(workspace.id), 'workspaces.restore')
    }

    async handleFreezeToggle(workspace) {
      if (workspace.isFrozen) {
        await safe(window.oz.workspaces.unfreeze(workspace.id), 'workspaces.unfreeze')
      } else {
        await safe(window.oz.workspaces.freeze(workspace.id), 'workspaces.freeze')
      }
    }

    async handleDeleteWorkspace(workspace) {
      if (workspace.isDefault) {
        alert('Cannot delete the Default workspace.')
        return
      }
      const tabsCount = (workspace.tabSpecs && workspace.tabSpecs.length) || 0
      const msg =
        `Delete workspace "${workspace.name}"?\n\n` +
        `${tabsCount} tab(s) will be discarded.\n` +
        `Identity sessions (cookies/storage) on disk are preserved — they belong to identities, not workspaces.`
      if (!confirm(msg)) return
      await safe(window.oz.workspaces.remove(workspace.id), 'workspaces.remove')
    }

    showContextMenu(e, workspace) {
      e.preventDefault()
      e.stopPropagation()
      const existing = document.querySelector('.ctx-menu')
      if (existing) existing.remove()
      const menu = document.createElement('div')
      menu.className = 'ctx-menu'
      menu.style.left = `${e.clientX}px`
      menu.style.top = `${e.clientY}px`

      const addBtn = (label, handler, opts = {}) => {
        const btn = document.createElement('button')
        btn.textContent = label
        if (opts.danger) btn.className = 'danger'
        if (opts.disabled) btn.setAttribute('disabled', '')
        btn.addEventListener('click', () => {
          menu.remove()
          if (!opts.disabled) handler()
        })
        menu.appendChild(btn)
      }

      addBtn(
        'Rename',
        () => {
          const pillEl = document.querySelector(
            `.workspace-pill[data-ws-id="${workspace.id}"]`,
          )
          if (pillEl) this.handleRenameWorkspace(workspace, pillEl)
        },
        { disabled: workspace.isFrozen },
      )
      addBtn('Duplicate', () => this.handleDuplicateWorkspace(workspace))

      // Quick Tabs mode submenu (1.4e).
      const QT_LABELS = {
        'on-click': 'Lazy (on click) — default',
        'load-all': 'Load all on switch',
        'one-by-one': 'Load one by one',
        'on-click-confirm': 'Lazy + confirm before load',
      }
      const qtBtn = document.createElement('button')
      const currentMode = workspace.quickTabsMode || 'on-click'
      qtBtn.textContent = `Quick Tabs: ${QT_LABELS[currentMode] || currentMode} ▸`
      if (workspace.isFrozen) qtBtn.setAttribute('disabled', '')
      qtBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (workspace.isFrozen) return
        const sub = document.createElement('div')
        sub.className = 'ctx-menu ctx-submenu'
        sub.style.left = `${e.clientX + 200}px`
        sub.style.top = `${e.clientY + 60}px`
        for (const mode of Object.keys(QT_LABELS)) {
          const item = document.createElement('button')
          item.textContent = QT_LABELS[mode] + (mode === currentMode ? ' ✓' : '')
          item.addEventListener('click', async () => {
            menu.remove()
            sub.remove()
            // Warn when enabling 'load-all' on a workspace with many tabs —
            // it'll spike RAM at switch time. Threshold matches the constant
            // exported from window-workspace.js (LOAD_ALL_THRESHOLD = 10).
            const tabsCount = (workspace.tabSpecs && workspace.tabSpecs.length) || 0
            if (mode === 'load-all' && tabsCount > 10) {
              const ok = confirm(
                `"${workspace.name}" has ${tabsCount} tabs. Load all on switch will materialize ALL of them at once — RAM may spike. Proceed?`,
              )
              if (!ok) return
            }
            await safe(
              window.oz.workspaces.update(workspace.id, { quickTabsMode: mode }),
              'workspaces.update.quickTabsMode',
            )
          })
          sub.appendChild(item)
        }
        document.body.appendChild(sub)
        const closeSub = (e2) => {
          if (!sub.contains(e2.target) && !menu.contains(e2.target)) {
            sub.remove()
            menu.remove()
            document.removeEventListener('click', closeSub, true)
          }
        }
        setTimeout(() => document.addEventListener('click', closeSub, true), 0)
      })
      menu.appendChild(qtBtn)

      addBtn(workspace.isFrozen ? 'Unfreeze' : 'Freeze', () =>
        this.handleFreezeToggle(workspace),
      )
      if (!workspace.isDefault) {
        if (workspace.isArchived) {
          addBtn('Restore', () => this.handleRestoreWorkspace(workspace))
        } else {
          addBtn('Archive', () => this.handleArchiveWorkspace(workspace))
        }
        addBtn('Delete workspace', () => this.handleDeleteWorkspace(workspace), {
          danger: true,
        })
      }

      document.body.appendChild(menu)
      setTimeout(() => {
        const close = (ev) => {
          if (!menu.contains(ev.target)) {
            menu.remove()
            document.removeEventListener('click', close, true)
          }
        }
        document.addEventListener('click', close, true)
      }, 0)
    }

    // --- rendering -----------------------------------------------------------

    render() {
      if (!this.$pills) return
      this.$pills.innerHTML = ''

      const visible = this.workspaces.filter((w) => this.showArchived || !w.isArchived)

      for (const ws of visible) {
        this.$pills.appendChild(this.renderPill(ws))
      }

      // Update Show archived toggle text + state.
      if (this.$archivedToggle) {
        const archivedCount = this.workspaces.filter((w) => w.isArchived).length
        if (archivedCount === 0) {
          this.$archivedToggle.style.display = 'none'
        } else {
          this.$archivedToggle.style.display = ''
          this.$archivedToggle.textContent = this.showArchived
            ? `Hide archived (${archivedCount})`
            : `Show archived (${archivedCount})`
        }
      }
    }

    renderPill(ws) {
      const pill = document.createElement('div')
      pill.className = 'workspace-pill'
      pill.dataset.wsId = ws.id
      if (ws.id === this.activeWorkspaceId) pill.classList.add('active')
      if (ws.isArchived) pill.classList.add('archived')
      if (ws.isFrozen) pill.classList.add('frozen')

      const chip = document.createElement('span')
      chip.className = 'workspace-chip'
      chip.style.background = ws.color
      pill.appendChild(chip)

      if (ws.isFrozen) {
        const lock = document.createElement('span')
        lock.className = 'workspace-lock'
        lock.textContent = '🔒'
        lock.title = 'Frozen — read-only for CRUD'
        pill.appendChild(lock)
      }

      const name = document.createElement('span')
      name.className = 'workspace-name'
      name.textContent = ws.name
      pill.appendChild(name)

      pill.addEventListener('click', () => this.handleSelectWorkspace(ws.id))
      pill.addEventListener('contextmenu', (e) => this.showContextMenu(e, ws))
      pill.addEventListener('dblclick', (e) => {
        e.preventDefault()
        this.handleRenameWorkspace(ws, pill)
      })

      // 1.4d: drop zone — accept tab drags from sidebar to move them to this WS.
      // Active WS is excluded (no point moving to current); archived WS rejects too.
      const isDropTarget = ws.id !== this.activeWorkspaceId && !ws.isArchived
      if (isDropTarget) {
        pill.addEventListener('dragover', (ev) => {
          if (ev.dataTransfer.types.includes('application/oz-tab-id')) {
            ev.preventDefault()
            ev.dataTransfer.dropEffect = 'move'
            pill.classList.add('drop-target')
          }
        })
        pill.addEventListener('dragleave', () => pill.classList.remove('drop-target'))
        pill.addEventListener('drop', async (ev) => {
          ev.preventDefault()
          pill.classList.remove('drop-target')
          const tabId = ev.dataTransfer.getData('application/oz-tab-id')
          if (!tabId) return
          const result = await safe(
            window.oz.tabs.moveToWorkspace(tabId, ws.id),
            'tabs.moveToWorkspace',
          )
          if (result && result.ok === false) {
            alert(`Move failed: ${result.reason}`)
          }
        })
      }

      return pill
    }
  }

  window.OZ.WorkspaceSwitcher = WorkspaceSwitcher
})()
