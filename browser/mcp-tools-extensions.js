// OZ Browser — MCP tool catalog: extensions per-identity (E2-C-7).
//
// Doc: docs/modules/extensions-share.md
//
// Exports: buildExtensionTools({ extensions }) — getter al handler map.

function buildExtensionTools({ extensions }) {
  return [
    {
      name: 'oz.extensions.listInstalled',
      description:
        'C-7 — list all Chrome extensions installed in the Default identity. Each entry includes { id, name, version, description, path, manifestVersion }. Excludes the internal WebUI extension.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => extensions().listInstalled(),
    },
    {
      name: 'oz.extensions.listEnabled',
      description:
        'C-7 — list extension IDs enabled for a given identity. For Default identity, returns all installed (Default = always-enabled). For custom identities, returns only the ones explicitly shared.',
      inputSchema: {
        type: 'object',
        properties: { identityId: { type: 'string' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId }) => extensions().listEnabled(identityId),
    },
    {
      name: 'oz.extensions.report',
      description:
        'C-7 — per-identity report: every Default-installed extension + whether enabled for the given identity. Each row { id, name, version, enabledForIdentity, isDefault }. Used by the UI manager modal.',
      inputSchema: {
        type: 'object',
        properties: { identityId: { type: 'string' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId }) => extensions().report(identityId),
    },
    {
      name: 'oz.extensions.enable',
      description:
        "C-7 — enable an extension for a given identity. Loads the extension into that identity's session via session.extensions.loadExtension(path). Returns { ok, alreadyEnabled?, extension? } or { ok:false, reason }.",
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          extensionId: { type: 'string' },
        },
        required: ['identityId', 'extensionId'],
        additionalProperties: false,
      },
      call: ({ identityId, extensionId }) => extensions().enable(identityId, extensionId),
    },
    {
      name: 'oz.extensions.disable',
      description:
        "C-7 — disable an extension for a given identity. Removes from that identity's session + persists. Default identity rejects (use Chrome native uninstall on Default instead).",
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          extensionId: { type: 'string' },
        },
        required: ['identityId', 'extensionId'],
        additionalProperties: false,
      },
      call: ({ identityId, extensionId }) =>
        extensions().disable(identityId, extensionId),
    },
  ]
}

module.exports = { buildExtensionTools }
