// OZ Browser — Top tabstrip (uses window.oz, NOT chrome.tabs).
// Shows ALL tabs across ALL identities with an identity-color stripe.

const { safe, identityColor, identityName } = window.OZ.utils

class TabStrip {
  tabs = []
  identities = []
  activeOzTabId = null

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
        const url = this.$.url.value.trim()
        if (url) safe(window.oz.nav.loadURL(url), 'nav.loadURL')
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
    this.render()
    window.oz.identities.onChanged(async () => {
      this.identities = await window.oz.identities.list()
      this.render()
    })
    window.oz.tabs.onUpdated((info) => this.handleEvent(info))
  }

  handleEvent(info) {
    if (!info) return
    if (info.kind === 'created' || info.kind === 'updated' || info.kind === 'materialized') {
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
    } else if (info.kind === 'bulk-created') {
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
  }

  renderTabNode(tab) {
    const node = this.$.tpl.content.cloneNode(true).firstElementChild
    node.dataset.tabId = tab.id
    if (tab.id === this.activeOzTabId) node.dataset.active = ''

    // Identity color stripe on left edge.
    const color = identityColor(this.identities, tab.identityId)
    node.style.boxShadow = `inset 3px 0 0 0 ${color}, inset -1px 0 0 0 rgba(0,0,0,0.33)`
    node.title = `Identity: ${identityName(this.identities, tab.identityId)}\n${tab.url || ''}`

    if (!tab.isLoaded) node.style.opacity = '0.7'

    node.addEventListener('click', () =>
      safe(window.oz.tabs.select(tab.id), 'tabs.select'),
    )

    const closeBtn = node.querySelector('.close')
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      safe(window.oz.tabs.close(tab.id), 'tabs.close')
    })

    const fav = node.querySelector('.favicon')
    if (tab.favicon) {
      fav.src = tab.favicon
      fav.classList.add('loaded')
    }

    node.querySelector('.title').textContent = tab.title || 'New Tab'
    node.querySelector('.audio').disabled = true
    return node
  }

  renderToolbar(tab) {
    if (!tab) return
    this.$.url.value = tab.url || ''
  }
}

window.OZ.TabStrip = TabStrip
