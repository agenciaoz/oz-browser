// OZ Browser — MCP tool catalog: vault + accounts domain (1.5b).
//
// Doc: docs/modules/mcp-tools.md (parent), docs/modules/account-vault.md
// ADR: docs/architecture/0008-account-vault-encryption.md
//
// Extraído de mcp-tools.js para mantener cada archivo <500 LOC (ADR 0005).
// El catálogo principal lo importa y lo concatena a su array de tools.

/**
 * Build vault + accounts + excel MCP tool descriptors.
 * @param {object} deps - { vault, accounts, excel } — getter functions returning
 *   the handler maps. Wrapping in functions defers the dereferencing so the
 *   catalog can be built before the handler maps are wired (init order tolerance).
 */
function buildVaultAccountsTools({ vault, accounts, excel, timemachine }) {
  return [
    // -------------------- vault (1.5b — secrets gate) --------------------
    {
      name: 'oz.vault.status',
      description:
        'Vault status snapshot. Safe to call always (no unlock required). Returns {exists, isUnlocked, accountsCount}. accountsCount is null when locked (metadata not exposed).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => vault().status(),
    },
    {
      name: 'oz.vault.unlock',
      description:
        'Unlock the account vault by reading the master key from macOS Keychain. First call ever auto-generates the key + creates an empty vault. Returns {ok:true, isUnlocked:true} or {__error:{code, message}}. Required before any oz.accounts.* call.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => vault().unlock(),
    },
    {
      name: 'oz.vault.lock',
      description:
        'Lock the vault — wipe master key and accounts from RAM. Subsequent oz.accounts.* calls return LOCKED until oz.vault.unlock is called again.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => vault().lock(),
    },
    {
      name: 'oz.vault.destroy',
      description:
        'DESTRUCTIVE. Delete the vault file AND remove the master key from Keychain. Next oz.vault.unlock will be a fresh first-time setup with a brand-new key — old encrypted data unrecoverable. Use only from Settings → Reset Vault with explicit user double-confirm.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => vault().destroy(),
    },

    // -------------------- accounts (1.5b — secrets-gated CRUD) --------------------
    {
      name: 'oz.accounts.list',
      description:
        'List accounts (passwords + 2FA secrets in plaintext). Optional filter: {identityId?, workspaceId?, site?, status?}. Requires vault unlocked — returns {__error:{code:"LOCKED"}} otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            properties: {
              identityId: { type: 'string' },
              workspaceId: { type: 'string' },
              site: { type: 'string' },
              status: { type: 'string', enum: ['active', 'inactive', 'needs_relogin'] },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      call: ({ filter } = {}) => accounts().list(filter || {}),
    },
    {
      name: 'oz.accounts.get',
      description:
        'Get a single account by id. Returns the account or null. Requires vault unlocked.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => accounts().get(id),
    },
    {
      name: 'oz.accounts.create',
      description:
        'Create a new account. Required: identityId, site, username, password. Optional: workspaceId, totpSecret, cookies, lastLoginAt, lastIp, status, notes, customFields. Returns the new account or {__error}.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          workspaceId: { type: 'string' },
          site: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          totpSecret: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string', enum: ['active', 'inactive', 'needs_relogin'] },
          customFields: { type: 'object' },
        },
        required: ['identityId', 'site', 'username', 'password'],
        additionalProperties: true,
      },
      call: (opts = {}) => accounts().create(opts),
    },
    {
      name: 'oz.accounts.update',
      description:
        'Update fields of an account by id. Whitelisted: identityId, workspaceId, site, username, password, totpSecret, cookies, lastLoginAt, lastIp, status, notes, customFields. Returns updated account or null.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          patch: { type: 'object' },
        },
        required: ['id', 'patch'],
        additionalProperties: false,
      },
      call: ({ id, patch }) => accounts().update(id, patch),
    },
    {
      name: 'oz.accounts.remove',
      description: 'Delete an account by id. Returns true/false.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => accounts().remove(id),
    },
    {
      name: 'oz.accounts.setAll',
      description:
        'Bulk replace ALL accounts. Used by Excel OVERWRITE TOTAL import (1.5e). Caller must snapshot Time Machine first if data loss is undesirable. Returns {ok, count}.',
      inputSchema: {
        type: 'object',
        properties: { accounts: { type: 'array' } },
        required: ['accounts'],
        additionalProperties: false,
      },
      call: ({ accounts: arr }) => accounts().setAll(arr),
    },
    {
      name: 'oz.accounts.getCredentialsForSite',
      description:
        'Auto-fill primitive (1.5c). Returns {accountId, username, password, totpSecret} for the given site canonical id and identityId. Picks most recent if multiple. Returns null if no match. Vault-gated.',
      inputSchema: {
        type: 'object',
        properties: {
          site: { type: 'string', description: 'canonical site id (e.g. "x.com")' },
          identityId: { type: 'string' },
        },
        required: ['site', 'identityId'],
        additionalProperties: false,
      },
      call: ({ site, identityId }) => accounts().getCredentialsForSite(site, identityId),
    },
    {
      name: 'oz.accounts.proposeAutoSave',
      description:
        'Auto-save primitive (1.5c). Called by content script when login form is submitted. Broadcasts oz:autofill:propose-save to UI which shows dialog. Returns {ok, action: "create"|"update", existingAccountId?}.',
      inputSchema: {
        type: 'object',
        properties: {
          site: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          identityId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
        required: ['site', 'username', 'password', 'identityId'],
        additionalProperties: false,
      },
      call: (opts = {}) => accounts().proposeAutoSave(opts),
    },

    // -------------------- excel I/O (1.5e) --------------------
    {
      name: 'oz.excel.exportToFile',
      description:
        'Export all vault accounts to .xlsx file. Columns: Workspace, Identity, Site, Username, Password, 2FA Secret, Last Login, Status, Cookies Count, Last IP, Notes. Vault-gated. Returns {ok, filePath, rows}.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to .xlsx output' },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
      call: ({ filePath }) => excel().exportToFile(filePath),
    },
    {
      name: 'oz.excel.importFromFile',
      description:
        'Import accounts from .xlsx with mode selection. Modes: PERMANENT_MERGE (update by identity+site+username, add rest), EPHEMERAL_SESSION (parse only, no persist — caller handles in-memory), NEW_WORKSPACE (creates dedicated workspace, all rows go there), OVERWRITE_TOTAL (REPLACE entire vault — caller MUST snapshot Time Machine first). Bulk identity/workspace creation: missing names get auto-created. Returns {ok, mode, importedCount, identitiesCreated, workspacesCreated, ...}.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          mode: {
            type: 'string',
            enum: [
              'PERMANENT_MERGE',
              'EPHEMERAL_SESSION',
              'NEW_WORKSPACE',
              'OVERWRITE_TOTAL',
            ],
          },
        },
        required: ['filePath', 'mode'],
        additionalProperties: false,
      },
      call: ({ filePath, mode }) => excel().importFromFile(filePath, mode),
    },

    // -------------------- time machine (1.6) --------------------
    {
      name: 'oz.timemachine.create',
      description:
        'Create a Time Machine snapshot. Vault must be unlocked (snapshots are encrypted with the master key). Reasons: manual / pre-quit / pre-overwrite-total / daily-3am / pre-restore. Returns {ok, id, header}.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Human-readable label' },
          reason: {
            type: 'string',
            enum: [
              'manual',
              'pre-quit',
              'pre-overwrite-total',
              'daily-3am',
              'pre-restore',
            ],
          },
        },
        additionalProperties: false,
      },
      call: (opts = {}) => timemachine().create(opts),
    },
    {
      name: 'oz.timemachine.list',
      description:
        'List all snapshot metadata, newest first. Cheap (no decrypt — only reads headers). Returns array of {id, label, reason, createdAt, sizeBytes, fileCount, ...}.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => timemachine().list(),
    },
    {
      name: 'oz.timemachine.restore',
      description:
        'Restore a snapshot by id. Vault must be unlocked. ALWAYS auto-creates a pre-restore snapshot first (rollback path). After restore, vault is locked + an event fires; UI must instruct user to restart the app for identities/workspaces to reload from disk. Returns {ok, restoredCount, preRestoreId, requiresRestart}.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => timemachine().restore(id),
    },
    {
      name: 'oz.timemachine.remove',
      description: 'Permanently delete a snapshot file. Returns {ok, deleted: bool}.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: ({ id }) => timemachine().remove(id),
    },
    {
      name: 'oz.timemachine.applyRetention',
      description:
        'Run the retention policy now: keep all snapshots from the last N days (default 30) + 1 per ISO week forever for older. Returns {ok, deletedCount, deletedIds}.',
      inputSchema: {
        type: 'object',
        properties: {
          keepDailyDays: { type: 'integer', minimum: 1, maximum: 365 },
        },
        additionalProperties: false,
      },
      call: (opts = {}) => timemachine().applyRetention(opts),
    },
  ]
}

module.exports = { buildVaultAccountsTools }
