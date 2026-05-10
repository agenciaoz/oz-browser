// OZ Browser — Browsing data handlers (1.10b).
//
// Qué hace: handler maps para downloads + history.
//
// Doc: docs/modules/browsing-data-handlers.md
//
// Exports:
//   buildDownloadHandlers(browser)
//   buildHistoryHandlers(browser)

const log = require('./logger')

function buildDownloadHandlers(browser) {
  const dm = () => browser.downloadManager
  return {
    list(filter) {
      if (!dm()) return []
      return dm().list(filter)
    },
    get(id) {
      if (!dm()) return null
      return dm().get(id)
    },
    remove(id) {
      if (!dm()) return false
      return dm().remove(id)
    },
    clear(filter) {
      if (!dm()) return 0
      return dm().clear(filter)
    },
  }
}

function buildHistoryHandlers(browser) {
  const hm = () => browser.historyManager
  return {
    list(filter) {
      if (!hm()) return []
      return hm().list(filter || {})
    },
    remove(id) {
      if (!hm()) return false
      return hm().remove(id)
    },
    clear(filter) {
      if (!hm()) return 0
      return hm().clear(filter || null)
    },
    /** Manual add — used by MCP automation flows. */
    addVisit(opts) {
      if (!hm()) return null
      const r = hm().addVisit(opts || {})
      log.info('history-handlers', 'addVisit', { url: opts && opts.url, ok: !!r })
      return r
    },
  }
}

module.exports = { buildDownloadHandlers, buildHistoryHandlers }
