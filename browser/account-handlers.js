// OZ Browser — Account + Vault domain handlers (pure map of name → fn).
//
// Doc: docs/modules/account-handlers.md
// ADR: docs/architecture/0008-account-vault-encryption.md
// Bloque: 1.5b
//
// Mismo patrón que identity-handlers.js / workspace-handlers.js / tab-handlers.js
// — consumido por IPC y MCP. Misma implementación, dos transports.
//
// Convención:
//   - Cada handler retorna lo mismo que el IPC devolvía (sin throw para errores
//     recuperables — devolvemos { __error: { code, message } } como hicimos en
//     identity-handlers.create con cap reached).
//   - vault.* operan sobre el Vault directamente.
//   - accounts.* requieren vault unlocked. Si no lo está, devuelven
//     { __error: { code: 'LOCKED', message: '...' } } sin throw.
//
// Modelo Account final:
//   {
//     id,             // uuid hex 16 chars
//     identityId,     // bind to identity
//     workspaceId,    // bind to workspace (puede ser null en EPHEMERAL)
//     site,           // 'x.com', 'instagram.com', etc.
//     username,
//     password,       // plaintext while vault unlocked
//     totpSecret,     // base32 si aplica
//     cookies,        // opcional, populated by anti-logout (1.5d)
//     lastLoginAt,    // timestamp ms
//     lastIp,         // last proxy IP seen
//     status,         // 'active' | 'inactive' | 'needs_relogin'
//     notes,
//     customFields,   // object libre
//     createdAt,
//     updatedAt,
//   }

const crypto = require('crypto')
const log = require('./logger')

const VALID_STATUSES = ['active', 'inactive', 'needs_relogin']
const ACCOUNT_PATCH_FIELDS = [
  'identityId',
  'workspaceId',
  'site',
  'username',
  'password',
  'totpSecret',
  'cookies',
  'lastLoginAt',
  'lastIp',
  'status',
  'notes',
  'customFields',
]

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

function lockedError(detail) {
  return {
    __error: {
      code: 'LOCKED',
      message: detail || 'Vault is locked — call oz.vault.unlock() first',
    },
  }
}

function buildVaultHandlers(browser) {
  const v = () => browser.accountVault

  return {
    /** Vault status snapshot — safe to call always (no unlock required). */
    status() {
      const vault = v()
      if (!vault) return { exists: false, isUnlocked: false }
      return {
        exists: true,
        isUnlocked: vault.isUnlocked,
        // accountsCount only revealed when unlocked (otherwise it's metadata
        // leak for any process that can call IPC without unlocking).
        accountsCount: vault.isUnlocked ? vault.getAccounts().length : null,
      }
    },

    async unlock() {
      const vault = v()
      if (!vault) {
        return {
          __error: { code: 'NO_VAULT', message: 'Vault not initialized in main process' },
        }
      }
      try {
        await vault.unlock()
        browser.broadcastToWebUI('oz:vault:changed')
        log.info('account-handlers', 'vault.unlock ok', {
          accountsCount: vault.getAccounts().length,
        })
        return { ok: true, isUnlocked: true }
      } catch (err) {
        log.error('account-handlers', 'vault.unlock failed', {
          code: err.code,
          message: err.message,
        })
        return { __error: { code: err.code || 'UNLOCK_FAILED', message: err.message } }
      }
    },

    lock() {
      const vault = v()
      if (!vault) return { ok: true, isUnlocked: false }
      vault.lock()
      browser.broadcastToWebUI('oz:vault:changed')
      log.info('account-handlers', 'vault.lock ok')
      return { ok: true, isUnlocked: false }
    },

    /**
     * Destroy the entire vault (file + Keychain key). DESTRUCTIVE — caller
     * must double-confirm in UI before calling. Used by Settings → Reset Vault.
     */
    destroy() {
      const vault = v()
      if (!vault) return { ok: true }
      vault.destroy()
      browser.broadcastToWebUI('oz:vault:changed')
      log.warn('account-handlers', 'vault.destroy executed (file + key removed)')
      return { ok: true }
    },
  }
}

function buildAccountHandlers(browser) {
  const v = () => browser.accountVault

  function requireUnlocked() {
    const vault = v()
    if (!vault || !vault.isUnlocked) return null
    return vault
  }

  return {
    /**
     * List accounts. Optional filter: { identityId?, workspaceId?, site?, status? }.
     * Passwords and totpSecrets are returned in plaintext (caller is renderer
     * via IPC — within the same Electron process, same trust boundary).
     */
    list(filter = {}) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      let accounts = vault.getAccounts()
      if (filter.identityId) {
        accounts = accounts.filter((a) => a.identityId === filter.identityId)
      }
      if (filter.workspaceId) {
        accounts = accounts.filter((a) => a.workspaceId === filter.workspaceId)
      }
      if (filter.site) {
        accounts = accounts.filter((a) => a.site === filter.site)
      }
      if (filter.status) {
        accounts = accounts.filter((a) => a.status === filter.status)
      }
      return accounts
    },

    get(id) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      return vault.getAccounts().find((a) => a.id === id) || null
    },

    /**
     * Create a new account. Requires identityId + site + username + password.
     * Other fields optional. Returns the new account or { __error }.
     */
    create(opts = {}) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()

      const { identityId, site, username, password } = opts
      if (!identityId || !site || !username || !password) {
        return {
          __error: {
            code: 'BAD_ARG',
            message: 'identityId, site, username, password are required',
          },
        }
      }

      const t = now()
      const account = {
        id: uuid(),
        identityId,
        workspaceId: opts.workspaceId || null,
        site,
        username,
        password,
        totpSecret: opts.totpSecret || null,
        cookies: opts.cookies || null,
        lastLoginAt: opts.lastLoginAt || null,
        lastIp: opts.lastIp || null,
        status: VALID_STATUSES.includes(opts.status) ? opts.status : 'active',
        notes: opts.notes || '',
        customFields: opts.customFields || {},
        createdAt: t,
        updatedAt: t,
      }
      const accounts = vault.getAccounts()
      accounts.push(account)
      vault.setAccounts(accounts)
      browser.broadcastToWebUI('oz:accounts:changed')
      log.info('account-handlers', 'account created', {
        id: account.id,
        site,
        identityId,
      })
      return account
    },

    /**
     * Update fields of an account. Whitelisted by ACCOUNT_PATCH_FIELDS.
     * Returns the updated account or null if id not found.
     */
    update(id, patch = {}) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()

      const accounts = vault.getAccounts()
      const idx = accounts.findIndex((a) => a.id === id)
      if (idx < 0) return null

      const before = { ...accounts[idx] }
      for (const key of ACCOUNT_PATCH_FIELDS) {
        if (Object.hasOwn(patch, key)) {
          if (key === 'status' && !VALID_STATUSES.includes(patch[key])) {
            log.warn('account-handlers', 'invalid status ignored', {
              id,
              requested: patch[key],
            })
            continue
          }
          accounts[idx][key] = patch[key]
        }
      }
      accounts[idx].updatedAt = now()
      vault.setAccounts(accounts)
      browser.broadcastToWebUI('oz:accounts:changed')
      log.info('account-handlers', 'account updated', {
        id,
        changedKeys: ACCOUNT_PATCH_FIELDS.filter(
          (k) => Object.hasOwn(patch, k) && before[k] !== accounts[idx][k],
        ),
      })
      return accounts[idx]
    },

    remove(id) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()

      const accounts = vault.getAccounts()
      const before = accounts.length
      const filtered = accounts.filter((a) => a.id !== id)
      if (filtered.length === before) return false
      vault.setAccounts(filtered)
      browser.broadcastToWebUI('oz:accounts:changed')
      log.info('account-handlers', 'account removed', { id })
      return true
    },

    /**
     * Auto-fill primitive (1.5c). Returns the credentials needed to fill a
     * login page given the site canonical id and the active identity. Picks
     * the first matching account (most recent if multiple, by lastLoginAt
     * desc). Returns null if no account matches.
     *
     * Output shape:
     *   { username, password, totpSecret, accountId } or null
     *
     * The content script preload (preload-content.js) calls this via IPC
     * when a known login page is detected. Vault gate applies — returns
     * { __error: { code: 'LOCKED' } } if vault is locked.
     */
    getCredentialsForSite(site, identityId) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      if (!site || !identityId) {
        return {
          __error: { code: 'BAD_ARG', message: 'site and identityId are required' },
        }
      }
      const matches = vault
        .getAccounts()
        .filter(
          (a) =>
            a.identityId === identityId && a.site === site && a.status !== 'inactive',
        )
        .sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0))
      if (matches.length === 0) return null
      const a = matches[0]
      return {
        accountId: a.id,
        username: a.username,
        password: a.password,
        totpSecret: a.totpSecret,
      }
    },

    /**
     * Auto-save primitive (1.5c). Called by content script when it detects a
     * form submit on a login page. Returns the proposal back to the caller —
     * the actual user-facing dialog ("Save credentials for Identity X?") is
     * handled by main.js (auto-save dialog). After user confirms, the dialog
     * calls accounts.create() directly.
     *
     * This handler is intentionally a no-op pass-through so the dialog logic
     * lives in one place (main.js / auto-save-dialog.js, 1.5c). We keep it
     * here so the IPC contract and MCP tool surface are uniform.
     */
    proposeAutoSave({ site, username, password, identityId, workspaceId } = {}) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      if (!site || !username || !password || !identityId) {
        return {
          __error: {
            code: 'BAD_ARG',
            message: 'site, username, password, identityId are required',
          },
        }
      }
      // Check if an account for the same (identityId, site, username) already
      // exists — if so, propose UPDATE instead of CREATE.
      const existing = vault
        .getAccounts()
        .find(
          (a) =>
            a.identityId === identityId && a.site === site && a.username === username,
        )
      log.info('account-handlers', 'proposeAutoSave', {
        site,
        identityId,
        existingId: existing && existing.id,
        action: existing ? 'update' : 'create',
      })
      browser.broadcastToWebUI('oz:autofill:propose-save', {
        site,
        username,
        identityId,
        workspaceId: workspaceId || null,
        existingAccountId: existing ? existing.id : null,
        action: existing ? 'update' : 'create',
      })
      return {
        ok: true,
        action: existing ? 'update' : 'create',
        existingAccountId: existing ? existing.id : null,
      }
    },

    /**
     * Bulk replace — used by Excel import (1.5e). Replaces all accounts.
     * Caller is responsible for snapshot to Time Machine before calling
     * if invoked in OVERWRITE TOTAL mode.
     */
    setAll(accounts) {
      const vault = requireUnlocked()
      if (!vault) return lockedError()
      if (!Array.isArray(accounts)) {
        return { __error: { code: 'BAD_ARG', message: 'accounts must be an array' } }
      }
      vault.setAccounts(accounts)
      browser.broadcastToWebUI('oz:accounts:changed')
      log.info('account-handlers', 'accounts bulk replace', { count: accounts.length })
      return { ok: true, count: accounts.length }
    },
  }
}

module.exports = {
  buildVaultHandlers,
  buildAccountHandlers,
  VALID_STATUSES,
  ACCOUNT_PATCH_FIELDS,
}
