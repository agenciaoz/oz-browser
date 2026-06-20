// OZ Browser — Top tabstrip (uses window.oz, NOT chrome.tabs).
// Shows ALL tabs across ALL identities with an identity-color stripe.
//
// Wrapped in IIFE so the `const { safe, ... }` destructure stays file-local.
// Without this, classic scripts in the same document share a global lexical
// environment and any `const safe` declared at top-level in a sibling script
// (sidebar.js, identity-editor.js, webui.js) collides with this one.

;(function () {
  const { safe, identityColor, identityName } = window.OZ.utils

  class TabStrip {
    tabs = []
    identities = []
    activeOzTabId = null
    // alpha.65: multi-row tabstrip + drag-reorder state.
    maxRows = 3
    _lastRows = null
    _dragId = null

    constructor() {
      const $ = document.querySelector.bind(document)
      this.$ = {
        list: $('#tabstrip .tab-list'),
        tpl: $('#tabtemplate'),
        createBtn: $('#createtab'),
        back: $('#goback'),
        forward: $('#goforward'),
        reload: $('#reload'),
        url: $('#addressurl'),
        minimize: $('#minimize'),
        maximize: $('#maximize'),
        close: $('#close'),
      }

      this.$.createBtn.addEventListener('click', () => this.handleCreate())
      this.$.back.addEventListener('click', () => safe(window.oz.nav.back(), 'nav.back'))
      this.$.forward.addEventListener('click', () =>
        safe(window.oz.nav.forward(), 'nav.forward'),
      )
      this.$.reload.addEventListener('click', () =>
        safe(window.oz.nav.reload(), 'nav.reload'),
      )
      this.$.url.addEventListener('keypress', (ev) => {
        if (ev.code === 'Enter') {
          const raw = this.$.url.value.trim()
          if (!raw) return
          // Normalize URL aquí (renderer): sin esto, "x.com" → ERR_INVALID_ARGUMENT
          // silente en webContents.loadURL. Mantenelo en sync con
          // browser/url-normalize.js (mismo regex) — los tests del backend
          // (tests/url-normalize.smoketest.js, 29/29) cubren la lógica.
          const SCHEME_RE =
            /^(https?|ftp|file|chrome|chrome-extension|about|view-source|data|mailto|tel|javascript):/i
          const DOMAIN_LIKE_RE =
            /^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(:\d+)?(\/[^\s]*)?(\?[^\s]*)?$|^localhost(:\d+)?(\/[^\s]*)?(\?[^\s]*)?$|^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/[^\s]*)?(\?[^\s]*)?$/i
          let url
          if (SCHEME_RE.test(raw)) url = raw
          else if (DOMAIN_LIKE_RE.test(raw)) url = 'https://' + raw
          else url = 'https://www.google.com/search?q=' + encodeURIComponent(raw)
          this.$.url.value = url // refleja la URL navegable post-Enter
          safe(window.oz.nav.loadURL(url), 'nav.loadURL')
        }
      })

      // Window controls (linux only per CSS).
      this.$.minimize.addEventListener('click', () =>
        chrome.windows.get(chrome.windows.WINDOW_ID_CURRENT, (win) =>
          chrome.windows.update(win.id, {
            state: win.state === 'minimized' ? 'normal' : 'minimized',
          }),
        ),
      )
      this.$.maximize.addEventListener('click', () =>
        chrome.windows.get(chrome.windows.WINDOW_ID_CURRENT, (win) =>
          chrome.windows.update(win.id, {
            state: win.state === 'maximized' ? 'normal' : 'maximized',
          }),
        ),
      )
      this.$.close.addEventListener('click', () => chrome.windows.remove())

      document.body.classList.add(
        `platform-${navigator.userAgentData.platform.toLowerCase()}`,
      )
    }

    async init() {
      if (!window.oz) {
        console.error('[oz-tabstrip] window.oz missing — preload not run.')
        return
      }
      this.identities = await window.oz.identities.list()
      this.tabs = await window.oz.tabs.list()
      await this.loadMaxRows()
      this.render()
      window.oz.identities.onChanged(async () => {
        this.identities = await window.oz.identities.list()
        this.render()
      })
      window.oz.tabs.onUpdated((info) => this.handleEvent(info))
      // alpha.65: re-evaluate row count when the window width changes.
      window.addEventListener('resize', () => this.applyRows())
    }

    async loadMaxRows() {
      const L = window.OZ.TabstripLayout
      try {
        const ts = await window.oz.settings.get('tabStrip')
        this.maxRows = L ? L.clampMaxRows(ts && ts.maxRows) : 3
      } catch (_e) {
        this.maxRows = L ? L.MAX_ROWS : 3
      }
    }

    // Compute how many rows the tabstrip needs and report it to main so the
    // page content view inset tracks the (taller) chrome. Also drives the
    // --oz-tab-rows CSS var that pushes the toolbar down.
    applyRows() {
      const L = window.OZ.TabstripLayout
      if (!L || !this.$.list) return
      const rows = L.rowCountFor({
        count: this.tabs.length,
        containerWidth: this.$.list.clientWidth || 0,
        minTabWidth: 120,
        maxRows: this.maxRows,
      })
      document.documentElement.style.setProperty('--oz-tab-rows', String(rows))
      if (rows === this._lastRows) return
      this._lastRows = rows
      if (window.oz.chrome && window.oz.chrome.setRows) {
        safe(window.oz.chrome.setRows(rows), 'chrome.setRows')
      }
    }

    handleEvent(info) {
      if (!info) return
      if (
        info.kind === 'created' ||
        info.kind === 'updated' ||
        info.kind === 'materialized'
      ) {
        const t = info.tab
        if (!t) return
        const idx = this.tabs.findIndex((x) => x.id === t.id)
        if (idx >= 0) this.tabs[idx] = { ...this.tabs[idx], ...t }
        else this.tabs.push(t)
      } else if (info.kind === 'removed') {
        this.tabs = this.tabs.filter((x) => x.id !== info.tabId)
      } else if (info.kind === 'selected') {
        this.activeOzTabId = info.tabId
        const sel = this.tabs.find((x) => x.id === info.tabId)
        if (sel) this.renderToolbar(sel)
      } else if (info.kind === 'bulk-created' || info.kind === 'reordered') {
        // alpha.65: reordered → re-list so the strip reflects the new order.
        window.oz.tabs.list().then((all) => {
          this.tabs = all
          this.render()
        })
        return
      }
      this.render()
    }

    async handleCreate() {
      const activeId = await window.oz.identities.getActive()
      const id = await safe(
        window.oz.tabs.openInIdentity(activeId, 'about:blank'),
        'tabs.openInIdentity',
      )
      if (id) safe(window.oz.tabs.select(id), 'tabs.select')
    }

    render() {
      if (!this.$.list) return
      this.$.list.innerHTML = ''
      for (const tab of this.tabs) {
        this.$.list.appendChild(this.renderTabNode(tab))
      }
      // alpha.65: recompute rows after the DOM is laid out (clientWidth needs a
      // frame to be accurate after innerHTML reset).
      window.requestAnimationFrame(() => this.applyRows())
    }

    // alpha.65: wire HTML5 drag-and-drop on a tab node to reorder it. Uses an
    // instance var for the dragged id so the original id type is preserved
    // (dataTransfer only carries strings).
    wireDrag(node, tab) {
      node.draggable = true
      node.addEventListener('dragstart', (ev) => {
        this._dragId = tab.id
        node.dataset.dragging = ''
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move'
          ev.dataTransfer.setData('text/plain', String(tab.id))
        }
      })
      node.addEventListener('dragend', () => {
        delete node.dataset.dragging
        this.clearDropMarkers()
      })
      node.addEventListener('dragover', (ev) => {
        ev.preventDefault()
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
        if (this._dragId == null || this._dragId === tab.id) return
        // Live indicator: left half → marker BEFORE this tab, right half → AFTER.
        const rect = node.getBoundingClientRect()
        const side = ev.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
        if (node.dataset.dropSide !== side) {
          this.clearDropMarkers()
          node.dataset.dropSide = side
        }
      })
      node.addEventListener('dragleave', () => delete node.dataset.dropSide)
      node.addEventListener('drop', (ev) => {
        ev.preventDefault()
        const side = node.dataset.dropSide || 'before'
        this.clearDropMarkers()
        const fromId = this._dragId
        this._dragId = null
        if (fromId == null || fromId === tab.id) return
        const fromIndex = this.tabs.findIndex((t) => t.id === fromId)
        const targetIndex = this.tabs.findIndex((t) => t.id === tab.id)
        if (fromIndex < 0 || targetIndex < 0) return
        const to = window.OZ.TabstripLayout.dropTargetIndex(fromIndex, targetIndex, side)
        safe(window.oz.tabs.reorder(fromId, to), 'tabs.reorder')
      })
    }

    // Remove the live drop indicator from every tab.
    clearDropMarkers() {
      if (!this.$.list) return
      for (const el of this.$.list.querySelectorAll('.tab[data-drop-side]')) {
        delete el.dataset.dropSide
      }
    }

    renderTabNode(tab) {
      const node = this.$.tpl.content.cloneNode(true).firstElementChild
      node.dataset.tabId = tab.id
      if (tab.id === this.activeOzTabId) node.dataset.active = ''

      // Identity color stripe on left edge + color dot (alpha.38).
      const color = identityColor(this.identities, tab.identityId)
      const idName = identityName(this.identities, tab.identityId)
      node.style.boxShadow = `inset 3px 0 0 0 ${color}, inset -1px 0 0 0 rgba(0,0,0,0.33)`
      // Tooltip keeps the full page title + url (the visible label is compact).
      node.title = `Identity: ${idName}\n${tab.title || 'New Tab'}\n${tab.url || ''}`

      const dot = document.createElement('span')
      dot.className = 'oz-tab-iddot'
      dot.style.background = color
      node.insertBefore(dot, node.firstChild)

      if (!tab.isLoaded) node.style.opacity = '0.7'

      node.addEventListener('click', () =>
        safe(window.oz.tabs.select(tab.id), 'tabs.select'),
      )

      // 1.7d: right-click → native context menu (same as sidebar — Menu.popup
      // via main process). One templated menu shared across all click sites.
      node.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        if (!window.oz || !window.oz.tabs || !window.oz.tabs.contextMenu) return
        safe(
          window.oz.tabs.contextMenu(tab.id, { x: ev.clientX, y: ev.clientY }),
          'tabs.contextMenu',
        )
      })

      const closeBtn = node.querySelector('.close')
      // H2: locked tabs hide the close button (visually communicates "you
      // can't close me by accident"). The handler also rejects, but hiding
      // the button is the primary affordance.
      if (tab.locked) {
        closeBtn.style.display = 'none'
      } else {
        closeBtn.style.display = ''
        closeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation()
          safe(window.oz.tabs.close(tab.id), 'tabs.close')
        })
      }

      const fav = node.querySelector('.favicon')
      if (tab.favicon) {
        fav.src = tab.favicon
        fav.classList.add('loaded')
      }

      // H2: prepend lock indicator to the title text (no extra DOM node — the
      // template's `.title` span already renders text content). Pinned tabs
      // already collapse to favicon-only, so the indicator only shows on
      // unpinned-locked tabs which is the common case.
      // alpha.38: compact label "Identity · RED" (full page title is in tooltip).
      const label = window.OZ.TabLabel
        ? window.OZ.TabLabel.tabDisplayLabel(idName, tab.url)
        : tab.title || 'New Tab'
      node.querySelector('.title').textContent = tab.locked ? `\u{1F512} ${label}` : label
      node.querySelector('.audio').disabled = true

      // alpha.65: drag-and-drop reorder.
      this.wireDrag(node, tab)
      return node
    }

    renderToolbar(tab) {
      if (!tab) return
      this.$.url.value = tab.url || ''
    }
  }

  window.OZ.TabStrip = TabStrip
})()
