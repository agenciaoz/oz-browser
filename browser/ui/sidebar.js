// OZ Browser — Left sidebar with Identities + their tabs grouped underneath.
// Uses window.oz.identities + window.oz.tabs. Provides inline rename, context
// menu (rename / delete), and "+ tab in this identity" hover button.
//
// Wrapped in IIFE — see comment in tabstrip.js for the global-lexical-scope
// reasoning.

;(function () {
  const { safe } = window.OZ.utils

  class IdentitySidebar {
    identities = []
    tabs = []
    activeIdentityId = null
    activeOzTabId = null

    constructor() {
      if (!window.oz) {
        console.error('[oz-sidebar] window.oz missing — preload not run.')
        return
      }
      this.$root = document.getElementById('oz-identity-list')
      this.$newBtn = document.getElementById('oz-new-identity')
      this.$newBtn.addEventListener('click', () => this.handleNewIdentity())
    }

    async init() {
      if (!window.oz) return
      await this.refresh()
      window.oz.identities.onChanged(() => this.refresh())
      window.oz.identities.onActiveChanged((id) => {
        this.activeIdentityId = id
        this.render()
      })
      window.oz.tabs.onUpdated((info) => this.handleTabEvent(info))
    }

    async refresh() {
      this.identities = await window.oz.identities.list()
      this.activeIdentityId = await window.oz.identities.getActive()
      this.tabs = await window.oz.tabs.list()
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
        } else if (info.kind === 'created') {
          this.tabs.push(t)
        } else {
          // Updated/materialized event for a tab we don't have cached yet —
          // this happens normally when listeners attach mid-flow. Push it.
          this.tabs.push(t)
          if (window.oz && window.oz.log) {
            window.oz.log.debug(
              'webui/sidebar',
              'tab event without prior create cached',
              {
                kind: info.kind,
                tabId: t.id,
              },
            )
          }
        }
      } else if (info.kind === 'removed') {
        this.tabs = this.tabs.filter((x) => x.id !== info.tabId)
      } else if (info.kind === 'selected') {
        this.activeOzTabId = info.tabId
      } else if (info.kind === 'bulk-created') {
        this.refresh()
        return
      }
      this.render()
    }

    // --- new identity inline editor (window.prompt is blocked in Electron) ----

    handleNewIdentity() {
      if (this.$newBtn.dataset.editing) return
      this.$newBtn.dataset.editing = '1'
      const originalText = this.$newBtn.textContent
      this.$newBtn.textContent = ''
      const input = document.createElement('input')
      input.placeholder = 'Identity name…'
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
          const ident = await safe(
            window.oz.identities.create({ name }),
            'identities.create',
          )
          if (ident && ident.__error) {
            // Free-tier cap reached or other structured error.
            alert(ident.__error.message || 'Cannot create identity.')
            return
          }
          if (ident && ident.id) {
            await safe(window.oz.identities.setActive(ident.id), 'identities.setActive')
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

    // --- per-identity actions -------------------------------------------------

    handleNewTabIn(identityId) {
      safe(
        window.oz.tabs.openInIdentity(identityId, 'about:blank'),
        'tabs.openInIdentity',
      )
    }

    handleSelectTab(ozTabId) {
      safe(window.oz.tabs.select(ozTabId), 'tabs.select')
    }

    handleCloseTab(ozTabId, ev) {
      if (ev) ev.stopPropagation()
      safe(window.oz.tabs.close(ozTabId), 'tabs.close')
    }

    handleSelectIdentity(identityId) {
      safe(window.oz.identities.setActive(identityId), 'identities.setActive')
    }

    handleRenameIdentity(identityId, currentName, rowEl) {
      const nameEl = rowEl.querySelector('.identity-name')
      nameEl.innerHTML = ''
      const input = document.createElement('input')
      input.value = currentName
      nameEl.appendChild(input)
      input.focus()
      input.select()
      const commit = async () => {
        const v = input.value.trim()
        if (v && v !== currentName) {
          await safe(window.oz.identities.rename(identityId, v), 'identities.rename')
        } else this.render()
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur()
        if (e.key === 'Escape') {
          input.value = currentName
          input.blur()
        }
      })
    }

    handleEditIdentity(identity) {
      const editor = window.OZ && window.OZ.IdentityEditor
      if (!editor) {
        alert('Identity editor not available.')
        return
      }
      editor.open(identity)
    }

    handleDeleteIdentity(identity) {
      if (identity.isDefault) {
        alert('Cannot delete the Default identity.')
        return
      }
      // H2: locked identities reject remove on the backend too — this is the
      // friendly UX surface. Asks the user to unlock first instead of trying.
      if (identity.locked) {
        alert(
          `Identity "${identity.name}" is locked. Right-click → Unlock identity first to delete it.`,
        )
        return
      }
      if (
        !confirm(
          `Delete identity "${identity.name}"?\n\n` +
            `Tabs of this identity will be closed.\n` +
            `Cookies and storage data on disk will remain — recoverable until you clear app data.`,
        )
      )
        return
      safe(window.oz.identities.remove(identity.id), 'identities.remove')
    }

    handleToggleLockIdentity(identity) {
      const next = !identity.locked
      safe(window.oz.identities.setLocked(identity.id, next), 'identities.setLocked')
    }

    showContextMenu(e, identity) {
      e.preventDefault()
      e.stopPropagation()
      const existing = document.querySelector('.ctx-menu')
      if (existing) existing.remove()
      const menu = document.createElement('div')
      menu.className = 'ctx-menu'
      menu.style.left = `${e.clientX}px`
      menu.style.top = `${e.clientY}px`

      const renameBtn = document.createElement('button')
      renameBtn.textContent = 'Rename'
      renameBtn.addEventListener('click', () => {
        menu.remove()
        const rowEl = document.querySelector(
          `.identity-row[data-identity-id="${identity.id}"]`,
        )
        if (rowEl) this.handleRenameIdentity(identity.id, identity.name, rowEl)
      })
      menu.appendChild(renameBtn)

      const editBtn = document.createElement('button')
      editBtn.textContent = 'Edit identity…'
      editBtn.addEventListener('click', () => {
        menu.remove()
        this.handleEditIdentity(identity)
      })
      menu.appendChild(editBtn)

      // H2: lock toggle. Available for all identities (including Default —
      // locking Default also blocks clearBrowsingData on it).
      const lockBtn = document.createElement('button')
      lockBtn.textContent = identity.locked ? 'Unlock identity' : 'Lock identity'
      lockBtn.addEventListener('click', () => {
        menu.remove()
        this.handleToggleLockIdentity(identity)
      })
      menu.appendChild(lockBtn)

      if (!identity.isDefault) {
        const delBtn = document.createElement('button')
        delBtn.className = 'danger'
        delBtn.textContent = identity.locked
          ? 'Delete identity (locked)'
          : 'Delete identity'
        delBtn.disabled = !!identity.locked
        delBtn.addEventListener('click', () => {
          menu.remove()
          this.handleDeleteIdentity(identity)
        })
        menu.appendChild(delBtn)
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

    // --- rendering ------------------------------------------------------------

    render() {
      if (!this.$root) return
      this.$root.innerHTML = ''
      for (const identity of this.identities) {
        this.$root.appendChild(this.renderIdentityWrapper(identity))
      }
    }

    renderIdentityWrapper(identity) {
      const wrapper = document.createElement('div')
      wrapper.className = 'identity'

      const row = this.renderIdentityRow(identity)
      wrapper.appendChild(row)

      const tabsContainer = document.createElement('div')
      tabsContainer.className = 'identity-tabs'
      const tabsOfIdentity = this.tabs.filter((t) => t.identityId === identity.id)
      for (const tab of tabsOfIdentity) {
        tabsContainer.appendChild(this.renderTabItem(tab, identity))
      }
      wrapper.appendChild(tabsContainer)
      return wrapper
    }

    renderIdentityRow(identity) {
      const row = document.createElement('div')
      row.className = 'identity-row'
      row.dataset.identityId = identity.id
      if (identity.id === this.activeIdentityId) row.classList.add('active')
      if (identity.isDefault) row.classList.add('default')

      const chip = document.createElement('span')
      chip.className = 'identity-chip'
      chip.style.background = identity.color
      row.appendChild(chip)

      const name = document.createElement('span')
      name.className = 'identity-name'
      // H2: prepend lock indicator if locked. Single span, no extra DOM.
      name.textContent = identity.locked ? `\u{1F512} ${identity.name}` : identity.name
      row.appendChild(name)

      // Tab count badge — total tabs of this identity (lazy + materialized).
      const tabCount = this.tabs.filter((t) => t.identityId === identity.id).length
      const count = document.createElement('span')
      count.className = 'identity-count'
      count.textContent = `(${tabCount})`
      if (tabCount === 0) count.classList.add('zero')
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
      row.addEventListener('contextmenu', (e) => this.showContextMenu(e, identity))
      row.addEventListener('dblclick', () =>
        this.handleRenameIdentity(identity.id, identity.name, row),
      )
      return row
    }

    renderTabItem(tab, identity) {
      const el = document.createElement('div')
      el.className = 'oz-tab'
      el.dataset.tabId = tab.id
      if (!tab.isLoaded) el.classList.add('lazy')
      if (tab.id === this.activeOzTabId) el.classList.add('active')

      // 1.4d: HTML5 drag-drop — tab is the source.
      el.draggable = true
      el.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/oz-tab-id', tab.id)
        ev.dataTransfer.effectAllowed = 'move'
        el.classList.add('dragging')
      })
      el.addEventListener('dragend', () => el.classList.remove('dragging'))

      const fav = document.createElement('span')
      fav.className = 'oz-favicon'
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
      el.appendChild(fav)

      const title = document.createElement('span')
      title.className = 'oz-title'
      // H2: prepend lock indicator if locked.
      const baseTitle = tab.title || tab.url || 'New Tab'
      title.textContent = tab.locked ? `\u{1F512} ${baseTitle}` : baseTitle
      title.title = tab.url || ''
      el.appendChild(title)

      // H2: hide the close button when locked. Same affordance as tabstrip —
      // visually communicates "you can't close me by accident". The handler
      // also rejects, but hiding is the primary signal.
      if (!tab.locked) {
        const close = document.createElement('button')
        close.className = 'oz-close'
        close.textContent = '✕'
        close.addEventListener('click', (e) => this.handleCloseTab(tab.id, e))
        el.appendChild(close)
      }

      el.addEventListener('click', () => this.handleSelectTab(tab.id))
      // 1.4d: right-click → ctx menu with "Move to workspace…" submenu.
      el.addEventListener('contextmenu', (ev) => this.showTabContextMenu(ev, tab))
      return el
    }

    // 1.7d: tab right-click → native context menu (16 options, replicating
    // Ghost Browser). The 1.4d HTML ctx-menu was replaced by a single IPC
    // call to oz:tabs:contextMenu — main process builds the template via
    // browser/tab-context-menu.js and pops it natively at the cursor.
    //
    // Why native: (1) consistent with Chrome's right-click UX, (2) free
    // keyboard nav, (3) doesn't fight WebContentsViews stacking (ADR 0011).
    async showTabContextMenu(ev, tab) {
      ev.preventDefault()
      ev.stopPropagation()
      if (!window.oz || !window.oz.tabs || !window.oz.tabs.contextMenu) return
      await safe(
        window.oz.tabs.contextMenu(tab.id, { x: ev.clientX, y: ev.clientY }),
        'tabs.contextMenu',
      )
    }
  }

  window.OZ.IdentitySidebar = IdentitySidebar
})()
