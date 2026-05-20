// OZ Browser — Sidebar tree (H3c).
//
// Renderiza un árbol jerárquico:
//   Workspaces (top-level, click switchea active workspace de la ventana)
//     └ Identities (indented bajo cada workspace)
//         └ Tabs (indented bajo cada identity)
//
// Cada nivel es expand/collapse con chevron. localStorage persiste el estado
// expandido por workspace.id y por identity.id entre sesiones. Active
// workspace / identity / tab tienen highlight visual.
//
// Reemplaza el split del 1.4d (workspace-switcher pills + sidebar identities
// flat). Decisión Jose 2026-05-10 noche bis: cambio de approach vs ADR 0023
// D9 (era filtered, ahora tree) — ves todo el sistema de un vistazo.
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const { safe } = window.OZ.utils

  const STORAGE_KEY = 'oz-tree-expanded'

  function loadExpanded() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch (_e) {
      return {}
    }
  }
  function saveExpanded(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (_e) {
      /* quota exceeded — ignore */
    }
  }

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
      this.$root = document.getElementById('oz-identity-list')
      this.$newIdBtn = document.getElementById('oz-new-identity')
      this.$newWsBtn = document.getElementById('oz-new-workspace')
      this.$archivedToggle = document.getElementById('oz-workspace-show-archived')
      if (this.$newIdBtn) {
        this.$newIdBtn.addEventListener('click', () => this.handleNewIdentity())
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
      if (wsId === this.activeWorkspaceId) {
        // Toggle expanded if already active (UX bonus).
        this.expanded['ws:' + wsId] = !this.expanded['ws:' + wsId]
        saveExpanded(this.expanded)
        this.render()
        return
      }
      const r = await safe(window.oz.workspaces.setActive(wsId), 'workspaces.setActive')
      if (r && r.ok === false) {
        if (r.reason === 'already-open')
          alert('This workspace is already open in another window.')
        else if (r.reason === 'not-found') alert('Workspace not found.')
      }
    }

    handleToggleWorkspaceExpanded(wsId, ev) {
      if (ev) ev.stopPropagation()
      const key = 'ws:' + wsId
      this.expanded[key] = !this.expanded[key]
      saveExpanded(this.expanded)
      this.render()
    }

    handleSelectIdentity(identityId) {
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
      const nameEl = rowEl.querySelector('.tree-name')
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
      if (!this.$root) return
      this.$root.innerHTML = ''
      // HX4 follow-up (Jose's feedback): keep workspaces in stable createdAt
      // order. Active workspace gets a visual highlight (left accent border +
      // filled background) but the row stays where it is — clicking should
      // expand / collapse + switch active, never reshuffle the list.
      const visibleWs = this.workspaces
        .filter((w) => this.showArchived || !w.isArchived)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      for (const ws of visibleWs) {
        this.$root.appendChild(this.renderWorkspaceWrapper(ws))
      }
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

    renderWorkspaceWrapper(ws) {
      const wrap = document.createElement('div')
      wrap.className = 'workspace-wrapper'
      wrap.dataset.wsId = ws.id

      const expandedKey = 'ws:' + ws.id
      const isExpanded = !!this.expanded[expandedKey]

      const row = document.createElement('div')
      row.className = 'tree-row workspace-row'
      if (ws.id === this.activeWorkspaceId) row.classList.add('active')
      if (ws.isArchived) row.classList.add('archived')
      if (ws.isFrozen) row.classList.add('frozen')

      const chevron = document.createElement('span')
      chevron.className = 'tree-chevron' + (isExpanded ? ' expanded' : '')
      chevron.textContent = '▸'
      chevron.addEventListener('click', (ev) =>
        this.handleToggleWorkspaceExpanded(ws.id, ev),
      )
      row.appendChild(chevron)

      const chip = document.createElement('span')
      chip.className = 'tree-chip'
      chip.style.background = ws.color
      row.appendChild(chip)

      const name = document.createElement('span')
      name.className = 'tree-name'
      name.textContent = ws.isFrozen ? `🔒 ${ws.name}` : ws.name
      row.appendChild(name)

      const count = document.createElement('span')
      count.className = 'tree-count'
      const idCount = (ws.identityIds && ws.identityIds.length) || 0
      count.textContent = `(${idCount})`
      if (idCount === 0) count.classList.add('zero')
      row.appendChild(count)

      // C-8: + new identity inline (replaces the big "+ New Identity" button
      // that lived above the tree). Contextual: creates the identity directly
      // in THIS workspace. Hidden by default, fades in on row hover.
      // Frozen workspaces don't get the button (frozen blocks identity move
      // and updates per ADR 0023).
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

      // Drop target: identity drag-drop into another workspace.
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

      wrap.appendChild(row)

      if (isExpanded) {
        const childContainer = document.createElement('div')
        childContainer.className = 'tree-children'
        const wsIdentities = this.identities.filter((i) => i.workspaceId === ws.id)
        if (wsIdentities.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'tree-empty'
          empty.textContent =
            ws.id === this.activeWorkspaceId
              ? '(no identities — click + New Identity)'
              : '(no identities)'
          childContainer.appendChild(empty)
        } else {
          for (const ident of wsIdentities) {
            childContainer.appendChild(this.renderIdentityWrapper(ident))
          }
        }
        wrap.appendChild(childContainer)
      }

      return wrap
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
      const row = document.createElement('div')
      row.className = 'tree-row tab-row'
      row.dataset.tabId = tab.id
      if (!tab.isLoaded) row.classList.add('lazy')
      if (tab.id === this.activeOzTabId) row.classList.add('active')

      row.draggable = true
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/oz-tab-id', tab.id)
        ev.dataTransfer.effectAllowed = 'move'
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => row.classList.remove('dragging'))

      const fav = document.createElement('span')
      fav.className = 'tree-favicon'
      if (tab.favicon) {
        const img = document.createElement('img')
        img.src = tab.favicon
        img.style.width = '12px'
        img.style.height = '12px'
        fav.appendChild(img)
      } else {
        fav.classList.add('lazy')
        fav.style.background = identity.color
      }
      row.appendChild(fav)

      const title = document.createElement('span')
      title.className = 'tree-name'
      const baseTitle = tab.title || tab.url || 'New Tab'
      title.textContent = tab.locked ? `🔒 ${baseTitle}` : baseTitle
      title.title = tab.url || ''
      row.appendChild(title)

      if (!tab.locked) {
        const close = document.createElement('button')
        close.className = 'oz-close'
        close.textContent = '✕'
        close.addEventListener('click', (e) => this.handleCloseTab(tab.id, e))
        row.appendChild(close)
      }

      row.addEventListener('click', () => this.handleSelectTab(tab.id))
      row.addEventListener('contextmenu', async (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        if (window.oz.tabs.contextMenu) {
          await safe(
            window.oz.tabs.contextMenu(tab.id, { x: ev.clientX, y: ev.clientY }),
            'tabs.contextMenu',
          )
        }
      })
      return row
    }
  }

  window.OZ.IdentitySidebar = IdentitySidebar
})()
