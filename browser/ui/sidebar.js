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

      if (!identity.isDefault) {
        const delBtn = document.createElement('button')
        delBtn.className = 'danger'
        delBtn.textContent = 'Delete identity'
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
      name.textContent = identity.name
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
      if (!tab.isLoaded) el.classList.add('lazy')
      if (tab.id === this.activeOzTabId) el.classList.add('active')

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
      title.textContent = tab.title || tab.url || 'New Tab'
      title.title = tab.url || ''
      el.appendChild(title)

      const close = document.createElement('button')
      close.className = 'oz-close'
      close.textContent = '✕'
      close.addEventListener('click', (e) => this.handleCloseTab(tab.id, e))
      el.appendChild(close)

      el.addEventListener('click', () => this.handleSelectTab(tab.id))
      return el
    }
  }

  window.OZ.IdentitySidebar = IdentitySidebar
})()
