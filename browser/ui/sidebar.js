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
  const {
    loadExpanded,
    saveExpanded,
    loadIdSort,
    saveIdSort,
    loadIdUse,
    saveIdUse,
    loadWsOrder,
    saveWsOrder,
  } = window.OZ.SidebarState

  class IdentitySidebar {
    workspaces = []
    identities = []
    tabs = []
    activeWorkspaceId = null
    activeIdentityId = null
    activeOzTabId = null
    showArchived = false
    // alpha.42 — this window's OZ id, to scope the global Default identity's
    // tabs to the current window (null until init resolves / if unavailable).
    windowId = null

    constructor() {
      if (!window.oz) {
        console.error('[oz-sidebar] window.oz missing — preload not run.')
        return
      }
      this.expanded = loadExpanded()
      this.idQuery = ''
      this.idSort = loadIdSort()
      this.idUse = loadIdUse()
      this.wsOrder = loadWsOrder() // alpha.43 — user-defined workspace order
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
      // alpha.42 — learn our own window id first so the Default identity's
      // tabs can be scoped to this window from the very first render.
      if (typeof window.oz.getWindowId === 'function') {
        this.windowId = await safe(window.oz.getWindowId(), 'getWindowId')
      }
      await this.refresh()
      window.oz.workspaces.onChanged(() => this.refresh())
      window.oz.workspaces.onActiveChanged((payload) => {
        // active-changed is broadcast to every window's webUI; only react to
        // the event for THIS window (when we know our id). Avoids a switch in
        // another window hijacking this sidebar's active workspace.
        if (this.windowId != null && payload && payload.windowId != null) {
          if (payload.windowId !== this.windowId) return
        }
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
      const visibleWs = V.visibleWorkspaces(
        this.workspaces,
        this.showArchived,
        this.wsOrder,
      )

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
      const list =
        visibleWs || V.visibleWorkspaces(this.workspaces, this.showArchived, this.wsOrder)
      const activeWs = list.find((w) => w.id === this.activeWorkspaceId)

      if (this.$treeHeader) {
        // Dynamic header = active workspace name. Drop data-i18n so the i18n
        // pass doesn't overwrite it on locale change.
        this.$treeHeader.removeAttribute('data-i18n')
        this.$treeHeader.textContent = activeWs ? activeWs.name : '—'
      }

      this.$root.innerHTML = ''

      // alpha.42 — pin the global Default identity at the very top of EVERY
      // workspace (Ghost parity; ADR 0035 supersedes 0023 D2). Respects the
      // search filter; its tabs are window-scoped in renderIdentityWrapper.
      const def = V.globalDefaultIdentity(this.identities)
      let pinnedDefault = false
      if (activeWs && def && V.filterIdentities([def], this.idQuery).length) {
        this.$root.appendChild(this.renderIdentityWrapper(def))
        pinnedDefault = true
      }

      // Workspace members — Default excluded (rendered pinned above).
      let wsIdentities = activeWs
        ? V.identitiesForWorkspace(this.identities, activeWs.id).filter(
            (i) => !i.isDefault,
          )
        : []
      wsIdentities = V.filterIdentities(wsIdentities, this.idQuery)
      wsIdentities = V.sortIdentities(wsIdentities, this.idSort, this.idUse)

      if (wsIdentities.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'tree-empty'
        if (!activeWs) {
          empty.textContent = '(no workspace)'
          this.$root.appendChild(empty)
        } else if (this.idQuery) {
          // Suppress "(no matches)" when the Default row already matched.
          if (!pinnedDefault) {
            empty.textContent = '(no matches)'
            this.$root.appendChild(empty)
          }
        } else {
          empty.textContent = '(no identities — click ＋ on the workspace)'
          this.$root.appendChild(empty)
        }
        return
      }
      for (const ident of wsIdentities) {
        this.$root.appendChild(this.renderIdentityWrapper(ident))
      }
    }

    /**
     * One row in the workspace switcher list. Extracted to sidebar-wsrow.js
     * (ADR 0005 LOC budget) when adding drag-to-reorder (alpha.43).
     */
    renderWorkspaceSwitchRow(ws) {
      return window.OZ.SidebarWsRow.render(this, ws)
    }

    /**
     * alpha.43 — persist a new workspace order after a drag-reorder. Operates
     * on the currently-visible order and saves it (localStorage, UI-only).
     */
    handleReorderWorkspaces(draggedId, targetId, placeAfter) {
      const V = window.OZ.SidebarView
      const current = V.visibleWorkspaces(
        this.workspaces,
        this.showArchived,
        this.wsOrder,
      ).map((w) => w.id)
      this.wsOrder = V.reorderWorkspaceIds(current, draggedId, targetId, placeAfter)
      saveWsOrder(this.wsOrder)
      this.render()
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

      // alpha.42 — the global Default identity shows only THIS window's tabs
      // (its jar is global but tabs are per-window). Fall back to the unscoped
      // list if we couldn't resolve our window id.
      const V = window.OZ.SidebarView
      const tabsOfId =
        identity.isDefault && this.windowId != null
          ? V.defaultTabsForWindow(this.tabs, identity.id, this.windowId)
          : this.tabs.filter((t) => t.identityId === identity.id)
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
