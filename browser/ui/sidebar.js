// OZ Browser — Sidebar (alpha.32 — Ghost parity: one active workspace).
//
// Layout (decisión Jose 2026-06-16, research support.ghostbrowser.com/321):
//   #oz-workspace-pills  — lista de TODOS los workspaces para switchear
//                          (click = setActive). Solo navegación.
//   #oz-tree-header      — nombre del workspace ACTIVO.
//   #oz-identity-list    — SOLO las identities + tabs del workspace activo:
//                            └ Identity (expand/collapse)
//                                └ Tabs
//
// Ghost abre un workspace a la vez; al cambiar, el viejo desaparece y aparece
// el nuevo. Antes el sidebar dibujaba el árbol de TODOS los workspaces y
// tabs.list() agrega las tabs de todas las ventanas, por lo que las pestañas
// del workspace anterior quedaban visibles tras un switch. Ahora la vista se
// limita al workspace activo (helpers puros en sidebar-view.js).
//
// Reemplaza el árbol H3c (todos los workspaces a la vez).
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const { safe } = window.OZ.utils
  // alpha.33 — localStorage persistence extracted to sidebar-state.js (ADR 0005).
  const { loadExpanded, saveExpanded, loadIdSort, saveIdSort, loadIdUse, saveIdUse } =
    window.OZ.SidebarState

  class IdentitySidebar {
    workspaces = []
    identities = []
    tabs = []
    activeWorkspaceId = null
    activeIdentityId = null
    activeOzTabId = null
    showArchived = false

    constructor() {
      if (!window.oz) {
        console.error('[oz-sidebar] window.oz missing — preload not run.')
        return
      }
      this.expanded = loadExpanded()
      this.idQuery = ''
      this.idSort = loadIdSort()
      this.idUse = loadIdUse()
      this.$root = document.getElementById('oz-identity-list')
      this.$pills = document.getElementById('oz-workspace-pills')
      this.$treeHeader = document.getElementById('oz-tree-header')
      this.$idSearch = document.getElementById('oz-identity-search')
      this.$idSort = document.getElementById('oz-identity-sort')
      this.$newWsBtn = document.getElementById('oz-new-workspace')
      this.$archivedToggle = document.getElementById('oz-workspace-show-archived')
      if (this.$idSearch) {
        this.$idSearch.addEventListener('input', () => {
          this.idQuery = this.$idSearch.value
          this.renderActiveContent()
        })
      }
      if (this.$idSort) {
        this.$idSort.value = this.idSort
        this.$idSort.addEventListener('change', () => {
          this.idSort = this.$idSort.value
          saveIdSort(this.idSort)
          this.renderActiveContent()
        })
      }
      if (this.$newWsBtn) {
        this.$newWsBtn.addEventListener('click', () => this.handleNewWorkspace())
      }
      if (this.$archivedToggle) {
        this.$archivedToggle.addEventListener('click', () => {
          this.showArchived = !this.showArchived
          this.render()
        })
      }
    }

    async init() {
      if (!window.oz) return
      await this.refresh()
      window.oz.workspaces.onChanged(() => this.refresh())
      window.oz.workspaces.onActiveChanged((payload) => {
        if (payload && payload.workspaceId) {
          this.activeWorkspaceId = payload.workspaceId
          // Clear the identity search when switching workspace — a stale query
          // from the previous workspace would otherwise hide everything.
          this.idQuery = ''
          if (this.$idSearch) this.$idSearch.value = ''
          // Auto-expand the active workspace so the user immediately sees its
          // identities + tabs without an extra click.
          this.expanded['ws:' + payload.workspaceId] = true
          saveExpanded(this.expanded)
          this.render()
        }
      })
      window.oz.identities.onChanged(() => this.refresh())
      window.oz.identities.onActiveChanged((id) => {
        this.activeIdentityId = id
        this.render()
      })
      window.oz.tabs.onUpdated((info) => this.handleTabEvent(info))

      // HX4 — native ctx menu back-channels (extracted to sidebar-events.js).
      if (window.OZ.SidebarEvents) {
        window.OZ.SidebarEvents.wireSidebarBackChannels(this)
      }

      // C-6 — anti-detect health badges. Wired via SidebarHealth helper
      // (extracted to sidebar-health.js per ADR 0005 LOC budget). The helper
      // owns the cache + listeners + dot render; sidebar just calls
      // renderDotInto() during identity row render.
      if (window.OZ.SidebarHealth) {
        window.OZ.SidebarHealth.attach(this)
      }
    }

    async refresh() {
      this.workspaces = await window.oz.workspaces.list()
      this.activeWorkspaceId = await window.oz.workspaces.getActive()
      this.identities = await window.oz.identities.list()
      this.activeIdentityId = await window.oz.identities.getActive()
      this.tabs = await window.oz.tabs.list()
      // First load: expand active workspace by default.
      if (this.activeWorkspaceId && !('ws:' + this.activeWorkspaceId in this.expanded)) {
        this.expanded['ws:' + this.activeWorkspaceId] = true
      }
      this.render()
    }

    handleTabEvent(info) {
      if (!info) return
      if (
        info.kind === 'created' ||
        info.kind === 'updated' ||
        info.kind === 'materialized'
      ) {
        const t = info.tab
        if (!t) return
        const idx = this.tabs.findIndex((x) => x.id === t.id)
        if (idx >= 0) {
          this.tabs[idx] = { ...this.tabs[idx], ...t }
        } else {
          this.tabs.push(t)
        }
      } else if (info.kind === 'removed') {
        this.tabs = this.tabs.filter((x) => x.id !== info.tabId)
      } else if (info.kind === 'selected') {
        this.activeOzTabId = info.tabId
        // C-7-bis: bidirectional sync — al focus un tab en la tabstrip,
        // destacar visualmente la identity correspondiente en el sidebar +
        // auto-expand para que el tab activo sea visible. También sincroniza
        // el "active identity for new tabs" (Cmd+T) al foco actual.
        const tab = this.tabs.find((x) => x.id === info.tabId)
        if (tab && tab.identityId && tab.identityId !== this.activeIdentityId) {
          this.activeIdentityId = tab.identityId
          const expandKey = 'id:' + tab.identityId
          if (!this.expanded[expandKey]) {
            this.expanded[expandKey] = true
            saveExpanded(this.expanded)
          }
          // Fire-and-forget — el `oz:identities:active-changed` que emita
          // este setActive va a re-renderizar pero con el mismo state local
          // que ya seteamos (idempotente, no ciclo infinito).
          safe(window.oz.identities.setActive(tab.identityId), 'identities.setActive')
        }
      } else if (info.kind === 'bulk-created') {
        this.refresh()
        return
      }
      this.render()
    }

    // --- workspace + identity creation -----------------------------------------
    // C-8: simplificado tras el sidebar redesign. El "+ New Identity" button
    // grande se eliminó (handleNewIdentity legacy retirada). El "+ New
    // Workspace" sigue en el switcher pills + ahora pide nombre via prompt
    // (consistente con handleNewIdentityInWorkspace, eliminó el helper
    // _inlineRename de ~40 LOC).

    async handleNewWorkspace() {
      // v1.8.3: window.prompt() is disabled in chrome-extension pages in
      // recent Electron (silently returns null). Use the OZ custom prompt
      // helper that renders an HTML modal.
      const promptFn = (window.OZ && window.OZ.ui && window.OZ.ui.prompt) || window.prompt
      const name = await promptFn('Workspace name', {
        placeholder: 'e.g. Client X',
        okLabel: 'Create',
      })
      if (!name || !name.trim()) return
      const ws = await safe(
        window.oz.workspaces.create({ name: name.trim() }),
        'workspaces.create',
      )
      if (ws && ws.id) {
        await safe(window.oz.workspaces.setActive(ws.id), 'workspaces.setActive')
      }
    }

    /**
     * C-8 — new identity inside a specific workspace. Triggered by the "+"
     * inline button on each workspace row.
     */
    async handleNewIdentityInWorkspace(workspaceId) {
      // v1.8.3: see handleNewWorkspace — window.prompt() doesn't render
      // in chrome-extension pages in recent Electron.
      const promptFn = (window.OZ && window.OZ.ui && window.OZ.ui.prompt) || window.prompt
      const name = await promptFn('Identity name', {
        placeholder: 'e.g. IG_Maria',
        okLabel: 'Create',
      })
      if (!name || !name.trim()) return
      const ident = await safe(
        window.oz.identities.create({ name: name.trim(), workspaceId }),
        'identities.create',
      )
      if (ident && ident.__error) {
        alert(ident.__error.message || 'Cannot create identity.')
        return
      }
      if (ident && ident.id) {
        await safe(window.oz.identities.setActive(ident.id), 'identities.setActive')
      }
    }

    // --- handlers ----------------------------------------------------------------

    async handleSelectWorkspace(wsId) {
      // Clicking the already-active workspace is a no-op (its content is
      // already shown below). Clicking another switches to it.
      if (wsId === this.activeWorkspaceId) return
      const r = await safe(window.oz.workspaces.setActive(wsId), 'workspaces.setActive')
      if (r && r.ok === false) {
        if (r.reason === 'already-open')
          alert('This workspace is already open in another window.')
        else if (r.reason === 'not-found') alert('Workspace not found.')
      }
    }

    handleSelectIdentity(identityId) {
      // alpha.33 — bump use count for the "Most used" sort (UI-only).
      this.idUse[identityId] = (this.idUse[identityId] || 0) + 1
      saveIdUse(this.idUse)
      safe(window.oz.identities.setActive(identityId), 'identities.setActive')
      // C-7-bis: bidirectional sync — al click una identity, seleccionar
      // un tab visible de esa identity en la tabstrip (si hay alguno). Si
      // no tiene tabs vivos, no auto-abre uno (requiere "+" inline o Cmd+T
      // explícito). Si el tab actualmente focuseado YA es de esta identity,
      // no se cambia la selección (no rompe scroll/state del tab).
      const tabsOfId = this.tabs.filter((t) => t.identityId === identityId)
      if (tabsOfId.length === 0) return
      const alreadyActive = tabsOfId.find((t) => t.id === this.activeOzTabId)
      if (alreadyActive) return
      safe(window.oz.tabs.select(tabsOfId[0].id), 'tabs.select')
    }

    handleToggleIdentityExpanded(identityId, ev) {
      if (ev) ev.stopPropagation()
      const key = 'id:' + identityId
      this.expanded[key] = !this.expanded[key]
      saveExpanded(this.expanded)
      this.render()
    }

    handleSelectTab(ozTabId) {
      safe(window.oz.tabs.select(ozTabId), 'tabs.select')
    }
    handleCloseTab(tabId, ev) {
      if (ev) ev.stopPropagation()
      safe(window.oz.tabs.close(tabId), 'tabs.close')
    }
    handleNewTabIn(identityId) {
      safe(
        window.oz.tabs.openInIdentity(identityId, 'about:blank'),
        'tabs.openInIdentity',
      )
    }

    // --- inline rename (workspaces + identities) -------------------------------

    handleInlineRename(rowEl, currentName, onSave) {
      const nameEl = rowEl.querySelector('.tree-name, .workspace-name')
      if (!nameEl) return
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
        if (v && v !== currentName) await onSave(v)
        else this.render()
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

    // --- context menus (HX4: native Menu.popup, see sidebar-events.js) -----

    showWorkspaceContextMenu(e, ws) {
      const ev = window.OZ.SidebarEvents
      if (ev) ev.showWorkspaceCtxMenu(e, ws)
    }
    showIdentityContextMenu(e, identity) {
      const ev = window.OZ.SidebarEvents
      if (ev) ev.showIdentityCtxMenu(e, identity)
    }

    // --- rendering -------------------------------------------------------------

    render() {
      const V = window.OZ.SidebarView
      const visibleWs = V.visibleWorkspaces(this.workspaces, this.showArchived)

      // 1) Workspace switcher — ALL workspaces as a switch list (Ghost-style).
      if (this.$pills) {
        this.$pills.innerHTML = ''
        for (const ws of visibleWs) {
          this.$pills.appendChild(this.renderWorkspaceSwitchRow(ws))
        }
      }

      // 2) Active workspace content — ONLY its identities + tabs.
      this.renderActiveContent(visibleWs)

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

    /**
     * Render only the active workspace's identities + tabs into #oz-identity-list,
     * applying the search filter + sort. Split from render() so typing in the
     * search box (which lives outside $root) doesn't blow away its focus.
     */
    renderActiveContent(visibleWs) {
      if (!this.$root) return
      const V = window.OZ.SidebarView
      const list = visibleWs || V.visibleWorkspaces(this.workspaces, this.showArchived)
      const activeWs = list.find((w) => w.id === this.activeWorkspaceId)

      if (this.$treeHeader) {
        // Dynamic header = active workspace name. Drop data-i18n so the i18n
        // pass doesn't overwrite it on locale change.
        this.$treeHeader.removeAttribute('data-i18n')
        this.$treeHeader.textContent = activeWs ? activeWs.name : '—'
      }

      this.$root.innerHTML = ''
      let wsIdentities = activeWs
        ? V.identitiesForWorkspace(this.identities, activeWs.id)
        : []
      wsIdentities = V.filterIdentities(wsIdentities, this.idQuery)
      wsIdentities = V.sortIdentities(wsIdentities, this.idSort, this.idUse)

      if (wsIdentities.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'tree-empty'
        empty.textContent = !activeWs
          ? '(no workspace)'
          : this.idQuery
            ? '(no matches)'
            : '(no identities — click ＋ on the workspace)'
        this.$root.appendChild(empty)
        return
      }
      for (const ident of wsIdentities) {
        this.$root.appendChild(this.renderIdentityWrapper(ident))
      }
    }

    /**
     * One row in the workspace switcher list. Clicking switches the active
     * workspace (the content below re-renders to that workspace's identities
     * + tabs). Keeps rename / context menu / drag-drop target / ＋identity.
     */
    renderWorkspaceSwitchRow(ws) {
      const row = document.createElement('div')
      row.className = 'workspace-pill'
      row.dataset.wsId = ws.id
      if (ws.id === this.activeWorkspaceId) row.classList.add('active')
      if (ws.isArchived) row.classList.add('archived')
      if (ws.isFrozen) row.classList.add('frozen')

      const chip = document.createElement('span')
      chip.className = 'workspace-chip'
      chip.style.background = ws.color
      row.appendChild(chip)

      if (ws.isFrozen) {
        const lock = document.createElement('span')
        lock.className = 'workspace-lock'
        lock.textContent = '🔒'
        row.appendChild(lock)
      }

      const name = document.createElement('span')
      name.className = 'workspace-name'
      name.textContent = ws.name
      row.appendChild(name)

      const count = document.createElement('span')
      count.className = 'tree-count'
      const idCount = (ws.identityIds && ws.identityIds.length) || 0
      count.textContent = `(${idCount})`
      if (idCount === 0) count.classList.add('zero')
      row.appendChild(count)

      // ＋ new identity directly in THIS workspace (frozen/archived excluded).
      if (!ws.isFrozen && !ws.isArchived) {
        const addId = document.createElement('button')
        addId.type = 'button'
        addId.className = 'ws-add-identity-btn'
        addId.title = `New identity in "${ws.name}"`
        addId.textContent = '＋'
        addId.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this.handleNewIdentityInWorkspace(ws.id)
        })
        row.appendChild(addId)
      }

      row.addEventListener('click', () => this.handleSelectWorkspace(ws.id))
      row.addEventListener('contextmenu', (e) => this.showWorkspaceContextMenu(e, ws))
      row.addEventListener('dblclick', (e) => {
        e.preventDefault()
        if (ws.isFrozen) return
        this.handleInlineRename(row, ws.name, async (v) => {
          await safe(window.oz.workspaces.rename(ws.id, v), 'workspaces.rename')
        })
      })

      // Drop target: drag an identity / tab onto another workspace to move it.
      const isDropTarget = ws.id !== this.activeWorkspaceId && !ws.isArchived
      if (isDropTarget) {
        row.addEventListener('dragover', (ev) => {
          if (
            ev.dataTransfer.types.includes('application/oz-identity-id') ||
            ev.dataTransfer.types.includes('application/oz-tab-id')
          ) {
            ev.preventDefault()
            ev.dataTransfer.dropEffect = 'move'
            row.classList.add('drop-target')
          }
        })
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'))
        row.addEventListener('drop', async (ev) => {
          ev.preventDefault()
          row.classList.remove('drop-target')
          const idId = ev.dataTransfer.getData('application/oz-identity-id')
          const tabId = ev.dataTransfer.getData('application/oz-tab-id')
          if (idId) {
            const r = await safe(
              window.oz.identities.moveToWorkspace(idId, ws.id),
              'identities.moveToWorkspace',
            )
            if (r && r.ok === false) alert(`Move failed: ${r.reason}`)
          } else if (tabId) {
            const r = await safe(
              window.oz.tabs.moveToWorkspace(tabId, ws.id),
              'tabs.moveToWorkspace',
            )
            if (r && r.ok === false) alert(`Move failed: ${r.reason}`)
          }
        })
      }

      return row
    }

    renderIdentityWrapper(identity) {
      const wrap = document.createElement('div')
      wrap.className = 'identity-wrapper'
      wrap.dataset.identityId = identity.id

      const expandedKey = 'id:' + identity.id
      const isExpanded = !!this.expanded[expandedKey]

      const row = document.createElement('div')
      row.className = 'tree-row identity-row'
      if (identity.id === this.activeIdentityId) row.classList.add('active')
      if (identity.isDefault) row.classList.add('default')
      row.draggable = !identity.isDefault && !identity.locked
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/oz-identity-id', identity.id)
        ev.dataTransfer.effectAllowed = 'move'
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => row.classList.remove('dragging'))

      const chevron = document.createElement('span')
      chevron.className = 'tree-chevron' + (isExpanded ? ' expanded' : '')
      chevron.textContent = '▸'
      chevron.addEventListener('click', (ev) =>
        this.handleToggleIdentityExpanded(identity.id, ev),
      )
      row.appendChild(chevron)

      const chip = document.createElement('span')
      chip.className = 'tree-chip'
      chip.style.background = identity.color
      row.appendChild(chip)

      // C-6 — anti-detect health dot (extracted to sidebar-health.js).
      if (window.OZ.SidebarHealth) {
        window.OZ.SidebarHealth.renderDotInto(row, identity)
      }

      const name = document.createElement('span')
      name.className = 'tree-name'
      name.textContent = identity.locked ? `🔒 ${identity.name}` : identity.name
      row.appendChild(name)

      // alpha.40: tag chips — click filters by that tag (sets the search box).
      for (const tag of identity.tags || []) {
        const chip = document.createElement('span')
        chip.className = 'oz-tag-chip'
        chip.textContent = tag
        chip.title = `Filter by tag: ${tag}`
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this.idQuery = tag
          if (this.$idSearch) this.$idSearch.value = tag
          this.renderActiveContent()
        })
        row.appendChild(chip)
      }

      const tabsOfId = this.tabs.filter((t) => t.identityId === identity.id)
      const count = document.createElement('span')
      count.className = 'tree-count'
      count.textContent = `(${tabsOfId.length})`
      if (tabsOfId.length === 0) count.classList.add('zero')
      row.appendChild(count)

      const addTab = document.createElement('button')
      addTab.className = 'add-tab'
      addTab.title = 'New tab in this identity'
      addTab.textContent = '+'
      addTab.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.handleNewTabIn(identity.id)
      })
      row.appendChild(addTab)

      row.addEventListener('click', () => this.handleSelectIdentity(identity.id))
      row.addEventListener('contextmenu', (e) =>
        this.showIdentityContextMenu(e, identity),
      )
      row.addEventListener('dblclick', () => {
        this.handleInlineRename(row, identity.name, async (v) => {
          await safe(window.oz.identities.rename(identity.id, v), 'identities.rename')
        })
      })

      wrap.appendChild(row)

      if (isExpanded) {
        const childContainer = document.createElement('div')
        childContainer.className = 'tree-children'
        if (tabsOfId.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'tree-empty'
          empty.textContent = '(no tabs)'
          childContainer.appendChild(empty)
        } else {
          for (const tab of tabsOfId) {
            childContainer.appendChild(this.renderTabRow(tab, identity))
          }
        }
        wrap.appendChild(childContainer)
      }

      return wrap
    }

    renderTabRow(tab, identity) {
      // alpha.40: extracted to sidebar-tabrow.js (ADR 0005 LOC budget).
      return window.OZ.SidebarTabRow.render(this, tab, identity)
    }
  }

  window.OZ.IdentitySidebar = IdentitySidebar
})()
