// OZ Browser — Team IPC handler map (Bloque E-6).
//
// Mismo patrón que backup-handlers / cloud-backup-handlers. Wire del IPC en
// ipc-handlers-extra.js#registerTeamHandlersIPC.
//
// Doc: docs/modules/team-handlers.md
// ADR: docs/architecture/0027-team-mode.md

const log = require('./logger')

function _err(code, message, extra = {}) {
  return { __error: { code, message, ...extra } }
}

function buildTeamHandlers(browser) {
  function requireVaultUnlocked() {
    const v = browser.accountVault
    if (!v || !v.isUnlocked) return null
    return v
  }
  function tm() {
    return browser.teamManager
  }
  function notConfigured() {
    return {
      role: 'standalone',
      notConfigured: true,
    }
  }

  return {
    status() {
      if (!tm()) return notConfigured()
      try {
        return tm().getStatus()
      } catch (err) {
        return _err('STATUS_FAILED', err.message)
      }
    },

    async createTeam() {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      if (!requireVaultUnlocked()) return _err('LOCKED', 'Vault is locked')
      try {
        const r = await tm().createTeam()
        browser.broadcastToWebUI('oz:team:changed')
        return { ok: true, ...r }
      } catch (err) {
        log.error('team-handlers', 'createTeam failed', { message: err.message })
        return _err(err.code || 'CREATE_TEAM_FAILED', err.message)
      }
    },

    generateInvite(opts = {}) {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      try {
        return tm().generateInvite(opts)
      } catch (err) {
        return _err(err.code || 'GENERATE_INVITE_FAILED', err.message)
      }
    },

    async acceptInvite({ tokenOrUrl, pollTimeoutMs } = {}) {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      if (!requireVaultUnlocked()) return _err('LOCKED', 'Vault is locked')
      if (!tokenOrUrl) return _err('BAD_ARG', 'tokenOrUrl required')
      try {
        const r = await tm().acceptInvite(tokenOrUrl, { pollTimeoutMs })
        // After acceptInvite the masterKey has been replaced — lock the vault
        // so the user is forced to re-unlock with the new state. This also
        // surfaces the new role in the UI on re-unlock.
        if (browser.accountVault && browser.accountVault.isUnlocked) {
          browser.accountVault.lock()
        }
        browser.broadcastToWebUI('oz:vault:changed')
        browser.broadcastToWebUI('oz:team:changed')
        browser.broadcastToWebUI('oz:team:joined', {
          teamId: r.teamId,
          preJoinSnapshotId: r.preJoinSnapshotId,
        })
        return { ok: true, ...r, requiresRestart: true }
      } catch (err) {
        log.error('team-handlers', 'acceptInvite failed', {
          message: err.message,
          code: err.code,
        })
        return _err(err.code || 'ACCEPT_INVITE_FAILED', err.message)
      }
    },

    async leaveTeam() {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      try {
        const r = await tm().leaveTeam()
        browser.broadcastToWebUI('oz:team:changed')
        return r
      } catch (err) {
        return _err(err.code || 'LEAVE_TEAM_FAILED', err.message)
      }
    },

    async disbandTeam() {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      try {
        const r = await tm().disbandTeam()
        browser.broadcastToWebUI('oz:team:changed')
        return r
      } catch (err) {
        return _err(err.code || 'DISBAND_TEAM_FAILED', err.message)
      }
    },

    async listMembers() {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      try {
        return await tm().listMembers()
      } catch (err) {
        return _err(err.code || 'LIST_MEMBERS_FAILED', err.message)
      }
    },

    async removeMember(memberId) {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      if (!memberId) return _err('BAD_ARG', 'memberId required')
      try {
        const r = await tm().removeMember(memberId)
        browser.broadcastToWebUI('oz:team:changed')
        return r
      } catch (err) {
        return _err(err.code || 'REMOVE_MEMBER_FAILED', err.message)
      }
    },

    /**
     * Manually trigger the owner-side wrap-key daemon. Normally runs on a
     * timer (see team-setup.js) but UI exposes a "Refresh" button.
     */
    async wrapKeyForPendingMembers() {
      if (!tm()) return _err('NOT_CONFIGURED', 'Team mode not initialized')
      try {
        return await tm().wrapKeyForPendingMembers()
      } catch (err) {
        return _err(err.code || 'WRAP_KEY_FAILED', err.message)
      }
    },
  }
}

module.exports = { buildTeamHandlers }
