// OZ Browser — Country code → {timezone, languages, locale} table (1.9d).
//
// Qué hace: mapeo puro country → locale profile, usado para sugerir
// fingerprint coherence cuando un proxy con `country` conocido se asigna a
// una identity.
//
// Por qué tabla pura vs GeoIP fetch real:
//   - Oxylabs templates ya generan proxies con country (1.8d).
//   - Usuario que crea proxy manual setea country en el form.
//   - Free tier de ipapi.co (1000 req/day) se llena rápido con 50 proxies *
//     48 tests/day. Cache + refresh complica.
//   - GeoIP fetch real requiere routing a través del proxy (chicken-and-egg
//     con sessions) o dep externa como https-proxy-agent (queremos cero
//     deps nuevas).
//   - V1: tabla cubre 80% del caso real. Auto-detect via ipapi.co llega
//     como mejora en 1.10 (cuando ya hay sync infra para batch fetch).
//
// Doc: docs/modules/country-locale.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Exports:
//   COUNTRY_LOCALES — tabla
//   resolveCountry(countryCode) → {country, timezone, languages, locale} | null

// Capital city timezone + most common business language(s) per country.
// Conservative: when in doubt, prefer English as secondary.
const COUNTRY_LOCALES = {
  US: { timezone: 'America/New_York', languages: ['en-US', 'en'], locale: 'en-US' },
  CA: {
    timezone: 'America/Toronto',
    languages: ['en-CA', 'en', 'fr-CA'],
    locale: 'en-CA',
  },
  MX: {
    timezone: 'America/Mexico_City',
    languages: ['es-MX', 'es', 'en'],
    locale: 'es-MX',
  },
  AR: {
    timezone: 'America/Argentina/Buenos_Aires',
    languages: ['es-AR', 'es', 'en'],
    locale: 'es-AR',
  },
  BR: {
    timezone: 'America/Sao_Paulo',
    languages: ['pt-BR', 'pt', 'en'],
    locale: 'pt-BR',
  },
  CL: { timezone: 'America/Santiago', languages: ['es-CL', 'es', 'en'], locale: 'es-CL' },
  CO: { timezone: 'America/Bogota', languages: ['es-CO', 'es', 'en'], locale: 'es-CO' },
  PE: { timezone: 'America/Lima', languages: ['es-PE', 'es', 'en'], locale: 'es-PE' },

  GB: { timezone: 'Europe/London', languages: ['en-GB', 'en'], locale: 'en-GB' },
  IE: { timezone: 'Europe/Dublin', languages: ['en-IE', 'en', 'ga'], locale: 'en-IE' },
  ES: { timezone: 'Europe/Madrid', languages: ['es-ES', 'es', 'en'], locale: 'es-ES' },
  FR: { timezone: 'Europe/Paris', languages: ['fr-FR', 'fr', 'en'], locale: 'fr-FR' },
  DE: { timezone: 'Europe/Berlin', languages: ['de-DE', 'de', 'en'], locale: 'de-DE' },
  IT: { timezone: 'Europe/Rome', languages: ['it-IT', 'it', 'en'], locale: 'it-IT' },
  NL: { timezone: 'Europe/Amsterdam', languages: ['nl-NL', 'nl', 'en'], locale: 'nl-NL' },
  BE: {
    timezone: 'Europe/Brussels',
    languages: ['nl-BE', 'fr-BE', 'en'],
    locale: 'nl-BE',
  },
  CH: { timezone: 'Europe/Zurich', languages: ['de-CH', 'fr-CH', 'en'], locale: 'de-CH' },
  AT: { timezone: 'Europe/Vienna', languages: ['de-AT', 'de', 'en'], locale: 'de-AT' },
  PT: { timezone: 'Europe/Lisbon', languages: ['pt-PT', 'pt', 'en'], locale: 'pt-PT' },
  PL: { timezone: 'Europe/Warsaw', languages: ['pl-PL', 'pl', 'en'], locale: 'pl-PL' },
  SE: { timezone: 'Europe/Stockholm', languages: ['sv-SE', 'sv', 'en'], locale: 'sv-SE' },
  NO: { timezone: 'Europe/Oslo', languages: ['nb-NO', 'no', 'en'], locale: 'nb-NO' },
  DK: {
    timezone: 'Europe/Copenhagen',
    languages: ['da-DK', 'da', 'en'],
    locale: 'da-DK',
  },
  FI: { timezone: 'Europe/Helsinki', languages: ['fi-FI', 'fi', 'en'], locale: 'fi-FI' },
  RU: { timezone: 'Europe/Moscow', languages: ['ru-RU', 'ru', 'en'], locale: 'ru-RU' },
  UA: {
    timezone: 'Europe/Kiev',
    languages: ['uk-UA', 'uk', 'ru', 'en'],
    locale: 'uk-UA',
  },
  TR: { timezone: 'Europe/Istanbul', languages: ['tr-TR', 'tr', 'en'], locale: 'tr-TR' },

  JP: { timezone: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en'], locale: 'ja-JP' },
  CN: { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh', 'en'], locale: 'zh-CN' },
  HK: { timezone: 'Asia/Hong_Kong', languages: ['zh-HK', 'zh', 'en'], locale: 'zh-HK' },
  TW: { timezone: 'Asia/Taipei', languages: ['zh-TW', 'zh', 'en'], locale: 'zh-TW' },
  KR: { timezone: 'Asia/Seoul', languages: ['ko-KR', 'ko', 'en'], locale: 'ko-KR' },
  IN: { timezone: 'Asia/Kolkata', languages: ['en-IN', 'en', 'hi'], locale: 'en-IN' },
  SG: { timezone: 'Asia/Singapore', languages: ['en-SG', 'en', 'zh'], locale: 'en-SG' },
  TH: { timezone: 'Asia/Bangkok', languages: ['th-TH', 'th', 'en'], locale: 'th-TH' },
  ID: { timezone: 'Asia/Jakarta', languages: ['id-ID', 'id', 'en'], locale: 'id-ID' },
  PH: { timezone: 'Asia/Manila', languages: ['en-PH', 'en', 'tl'], locale: 'en-PH' },
  VN: { timezone: 'Asia/Ho_Chi_Minh', languages: ['vi-VN', 'vi', 'en'], locale: 'vi-VN' },
  AE: { timezone: 'Asia/Dubai', languages: ['ar-AE', 'ar', 'en'], locale: 'ar-AE' },
  SA: { timezone: 'Asia/Riyadh', languages: ['ar-SA', 'ar', 'en'], locale: 'ar-SA' },
  IL: { timezone: 'Asia/Jerusalem', languages: ['he-IL', 'he', 'en'], locale: 'he-IL' },

  AU: { timezone: 'Australia/Sydney', languages: ['en-AU', 'en'], locale: 'en-AU' },
  NZ: { timezone: 'Pacific/Auckland', languages: ['en-NZ', 'en'], locale: 'en-NZ' },

  ZA: {
    timezone: 'Africa/Johannesburg',
    languages: ['en-ZA', 'en', 'af'],
    locale: 'en-ZA',
  },
  EG: { timezone: 'Africa/Cairo', languages: ['ar-EG', 'ar', 'en'], locale: 'ar-EG' },
  NG: { timezone: 'Africa/Lagos', languages: ['en-NG', 'en'], locale: 'en-NG' },
  KE: { timezone: 'Africa/Nairobi', languages: ['en-KE', 'en', 'sw'], locale: 'en-KE' },
}

/**
 * Resolve a country code (ISO 3166-1 alpha-2) into a locale profile.
 * Case-insensitive. Returns null if unknown — caller should NOT suggest
 * anything if null (better no suggestion than wrong).
 */
function resolveCountry(countryCode) {
  if (!countryCode || typeof countryCode !== 'string') return null
  const cc = countryCode.trim().toUpperCase()
  const entry = COUNTRY_LOCALES[cc]
  if (!entry) return null
  return {
    country: cc,
    timezone: entry.timezone,
    languages: entry.languages.slice(),
    locale: entry.locale,
  }
}

/** List of all supported country codes (for UI dropdowns). */
function listCountries() {
  return Object.keys(COUNTRY_LOCALES).sort()
}

module.exports = { COUNTRY_LOCALES, resolveCountry, listCountries }
