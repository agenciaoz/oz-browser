// OZ Browser — Fingerprint domain handlers (1.9e).
//
// Qué hace: handler map IPC↔MCP para FingerprintEngine + applyGeoSuggestion.
//
// Doc: docs/modules/fingerprint-handlers.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Exports: buildFingerprintHandlers(browser) -> Record<string, fn>

const log = require('./logger')
const { resolveCountry } = require('./country-locale')

function buildFingerprintHandlers(browser) {
  const fe = () => browser.fingerprintEngine

  return {
    /** Get the fingerprint profile for an identity (creating if missing). */
    get(identityId) {
      if (!fe()) return null
      const ident = browser.identityManager && browser.identityManager.get(identityId)
      if (!ident) return null
      return fe().getOrCreate(identityId, ident.fingerprintSeed)
    },

    /** Force-regenerate the fingerprint. Optional newSeed. */
    regenerate(identityId, newSeed) {
      if (!fe()) return null
      const ident = browser.identityManager && browser.identityManager.get(identityId)
      if (!ident) return null
      const profile = fe().regenerate(identityId, newSeed)
      browser.broadcastToWebUI('oz:fingerprint:changed', { identityId })
      log.info('fingerprint-handlers', 'regenerated', {
        identityId,
        blueprintId: profile.blueprintId,
      })
      return profile
    },

    /**
     * Apply a GeoIP-derived suggestion (country code or explicit
     * timezone/languages/locale). Returns the updated profile or null.
     *
     * Two ways to call:
     *   applyGeoSuggestion(id, { country: 'JP' })
     *     → resolved via country-locale table
     *   applyGeoSuggestion(id, { timezone, languages, locale })
     *     → applied verbatim
     */
    applyGeoSuggestion(identityId, suggestion = {}) {
      if (!fe()) return null
      let resolved = suggestion
      if (suggestion.country && !suggestion.timezone) {
        const r = resolveCountry(suggestion.country)
        if (!r) {
          log.warn('fingerprint-handlers', 'unknown country code', {
            country: suggestion.country,
          })
          return { __error: { code: 'UNKNOWN_COUNTRY', country: suggestion.country } }
        }
        resolved = r
      }
      const profile = fe().applyGeoSuggestion(identityId, resolved)
      if (!profile) {
        return {
          __error: { code: 'IDENTITY_NOT_FOUND', identityId },
        }
      }
      browser.broadcastToWebUI('oz:fingerprint:changed', { identityId })
      return profile
    },

    /**
     * Resolve a country code into a suggestion object (no mutation). Used
     * by the proxy-handlers when surfacing suggestions on assignToIdentity.
     */
    resolveCountry(countryCode) {
      return resolveCountry(countryCode)
    },

    /** Remove cached fingerprint (called on identity removal). */
    remove(identityId) {
      if (!fe()) return false
      const ok = fe().remove(identityId)
      if (ok) browser.broadcastToWebUI('oz:fingerprint:changed', { identityId })
      return ok
    },
  }
}

module.exports = { buildFingerprintHandlers }
