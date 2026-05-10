// OZ Browser — MCP tool catalog: vault + accounts domain (1.5b).
//
// Doc: docs/modules/mcp-tools.md (parent), docs/modules/account-vault.md
// ADR: docs/architecture/0008-account-vault-encryption.md
//
// Extraído de mcp-tools.js para mantener cada archivo <500 LOC (ADR 0005).
// El catálogo principal lo importa y lo concatena a su array de tools.

/**
 * Build vault + accounts MCP tool descriptors.
 * @param {object} deps - { vault, accounts } — getter functions returning the
 *   handler maps (browser.handlers.vault / browser.handlers.accounts). Wrapping
 *   in functions defers the dereferencing so the catalog can be built before
 *   the handler maps are wired (init order tolerance).
 */
function buildVaultAccountsTools({ vault, accounts }) {
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
  ]
}

module.exports = { buildVaultAccountsTools }
