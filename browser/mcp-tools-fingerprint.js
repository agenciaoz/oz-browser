// OZ Browser — MCP tool catalog: fingerprint (1.9).
//
// Doc: docs/modules/mcp-tools-fingerprint.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Exports: buildFingerprintTools({fingerprint}) — getter al handler map.

const { listCountries } = require('./country-locale')

function buildFingerprintTools({ fingerprint }) {
  return [
    {
      name: 'oz.fingerprint.get',
      description:
        'Get the fingerprint profile for an identity (creating it if missing). Returns the full profile (UA, platform, screen, hardware, languages, timezone, plugins, battery, speech voices, canvasNoiseSeed, webgl vendor/renderer).',
      inputSchema: {
        type: 'object',
        properties: { identityId: { type: 'string' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId }) => fingerprint().get(identityId),
    },
    {
      name: 'oz.fingerprint.regenerate',
      description:
        'Force-regenerate the fingerprint for an identity. Optional newSeed; if absent, mints a random one. After regenerate, reload tabs of this identity to apply.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          newSeed: { type: 'string' },
        },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId, newSeed }) => fingerprint().regenerate(identityId, newSeed),
    },
    {
      name: 'oz.fingerprint.applyGeoSuggestion',
      description:
        'Apply a GeoIP-derived suggestion to an identity\'s fingerprint. Two ways to call: (a) {country: "JP"} — resolved via the country-locale table; (b) {timezone, languages, locale} — applied verbatim. Mutates ONLY the locale fields; UA/screen/blueprint stay constant. Returns updated profile or {__error}.',
      inputSchema: {
        type: 'object',
        properties: {
          identityId: { type: 'string' },
          suggestion: {
            type: 'object',
            properties: {
              country: { type: 'string' },
              timezone: { type: 'string' },
              languages: { type: 'array', items: { type: 'string' } },
              locale: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        required: ['identityId', 'suggestion'],
        additionalProperties: false,
      },
      call: ({ identityId, suggestion }) =>
        fingerprint().applyGeoSuggestion(identityId, suggestion),
    },
    {
      name: 'oz.fingerprint.resolveCountry',
      description:
        'Resolve an ISO 3166-1 alpha-2 country code into a locale profile (timezone, languages, locale). Pure function (no mutation). Returns null for unknown codes.',
      inputSchema: {
        type: 'object',
        properties: { countryCode: { type: 'string' } },
        required: ['countryCode'],
        additionalProperties: false,
      },
      call: ({ countryCode }) => fingerprint().resolveCountry(countryCode),
    },
    {
      name: 'oz.fingerprint.listCountries',
      description: 'List all country codes supported by the country-locale table.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: () => listCountries(),
    },
    {
      name: 'oz.fingerprint.remove',
      description:
        'Remove the cached fingerprint for an identity (called automatically when the identity is deleted, exposed for testing / regeneration flows).',
      inputSchema: {
        type: 'object',
        properties: { identityId: { type: 'string' } },
        required: ['identityId'],
        additionalProperties: false,
      },
      call: ({ identityId }) => fingerprint().remove(identityId),
    },
  ]
}

module.exports = { buildFingerprintTools }
