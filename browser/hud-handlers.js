// OZ Browser — Identity HUD handlers (K1-extras / v1.4.3).
//
// Qué hace: backend para el in-page HUD widget que muestra
//   identity name+color + workspace + proxy country/flag + IP last octets +
//   session health pill
// arriba-derecha en cada tab. Inyectado via shadow DOM por `preload-hud.js`.
//
// Doc: docs/modules/hud-handlers.md (TODO al cerrar)
// Storage: ~/Library/Application Support/<appName>/hud-state.json
//   { collapsedByIdentity: { identityId: boolean } }
//
// Handlers (consumibles desde IPC):
//   getContextForSession(senderSession, identityIdArg?) → context blob para
//     el tab del sender. Resuelve la identity via session (anti-spoof, mismo
//     pattern que fingerprint + auto-fill). identityIdArg es fallback para
//     callers que no tienen session (MCP/tests).
//   getContext(identityId)               → context blob explícito.
//   getCollapsed(identityId)             → boolean.
//   setCollapsed(identityId, collapsed)  → boolean (persiste a disco).
//
// Notes sobre session health:
//   - Sin accountVault         → 'unknown'  (gray)
//   - Vault locked             → 'locked'   (gray)
//   - Identity sin accounts    → 'green'    (no hay nada que monitorear)
//   - Alguna account marcada needs_relogin → 'needs_relogin' (red)
//   - Else                     → 'green'
//
// El status 'amber' está reservado pero no se emite todavía (cuando agreguemos
// "cookie expira en <24h" en un sub-bloque futuro, esa será amber).

const fs = require('fs')
const path = require('path')
const log = require('./logger')

function buildHudHandlers(browser, opts = {}) {
  // dataDir es inyectable para tests. En producción viene de electron.app.
  const dataDir =
    opts.dataDir || (opts.app && opts.app.getPath && opts.app.getPath('userData')) || null
  const stateFile = dataDir ? path.join(dataDir, 'hud-state.json') : null

  let state = { collapsedByIdentity: {} }

  function _load() {
    if (!stateFile) return
    try {
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf-8')
        const parsed = JSON.parse(raw)
        if (
          parsed &&
          parsed.collapsedByIdentity &&
          typeof parsed.collapsedByIdentity === 'object'
        ) {
          state = { collapsedByIdentity: { ...parsed.collapsedByIdentity } }
        }
      }
    } catch (err) {
      log.warn('hud-handlers', 'failed to load hud-state.json', { message: err.message })
    }
  }

  function _save() {
    if (!stateFile) return
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      log.warn('hud-handlers', 'failed to save hud-state.json', { message: err.message })
    }
  }

  _load()

  function resolveIdentityFromSession(senderSession) {
    const im = browser.identityManager
    if (!im || !senderSession || typeof im.identityIdForSession !== 'function')
      return null
    try {
      return im.identityIdForSession(senderSession)
    } catch (_err) {
      return null
    }
  }

  function _sessionStatus(identityId) {
    const vault = browser.accountVault
    if (!vault) return { status: 'unknown' }
    if (vault.isUnlocked === false || vault.isUnlocked === undefined) {
      // Defensive: undefined could mean uninitialized; treat as locked.
      if (vault.isUnlocked === false) return { status: 'locked' }
      if (typeof vault.list !== 'function') return { status: 'unknown' }
    }
    if (typeof vault.list !== 'function') return { status: 'unknown' }
    try {
      const accounts = vault.list({ identityId }) || []
      const flagged = accounts.find((a) => a && a.status === 'needs_relogin')
      if (flagged) return { status: 'needs_relogin' }
      return { status: 'green' }
    } catch (_err) {
      return { status: 'unknown' }
    }
  }

  function buildContextBlob(identityId) {
    const empty = { identity: null, workspace: null, proxy: null, session: null }
    if (!identityId) return empty
    const im = browser.identityManager
    const wm = browser.workspaceManager
    const pa = browser.proxyAssignment
    if (!im || typeof im.get !== 'function') return empty
    const ident = im.get(identityId)
    if (!ident) return empty

    let workspace = null
    if (wm && typeof wm.get === 'function' && ident.workspaceId) {
      const ws = wm.get(ident.workspaceId)
      if (ws) {
        workspace = { id: ws.id, name: ws.name, color: ws.color || null }
      }
    }

    let proxy = null
    if (pa && typeof pa.resolve === 'function') {
      try {
        const resolved = pa.resolve({ identityId, workspaceId: ident.workspaceId })
        if (resolved) {
          proxy = {
            id: resolved.id,
            country: resolved.country || null,
            host: resolved.host || null,
            port: typeof resolved.port === 'number' ? resolved.port : null,
            protocol: resolved.protocol || null,
            healthy: !resolved.isDisabled,
          }
        }
      } catch (_err) {
        // best-effort — proxy block stays null
      }
    }

    return {
      identity: {
        id: ident.id,
        name: ident.name,
        color: ident.color || null,
        isDefault: !!ident.isDefault,
      },
      workspace,
      proxy,
      session: _sessionStatus(identityId),
    }
  }

  return {
    getContextForSession(senderSession, identityIdArg) {
      const identityId =
        resolveIdentityFromSession(senderSession) || identityIdArg || null
      return buildContextBlob(identityId)
    },

    getContext(identityId) {
      return buildContextBlob(identityId)
    },

    getCollapsed(identityId) {
      if (!identityId) return false
      return !!state.collapsedByIdentity[identityId]
    },

    setCollapsed(identityId, collapsed) {
      if (!identityId) return false
      const value = !!collapsed
      const prev = !!state.collapsedByIdentity[identityId]
      if (value === prev) return value
      if (value) {
        state.collapsedByIdentity[identityId] = true
      } else {
        delete state.collapsedByIdentity[identityId]
      }
      _save()
      return value
    },

    // Internal accessor for tests.
    _getState() {
      return state
    },

    // Internal accessor for tests — bypasses session resolution.
    _buildContextBlob(identityId) {
      return buildContextBlob(identityId)
    },
  }
}

module.exports = { buildHudHandlers }
