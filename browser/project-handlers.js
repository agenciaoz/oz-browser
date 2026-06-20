// OZ Browser — Project handlers (F2). Capture/save/open named tab sets.
//
// Consumido por IPC (project-ipc-setup.js) y MCP (mcp-tools-projects.js) bajo
// browser.handlers.projects. El store (persistencia) vive en project-store.js;
// acá está la captura del estado vivo (browser.windows) y la reapertura.
//
// ADR: 0005 (modular).

'use strict'

const { app } = require('electron')
const { ProjectStore } = require('./project-store')
const log = require('./logger')

function buildProjectHandlers(browser) {
  const store = new ProjectStore({ userDataDir: app.getPath('userData') })

  // type 'session' → todas las ventanas; 'workspace' → solo la ventana activa.
  function captureTabs(type) {
    const targets =
      type === 'session'
        ? browser.windows || []
        : [browser.getFocusedWindow && browser.getFocusedWindow()].filter(Boolean)
    const out = []
    for (const win of targets) {
      if (!win || !win.tabs) continue
      for (const t of win.tabs.tabList) {
        const s = t.serialize ? t.serialize() : t
        if (!s || !s.url || s.url === 'about:blank') continue
        out.push({
          identityId: s.identityId,
          url: s.url,
          title: s.title || '',
          windowId: win.id,
        })
      }
    }
    return out
  }

  return {
    list: () => store.list(),
    get: (id) => store.get(id),
    save: ({ name, type } = {}) => store.save({ name, type, tabs: captureTabs(type) }),
    rename: (id, name) => store.rename(id, name),
    remove: (id) => store.remove(id),
    open: (id) => {
      const p = store.get(id)
      if (!p) return { ok: false, opened: 0, reason: 'not-found' }
      const h = browser.handlers && browser.handlers.tabs
      if (!h) return { ok: false, opened: 0, reason: 'no-tabs-handler' }
      let opened = 0
      let lastId = null
      for (const tab of p.tabs) {
        try {
          const tid = h.openInIdentity(tab.identityId, tab.url)
          if (tid) {
            opened++
            lastId = tid
          }
        } catch (err) {
          log.warn('project-handlers', 'open tab failed', {
            url: tab.url,
            message: err.message,
          })
        }
      }
      if (lastId) h.select(lastId)
      return { ok: true, opened, total: p.tabs.length }
    },
  }
}

module.exports = { buildProjectHandlers }
