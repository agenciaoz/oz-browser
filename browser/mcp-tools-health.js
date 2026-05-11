// OZ Browser — MCP tool catalog: anti-detect health (E2-C-6).
//
// Doc: docs/modules/anti-detect-health.md
//
// Exports: buildHealthTools({health}) — getter al handler map.

function buildHealthTools({ health }) {
  return [
    {
      name: 'oz.health.get',
      description:
        'C-6 — get the anti-detect health record for one identity. Returns { identityId, identityName, identityColor, evaluatedAt, overall: red|yellow|green, vectors: { ipTimezone, fingerprintCoherence, cookieHealth, proxyReachability } }. Each vector has { status, summary, details, fix? }. fix kinds: reroll-fingerprint, apply-geo-suggestion, reassign-proxy, test-proxy, mark-cookies-for-relogin.',
      inputSchema: {
        type: 'object',
        properties: { identityId: { type: 'string' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId }) => health().get(identityId),
    },
    {
      name: 'oz.health.list',
      description:
        'C-6 — anti-detect health records for ALL identities. Cookies are fetched in parallel. Useful for daily audit / dashboard view across 30+ accounts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => health().list(),
    },
    {
      name: 'oz.health.applyFix',
      description:
        'C-6 — apply an inline fix to a vector. kind is one of: reroll-fingerprint, apply-geo-suggestion (proxy.country → fingerprint timezone), reassign-proxy (auto-random switch), test-proxy (run connectivity probe now), mark-cookies-for-relogin (flag accounts via AntiLogout). Returns { ok, kind, result } or { ok:false, reason }.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'reroll-fingerprint',
              'apply-geo-suggestion',
              'reassign-proxy',
              'test-proxy',
              'mark-cookies-for-relogin',
            ],
          },
          vector: { type: 'string' },
        },
        required: ['identityId', 'kind'],
        additionalProperties: false,
      },
      call: (opts) => health().applyFix(opts || {}),
    },
  ]
}

module.exports = { buildHealthTools }
