// OZ Browser — Scheduled Actions handler map (Bloque F-3, v1).
//
// Mismo patrón que sync-handlers / alert-handlers / health-handlers:
// handler map puro consumido por IPC (ipc-handlers-extra.js) y por
// MCP tools (futuro mcp-tools-scheduled.js). NO toca Electron directo
// — recibe el namespace `browser` por inyección y delega al
// `browser.scheduledActions` que F-4 (main.js wire-up) instancia.
//
// Errores del módulo F-1 (ScheduledActionsError con .code) se traducen
// a un objeto coherente `{ ok: false, reason, message }` para que la
// UI pueda mostrar el problema sin parsear excepciones.
//
// Si `browser.scheduledActions` no está instanciado todavía (early
// boot / vault-not-ready), todos los métodos devuelven
// `{ ok: false, reason: 'NOT_CONFIGURED' }`. Análogo a sync-handlers.

'use strict'

function buildScheduledHandlers(browser) {
  function _sa() {
    return browser && browser.scheduledActions ? browser.scheduledActions : null
  }

  function _notConfigured() {
    return { ok: false, reason: 'NOT_CONFIGURED' }
  }

  function _toErrorEnvelope(err) {
    return {
      ok: false,
      reason: err && err.code ? err.code : 'INTERNAL',
      message: err && err.message ? String(err.message) : String(err),
    }
  }

  return {
    list() {
      const sa = _sa()
      if (!sa) return _notConfigured()
      return { ok: true, actions: sa.list() }
    },

    get(id) {
      const sa = _sa()
      if (!sa) return _notConfigured()
      if (typeof id !== 'string' || id.length < 1) {
        return { ok: false, reason: 'BAD_ARG', message: 'id must be a string' }
      }
      const a = sa.get(id)
      if (!a) return { ok: false, reason: 'UNKNOWN_ACTION', message: `no action ${id}` }
      return { ok: true, action: a }
    },

    create(input) {
      const sa = _sa()
      if (!sa) return _notConfigured()
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, reason: 'BAD_ARG', message: 'input must be an object' }
      }
      try {
        const a = sa.create({
          name: input.name,
          action: input.action,
          params: input.params,
          schedule: input.schedule,
          enabled: input.enabled !== false,
        })
        return { ok: true, action: a }
      } catch (err) {
        return _toErrorEnvelope(err)
      }
    },

    update(id, patch) {
      const sa = _sa()
      if (!sa) return _notConfigured()
      if (typeof id !== 'string' || id.length < 1) {
        return { ok: false, reason: 'BAD_ARG', message: 'id must be a string' }
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, reason: 'BAD_ARG', message: 'patch must be an object' }
      }
      try {
        const a = sa.update(id, patch)
        return { ok: true, action: a }
      } catch (err) {
        return _toErrorEnvelope(err)
      }
    },

    remove(id) {
      const sa = _sa()
      if (!sa) return _notConfigured()
      if (typeof id !== 'string' || id.length < 1) {
        return { ok: false, reason: 'BAD_ARG', message: 'id must be a string' }
      }
      const removed = sa.remove(id)
      return { ok: true, removed }
    },

    setEnabled(id, enabled) {
      const sa = _sa()
      if (!sa) return _notConfigured()
      if (typeof id !== 'string' || id.length < 1) {
        return { ok: false, reason: 'BAD_ARG', message: 'id must be a string' }
      }
      if (typeof enabled !== 'boolean') {
        return { ok: false, reason: 'BAD_ARG', message: 'enabled must be boolean' }
      }
      try {
        const a = sa.setEnabled(id, enabled)
        return { ok: true, action: a }
      } catch (err) {
        return _toErrorEnvelope(err)
      }
    },

    /**
     * Snapshot of the runner for the UI's status badge. Static fields only
     * — the UI polls this every few seconds, no event subscription needed
     * for v1.
     */
    getStatus() {
      const sa = _sa()
      if (!sa) {
        return {
          configured: false,
          running: false,
          actionCount: 0,
        }
      }
      return {
        configured: true,
        running: sa.isRunning(),
        actionCount: sa.size(),
      }
    },

    /**
     * Force-fire any due actions right now (one-tick). Mirrors syncBootstrap's
     * pullNow — useful for "Run now" buttons in Settings UI.
     */
    async tickNow() {
      const sa = _sa()
      if (!sa) return _notConfigured()
      try {
        await sa.tick()
        return { ok: true }
      } catch (err) {
        return _toErrorEnvelope(err)
      }
    },
  }
}

module.exports = { buildScheduledHandlers }
