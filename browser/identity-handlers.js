// OZ Browser — Identity domain handlers (pure map of name → fn).
//
// Qué hace: factoriza la lógica de los IPC handlers de Identity en un mapa que
// pueden consumir DOS layers: ipcMain (via ipc-handlers.js) y MCP (via
// mcp-server.js). Misma implementación, dos transports.
//
// Doc: docs/modules/identity-handlers.md
// ADR: docs/architecture/0012-oz-mcp-server.md (la justificación del refactor)
//
// Exports: buildIdentityHandlers(browser) -> Record<string, (args) => any>
// IPC: ninguno directo (los registra ipc-handlers.js).
//
// Convención:
//   - Cada handler recibe argumentos posicionales (mismo orden que el IPC original).
//   - Cada handler retorna lo que el IPC devolvía.
//   - Los efectos secundarios (broadcastToWebUI, etc.) viven dentro del handler.
//   - El nombre del handler en el mapa es el nombre canónico del tool MCP
//     (sin prefijo `oz.identities.` — eso lo agrega mcp-tools.js).

const log = require('./logger')

function buildIdentityHandlers(browser) {
  const im = () => browser.identityManager

  return {
    list() {
      return im().list()
    },

    get(id) {
      return im().get(id)
    },

    getActive() {
      return browser.activeIdentityId
    },

    setActive(id) {
      const ident = im().get(id)
      if (!ident) return false
      browser.activeIdentityId = id
      browser.broadcastToWebUI('oz:identities:active-changed', id)
      log.info('identity-handlers', 'setActive', { id })
      return true
    },

    create(opts) {
      try {
        const ident = im().create(opts || {})
        browser.broadcastToWebUI('oz:identities:changed')
        log.info('identity-handlers', 'create ok', { id: ident.id, name: ident.name })
        return ident
      } catch (err) {
        if (err && err.code === 'IDENTITY_CAP_REACHED') {
          log.warn('identity-handlers', 'create blocked by cap', {
            current: err.current,
            max: err.max,
          })
          return {
            __error: {
              code: err.code,
              message: err.message,
              current: err.current,
              max: err.max,
            },
          }
        }
        throw err
      }
    },

    rename(id, name) {
      const ident = im().rename(id, name)
      if (ident) browser.broadcastToWebUI('oz:identities:changed')
      return ident
    },

    setColor(id, color) {
      const ident = im().setColor(id, color)
      if (ident) browser.broadcastToWebUI('oz:identities:changed')
      return ident
    },

    update(id, patch) {
      const ident = im().update(id, patch || {})
      if (ident) browser.broadcastToWebUI('oz:identities:changed')
      return ident
    },

    remove(id) {
      if (browser.activeIdentityId === id) {
        browser.activeIdentityId = im().getDefault().id
        browser.broadcastToWebUI('oz:identities:active-changed', browser.activeIdentityId)
      }
      const ok = im().remove(id)
      if (ok) browser.broadcastToWebUI('oz:identities:changed')
      log.info('identity-handlers', 'remove', { id, ok })
      return ok
    },
  }
}

module.exports = { buildIdentityHandlers }
