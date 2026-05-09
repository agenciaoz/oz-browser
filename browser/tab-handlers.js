// OZ Browser — Tab domain handlers (pure map of name → fn).
//
// Qué hace: factoriza los IPC handlers de Tabs en un mapa consumible por IPC y MCP.
//
// Doc: docs/modules/tab-handlers.md
// ADR: docs/architecture/0012-oz-mcp-server.md
//
// Exports: buildTabHandlers(browser) -> Record<string, (args) => any>
// IPC: ninguno directo (los registra ipc-handlers.js).

const log = require('./logger')

function buildTabHandlers(browser) {
  return {
    list() {
      const result = []
      for (const win of browser.windows) {
        for (const t of win.tabs.tabList) {
          result.push({ ...t.serialize(), windowId: win.id })
        }
      }
      return result
    },

    getIdentity(tabId) {
      for (const win of browser.windows) {
        const tab = win.tabs.get(tabId)
        if (tab) return tab.identityId
      }
      return null
    },

    openInIdentity(identityId, url) {
      const win = browser.getFocusedWindow()
      if (!win) {
        log.warn('tab-handlers', 'openInIdentity: no focused window')
        return null
      }
      const tab = win.tabs.create({
        identityId,
        url,
        source: 'tab-handlers.openInIdentity',
      })
      browser.broadcastToWebUI('oz:tabs:updated', {
        kind: 'created',
        tab: { ...tab.serialize(), windowId: win.id },
      })
      log.info('tab-handlers', 'openInIdentity ok', {
        tabId: tab.id,
        identityId,
        url,
        windowId: win.id,
      })
      return tab.id
    },

    select(tabId) {
      for (const win of browser.windows) {
        if (win.tabs.get(tabId)) {
          win.tabs.select(tabId)
          return true
        }
      }
      log.warn('tab-handlers', 'select: tabId not found', { tabId })
      return false
    },

    close(tabId) {
      for (const win of browser.windows) {
        if (win.tabs.get(tabId)) {
          win.tabs.remove(tabId)
          browser.broadcastToWebUI('oz:tabs:updated', { kind: 'removed', tabId })
          log.info('tab-handlers', 'close ok', { tabId, windowId: win.id })
          return true
        }
      }
      log.warn('tab-handlers', 'close: tabId not found', { tabId })
      return false
    },

    bulkCreateLazy(count, identityId, urlTemplate) {
      const win = browser.getFocusedWindow()
      if (!win) return 0
      for (let i = 0; i < count; i++) {
        const url = urlTemplate ? urlTemplate.replace('{i}', String(i)) : 'about:blank'
        win.tabs.create({
          identityId,
          url,
          source: 'tab-handlers.bulkCreateLazy',
        })
      }
      browser.broadcastToWebUI('oz:tabs:updated', { kind: 'bulk-created', count })
      log.info('tab-handlers', 'bulkCreateLazy ok', { count, identityId })
      return count
    },
  }
}

module.exports = { buildTabHandlers }
