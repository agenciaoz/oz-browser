// OZ Browser — Team setup (Bloque E-8).
//
// Doc: docs/modules/team-setup.md
// Bloque: E-8
//
// Extraído de main.js por ADR 0005 (LOC budget). Encapsula:
//   - Instanciación de teamIdentity + teamManager
//   - Registro del protocol dispatcher `oz://team/invite`
//   - Daemon owner-side que wrappea keys para members pending (cada 60s)
//
// Idempotente. Si dropboxClient/cloudBackupManager no están configurados
// (OZ_DROPBOX_APP_KEY missing), team mode queda en estado `notConfigured`
// pero la app no crashea — los handlers IPC devuelven el estado.

const log = require('./logger')
const { createTeamIdentity } = require('./team-identity')
const { createTeamManager } = require('./team-manager')
const { registerProtocolDispatch } = require('./protocol-handler')
const { app } = require('electron')

const DAEMON_INTERVAL_MS = 60_000 // 60s

/**
 * Wires Team mode into a Browser instance. Returns metadata flag.
 *
 * Pre-conditions on the browser instance:
 *   - browser.accountVault exists (instantiated in main.js)
 *   - browser.backupManager exists
 *   - browser.dropboxClient may exist (cloud-backup-setup ran first); if not,
 *     teamManager is left null (NOT_CONFIGURED state via handler).
 */
function setupTeamMode(browser) {
  browser.teamIdentity = createTeamIdentity({ userDataDir: app.getPath('userData') })
  // Defer ensureIdentity to the moment team mode is actually used — no need
  // to materialize the keypair for standalone users that never invoke team.

  if (!browser.dropboxClient) {
    log.warn('team-setup', 'dropboxClient missing — team mode disabled')
    browser.teamManager = null
    return { teamMode: false, reason: 'no-dropbox-client' }
  }

  browser.teamManager = createTeamManager({
    userDataDir: app.getPath('userData'),
    vault: browser.accountVault,
    backupManager: browser.backupManager,
    teamIdentity: browser.teamIdentity,
    dropboxClient: browser.dropboxClient,
  })

  // Protocol dispatcher: oz://team/invite?token=... → broadcast to renderer
  // so the Team modal can auto-open + pre-fill the input. UX: user sees the
  // confirm modal + decides; we never accept silently from a deep link.
  registerProtocolDispatch(browser, 'team/invite', (_b, parsed) => {
    const token = parsed.query.token
    if (!token) {
      log.warn('team-setup', 'team/invite missing token', {
        queryKeys: Object.keys(parsed.query),
      })
      return
    }
    log.info('team-setup', 'team invite received via protocol handler')
    browser.broadcastToWebUI('oz:team:invite-received', { token })
  })

  // Owner-side daemon: wrap masterKey for any member.pub that doesn't yet
  // have a wrapped-key file. Runs every DAEMON_INTERVAL_MS; cheap when
  // there's nothing to wrap. Stops when role !== 'owner' or vault locked.
  const daemonId = setInterval(() => {
    if (!browser.teamManager) return
    const s = browser.teamManager.getStatus()
    if (s.role !== 'owner') return
    if (!browser.accountVault || !browser.accountVault.isUnlocked) return
    browser.teamManager
      .wrapKeyForPendingMembers()
      .then((r) => {
        if (r && r.wrapped > 0) {
          log.info('team-setup', 'daemon wrapped keys for new members', {
            count: r.wrapped,
          })
          browser.broadcastToWebUI('oz:team:changed')
        }
      })
      .catch((err) => {
        log.warn('team-setup', 'daemon wrap-key failed (will retry)', {
          message: err.message,
        })
      })
  }, DAEMON_INTERVAL_MS)
  // Ensure the timer doesn't block app quit.
  if (daemonId.unref) daemonId.unref()

  log.info('team-setup', 'team mode initialized', {
    role: browser.teamManager.getStatus().role,
  })
  return { teamMode: true }
}

module.exports = { setupTeamMode, DAEMON_INTERVAL_MS }
