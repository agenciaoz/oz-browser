// OZ Browser — Browsing Data modal (1.10.5).
//
// Doc: docs/modules/ui-browsing-data.md
//
// Modal con 3 tabs: Bookmarks / History / Downloads. Reusa managers
// existentes (1.7b BookmarkManager, 1.10b DownloadManager + HistoryManager).
// Click en row reabre la URL en nueva tab (en su identity original).
//
// IIFE wrap — same global-lexical-scope reasoning del resto de UI scripts.

;(function () {
  const { safe } = window.OZ.utils
  // v1.5.6: i18n — lazy lookup via window.OZ.i18n.t() so locale switches
  // pick up automatically. Falls back to the key if i18n isn't loaded
  // yet (defensive — webui.html loads i18n.js BEFORE browsing-data.js but
  // the catalog fetch is async, so the very first call from the constructor
  // could race with init).
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  class BrowsingDataUI {
    constructor() {
      this.$modal = document.getElementById('oz-bd-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/browsing-data', 'modal markup missing')
        }
        return
      }
      this.$openBtn = document.getElementById('oz-bd-button')
      this.$err = document.getElementById('oz-bd-error')

      // Tab buttons
      this.$tabBtns = this.$modal.querySelectorAll('.bd-tab-btn[data-tab]')
      this.$tabSections = this.$modal.querySelectorAll('section[data-tab]')

      // Bookmarks
      this.$bmSearch = document.getElementById('oz-bd-bm-search')
      this.$bmFilter = document.getElementById('oz-bd-bm-filter-identity')
      this.$bmList = document.getElementById('oz-bd-bm-list')
      this.$bmEmpty = document.getElementById('oz-bd-bm-empty')
      this.$bmCount = document.getElementById('oz-bd-count-bookmarks')
      document
        .getElementById('oz-bd-bm-clear')
        .addEventListener('click', () => this.handleClearBookmarks())

      // History
      this.$histSearch = document.getElementById('oz-bd-hist-search')
      this.$histFilter = document.getElementById('oz-bd-hist-filter-identity')
      this.$histList = document.getElementById('oz-bd-hist-list')
      this.$histEmpty = document.getElementById('oz-bd-hist-empty')
      this.$histCount = document.getElementById('oz-bd-count-history')
      document
        .getElementById('oz-bd-hist-clear')
        .addEventListener('click', () => this.handleClearHistory())

      // Downloads
      this.$dlFilterIdentity = document.getElementById('oz-bd-dl-filter-identity')
      this.$dlFilterState = document.getElementById('oz-bd-dl-filter-state')
      this.$dlList = document.getElementById('oz-bd-dl-list')
      this.$dlEmpty = document.getElementById('oz-bd-dl-empty')
      this.$dlCount = document.getElementById('oz-bd-count-downloads')
      document
        .getElementById('oz-bd-dl-clear')
        .addEventListener('click', () => this.handleClearDownloads())

      this.identities = []
      this.bookmarks = []
      this.history = []
      this.downloads = []
      this.currentTab = 'bookmarks'

      this._wire()

      // v1.5.6: re-render dynamic content on locale switch. translatePage()
      // re-renders the static markup automatically (tab labels, empty
      // states, etc), but the row content (Delete button, identity options,
      // timeAgo labels) lives in innerHTML strings we build ourselves.
      if (window.OZ && window.OZ.i18n && typeof window.OZ.i18n.onChange === 'function') {
        window.OZ.i18n.onChange(() => {
          if (this.$modal.hidden) return
          // refreshIdentities rebuilds the filter <option> list which
          // includes a translated "All identities" entry.
          this.refreshIdentities()
            .then(() => {
              this.renderBookmarks()
              this.renderHistory()
              this.renderDownloads()
            })
            .catch(() => {
              // swallow — locale switch must never throw out of i18n callback
            })
        })
      }
    }

    _wire() {
      if (this.$openBtn) this.$openBtn.addEventListener('click', () => this.open())
      this.$modal.addEventListener('click', (ev) => {
        if (ev.target.dataset.close !== undefined) this.close()
      })
      this.$tabBtns.forEach((b) =>
        b.addEventListener('click', () => this.showTab(b.dataset.tab)),
      )

      // Live search/filter
      this.$bmSearch.addEventListener('input', () => this.renderBookmarks())
      this.$bmFilter.addEventListener('change', () => this.renderBookmarks())
      this.$histSearch.addEventListener('input', () => this.renderHistory())
      this.$histFilter.addEventListener('change', () => this.renderHistory())
      this.$dlFilterIdentity.addEventListener('change', () => this.renderDownloads())
      this.$dlFilterState.addEventListener('change', () => this.renderDownloads())

      // Live updates from main
      if (window.oz && window.oz.bookmarks && window.oz.bookmarks.onChanged) {
        window.oz.bookmarks.onChanged(() => this.refreshBookmarks())
      }
      if (window.oz && window.oz.history && window.oz.history.onChanged) {
        window.oz.history.onChanged(() => this.refreshHistory())
      }
      if (window.oz && window.oz.downloads && window.oz.downloads.onChanged) {
        window.oz.downloads.onChanged(() => this.refreshDownloads())
      }
    }

    async open() {
      this.$modal.hidden = false
      await safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      this.clearError()
      await this.refreshIdentities()
      await this.refreshAll()
      this.showTab(this.currentTab)
    }

    close() {
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
    }

    showTab(name) {
      this.currentTab = name
      this.$tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
      this.$tabSections.forEach((s) => {
        s.hidden = s.dataset.tab !== name
      })
    }

    showError(msg) {
      this.$err.textContent = msg
      this.$err.hidden = false
    }
    clearError() {
      this.$err.hidden = true
      this.$err.textContent = ''
    }

    // ---- shared helpers ------------------------------------------------

    async refreshIdentities() {
      this.identities = await safe(window.oz.identities.list(), 'identities.list')
      if (!Array.isArray(this.identities)) this.identities = []
      // Populate filter selects — "All identities" is localized via t().
      const opts = [
        `<option value="">${escape(t('browsingData.allIdentities'))}</option>`,
      ]
      for (const i of this.identities) {
        opts.push(`<option value="${i.id}">${escape(i.name)}</option>`)
      }
      const html = opts.join('')
      this.$bmFilter.innerHTML = html
      this.$histFilter.innerHTML = html
      this.$dlFilterIdentity.innerHTML = html
    }

    async refreshAll() {
      await Promise.all([
        this.refreshBookmarks(),
        this.refreshHistory(),
        this.refreshDownloads(),
      ])
    }

    identityName(id) {
      const i = this.identities.find((x) => x.id === id)
      return i ? i.name : id
    }
    identityColor(id) {
      const i = this.identities.find((x) => x.id === id)
      return i ? i.color : '#888'
    }

    /** Open URL in the original identity. Closes the modal first. */
    async openInIdentity(identityId, url) {
      this.close()
      await safe(window.oz.tabs.openInIdentity(identityId, url), 'tabs.openInIdentity')
    }

    // ---- Bookmarks -----------------------------------------------------

    async refreshBookmarks() {
      this.bookmarks = await safe(window.oz.bookmarks.list(), 'bookmarks.list')
      if (!Array.isArray(this.bookmarks)) this.bookmarks = []
      this.$bmCount.textContent = this.bookmarks.length
      if (!this.$modal.hidden) this.renderBookmarks()
    }

    renderBookmarks() {
      const q = this.$bmSearch.value.toLowerCase()
      const idFilter = this.$bmFilter.value
      let rows = this.bookmarks.slice()
      if (idFilter) rows = rows.filter((b) => b.identityId === idFilter)
      if (q) {
        rows = rows.filter(
          (b) =>
            (b.url && b.url.toLowerCase().includes(q)) ||
            (b.title && b.title.toLowerCase().includes(q)),
        )
      }
      rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      this.$bmList.innerHTML = ''
      this.$bmEmpty.style.display = rows.length === 0 ? '' : 'none'
      for (const b of rows) {
        const tr = document.createElement('div')
        tr.className = 'bd-row bookmark'
        tr.innerHTML = `
          <span class="bd-favicon" style="background:${this.identityColor(b.identityId)}"></span>
          <div>
            <div class="bd-title" data-url="${escape(b.url)}">${escape(b.title || b.url)}</div>
            <div class="bd-url">${escape(b.url)}</div>
          </div>
          <div class="bd-meta">${escape(this.identityName(b.identityId))}</div>
          <div class="bd-actions"><button data-id="${b.id}">${escape(t('browsingData.delete'))}</button></div>
        `
        tr.querySelector('.bd-title').addEventListener('click', () =>
          this.openInIdentity(b.identityId, b.url),
        )
        tr.querySelector('button').addEventListener('click', async () => {
          await safe(window.oz.bookmarks.remove(b.id), 'bookmarks.remove')
          await this.refreshBookmarks()
        })
        this.$bmList.appendChild(tr)
      }
    }

    async handleClearBookmarks() {
      if (!confirm(t('browsingData.confirmClearBookmarks', { n: this.bookmarks.length })))
        return
      // BookmarkManager.removeByIdentity is bulk, but no clearAll. Iterate.
      for (const b of this.bookmarks.slice()) {
        await safe(window.oz.bookmarks.remove(b.id), 'bookmarks.remove')
      }
      await this.refreshBookmarks()
    }

    // ---- History -------------------------------------------------------

    async refreshHistory() {
      this.history = await safe(window.oz.history.list({ limit: 5000 }), 'history.list')
      if (!Array.isArray(this.history)) this.history = []
      this.$histCount.textContent = this.history.length
      if (!this.$modal.hidden) this.renderHistory()
    }

    renderHistory() {
      const q = this.$histSearch.value.toLowerCase()
      const idFilter = this.$histFilter.value
      let rows = this.history.slice()
      if (idFilter) rows = rows.filter((h) => h.identityId === idFilter)
      if (q) {
        rows = rows.filter(
          (h) =>
            (h.url && h.url.toLowerCase().includes(q)) ||
            (h.title && h.title.toLowerCase().includes(q)),
        )
      }
      // Already sorted by visitedAt desc on backend; cap to 500 for UI perf
      rows = rows.slice(0, 500)
      this.$histList.innerHTML = ''
      this.$histEmpty.style.display = rows.length === 0 ? '' : 'none'
      for (const h of rows) {
        const tr = document.createElement('div')
        tr.className = 'bd-row history'
        tr.innerHTML = `
          <div>
            <div class="bd-title" data-url="${escape(h.url)}">${escape(h.title || h.url)}</div>
            <div class="bd-url">${escape(h.url)}</div>
          </div>
          <div class="bd-meta">${escape(this.identityName(h.identityId))}</div>
          <div class="bd-meta">${escape(timeAgo(h.visitedAt))}</div>
          <div class="bd-actions"><button data-id="${h.id}">${escape(t('browsingData.delete'))}</button></div>
        `
        tr.querySelector('.bd-title').addEventListener('click', () =>
          this.openInIdentity(h.identityId, h.url),
        )
        tr.querySelector('button').addEventListener('click', async () => {
          await safe(window.oz.history.remove(h.id), 'history.remove')
          await this.refreshHistory()
        })
        this.$histList.appendChild(tr)
      }
    }

    async handleClearHistory() {
      if (!confirm(t('browsingData.confirmClearHistory', { n: this.history.length })))
        return
      await safe(window.oz.history.clear(), 'history.clear')
      await this.refreshHistory()
    }

    // ---- Downloads -----------------------------------------------------

    async refreshDownloads() {
      this.downloads = await safe(window.oz.downloads.list(), 'downloads.list')
      if (!Array.isArray(this.downloads)) this.downloads = []
      this.$dlCount.textContent = this.downloads.length
      if (!this.$modal.hidden) this.renderDownloads()
    }

    renderDownloads() {
      const idFilter = this.$dlFilterIdentity.value
      const stFilter = this.$dlFilterState.value
      let rows = this.downloads.slice()
      if (idFilter) rows = rows.filter((d) => d.identityId === idFilter)
      if (stFilter) rows = rows.filter((d) => d.state === stFilter)
      this.$dlList.innerHTML = ''
      this.$dlEmpty.style.display = rows.length === 0 ? '' : 'none'
      for (const d of rows) {
        const tr = document.createElement('div')
        tr.className = 'bd-row download'
        tr.innerHTML = `
          <div>
            <div class="bd-title" data-url="${escape(d.url)}">${escape(d.filename)}</div>
            <div class="bd-url">${escape(d.url)}</div>
          </div>
          <div class="bd-meta">${escape(this.identityName(d.identityId))}</div>
          <div><span class="bd-status ${d.state}">${escape(stateLabel(d.state))}</span></div>
          <div class="bd-actions"><button data-id="${d.id}">${escape(t('browsingData.delete'))}</button></div>
        `
        // Click on title opens the source URL in new tab
        tr.querySelector('.bd-title').addEventListener('click', () =>
          this.openInIdentity(d.identityId, d.url),
        )
        tr.querySelector('button').addEventListener('click', async () => {
          await safe(window.oz.downloads.remove(d.id), 'downloads.remove')
          await this.refreshDownloads()
        })
        this.$dlList.appendChild(tr)
      }
    }

    async handleClearDownloads() {
      if (!confirm(t('browsingData.confirmClearDownloads', { n: this.downloads.length })))
        return
      await safe(window.oz.downloads.clear(), 'downloads.clear')
      await this.refreshDownloads()
    }
  }

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function timeAgo(ms) {
    if (!ms) return ''
    const d = Date.now() - ms
    if (d < 60_000) return t('browsingData.timeAgo.justNow')
    if (d < 3600_000)
      return t('browsingData.timeAgo.minutes', { n: Math.floor(d / 60_000) })
    if (d < 86400_000)
      return t('browsingData.timeAgo.hours', { n: Math.floor(d / 3600_000) })
    if (d < 30 * 86400_000)
      return t('browsingData.timeAgo.days', { n: Math.floor(d / 86400_000) })
    return new Date(ms).toLocaleDateString()
  }

  // v1.5.6: download state pill — maps the backend state string to a
  // localized label. Falls back to the raw state on unknown values.
  function stateLabel(state) {
    if (state === 'progressing') return t('browsingData.states.progressing')
    if (state === 'completed') return t('browsingData.states.completed')
    if (state === 'cancelled') return t('browsingData.states.cancelled')
    if (state === 'interrupted') return t('browsingData.states.interrupted')
    return state
  }

  window.OZ = window.OZ || {}
  window.OZ.BrowsingDataUI = BrowsingDataUI
})()
