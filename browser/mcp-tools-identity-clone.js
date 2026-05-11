// OZ Browser — MCP tool catalog: identity clone (E2-C-3).
//
// Doc: docs/modules/mcp-tools-identity-clone.md
// ADR: ninguna (orquestación sobre primitivas existentes).
//
// Exports: buildIdentityCloneTools({identities}) — getter al handler map.
// Splitted from mcp-tools.js per ADR 0005 (max 500 LOC).

function buildIdentityCloneTools({ identities }) {
  return [
    {
      name: 'oz.identities.clone',
      description:
        "C-3 — clone an identity, optionally inheriting fingerprint, proxy and/or User-Agent. Defaults: NO inheritance (fresh fingerprint seed, no proxy carry-over, no UA copy). Set sameFingerprint=true to make the new identity match the parent's blueprint/UA/screen/timezone (use case: sub-accounts of the same 'person'). Set sameProxy=true to inherit the parent's proxy assignment. Set sameUA=true to copy the userAgent override. The new identity inherits color + workspaceId from the parent. Returns { ok, identity, inherited } or { ok:false, reason } where reason can be: not-found, IDENTITY_CAP_REACHED, no-identity-manager, create-failed.",
      inputSchema: {
        type: 'object',
        properties: {
          srcId: { type: 'string', description: 'Source identity id to clone.' },
          opts: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Explicit new name. If omitted, auto-generated as "X (copy)" or "X (copy 2)".',
              },
              sameFingerprint: { type: 'boolean' },
              sameProxy: { type: 'boolean' },
              sameUA: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        required: ['srcId'],
        additionalProperties: false,
      },
      call: ({ srcId, opts }) => identities().clone(srcId, opts || {}),
    },
    {
      name: 'oz.identities.previewCloneName',
      description:
        'C-3 — preview the auto-generated "X (copy)" / "X (copy N)" name without actually cloning. Returns a string. Used by the UI to populate the default name input field in the Clone Identity modal.',
      inputSchema: {
        type: 'object',
        properties: { srcName: { type: 'string' } },
        required: ['srcName'],
        additionalProperties: false,
      },
      call: ({ srcName }) => identities().previewCloneName(srcName),
    },
  ]
}

module.exports = { buildIdentityCloneTools }
