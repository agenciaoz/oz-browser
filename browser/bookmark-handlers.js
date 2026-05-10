// OZ Browser — Bookmark domain handlers (1.7b).
//
// Qué hace: factoriza la lógica de bookmark CRUD en handler map puro consumible
// por IPC (oz:bookmarks:*) y MCP (oz.bookmarks.*).
//
// Doc: docs/modules/bookmark-handlers.md
// ADR: docs/architecture/0016-tab-context-menu.md
//
// Exports: buildBookmarkHandlers(browser) -> Record<string, (args) => any>

const log = require('./logger')

function buildBookmarkHandlers(browser) {
  const bm = () => browser.bookmarkManager

  return {
    list(filter) {
      if (!bm()) return []
      return bm().list(filter)
    },

    get(id) {
      if (!bm()) return null
      return bm().get(id)
    },

    add(opts) {
      if (!bm()) return null
      const out = bm().add(opts || {})
      if (out) browser.broadcastToWebUI('oz:bookmarks:changed')
      return out
    },

    /** Resolve a tab by id and bookmark its current url+title+favicon. */
    addFromTab(tabId) {
      if (!bm()) return { ok: false, reason: 'no-bookmark-manager' }
      let target = null
      for (const w of browser.windows || []) {
        const t = w.tabs && w.tabs.get && w.tabs.get(tabId)
        if (t) {
          target = t
          break
        }
      }
      if (!target) return { ok: false, reason: 'tab-not-found', tabId }
      const out = bm().addFromTab(target.serialize ? target.serialize() : target)
      if (out) browser.broadcastToWebUI('oz:bookmarks:changed')
      log.info('bookmark-handlers', 'addFromTab', {
        tabId,
        bookmarkId: out && out.id,
        deduped: !!(out && out.deduped),
      })
      return { ok: true, tabId, bookmark: out }
    },

    remove(id) {
      if (!bm()) return false
      const ok = bm().remove(id)
      if (ok) browser.broadcastToWebUI('oz:bookmarks:changed')
      return ok
    },
  }
}

module.exports = { buildBookmarkHandlers }
