// OZ Browser — Alert handlers (E2-C-5).
//
// Handler map shared by IPC + MCP. Pure adapter — delegates to AlertManager.
//
// Doc: docs/modules/alert-handlers.md

function buildAlertHandlers(browser) {
  const am = () => browser.alertManager

  return {
    list(opts) {
      if (!am()) return []
      return am().list(opts || {})
    },
    add(opts) {
      if (!am()) return null
      return am().add(opts || {})
    },
    markRead(id) {
      if (!am()) return false
      return am().markRead(id)
    },
    markAllRead() {
      if (!am()) return 0
      return am().markAllRead()
    },
    remove(id) {
      if (!am()) return false
      return am().remove(id)
    },
    clear() {
      if (!am()) return 0
      return am().clear()
    },
    unreadCount() {
      if (!am()) return 0
      return am().unreadCount()
    },
  }
}

module.exports = { buildAlertHandlers }
