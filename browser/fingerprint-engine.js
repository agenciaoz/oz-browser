// OZ Browser — FingerprintEngine "Ghost+" core (1.9a).
//
// Qué hace: dado un `fingerprintSeed` UUID estable per-identity (ya existe en
// el modelo Identity desde 1.2), genera deterministicamente un perfil de
// fingerprint coherente — UA + platform + screen + timezone + languages +
// hardware + plugins + canvas/WebGL params. Mismo seed → mismo perfil siempre
// (consistencia per-identity); diferentes seeds → diferentes perfiles
// (diversidad cross-identity).
//
// Doc: docs/modules/fingerprint-engine.md
// ADR: docs/architecture/0018-fingerprint-engine.md
//
// Vectores incluidos en v1 (11 total — scope ajustado):
//   1. User-Agent + platform + appVersion + appName       [low-risk pure data]
//   2. hardwareConcurrency                                [low-risk pure data]
//   3. deviceMemory                                       [low-risk pure data]
//   4. languages + language                               [low-risk pure data]
//   5. screen (w, h, colorDepth, pixelDepth) + dpr        [low-risk pure data]
//   6. timezone (Intl + getTimezoneOffset)                [low-risk pure data]
//   7. plugins / mimeTypes (PDF viewer subset)            [low-risk pure data]
//   8. battery API (deprecated, but still detected)       [low-risk pure data]
//   9. speech voices (filtered list)                      [low-risk pure data]
//  10. canvas noise (toDataURL/getImageData)              [hook in 1.9c]
//  11. WebGL vendor/renderer params                       [hook in 1.9c]
//
// Vectores EXCLUIDOS de v1 (diferidos a 1.9 v2 o C-XX):
//   - AudioContext noise — perf overhead complicado de balancear
//   - WebRTC disable — rompe video calls / Discord / Meet
//   - Fonts subset — alta complejidad + UX risk (sites no encuentran fuentes)
//
// Persistencia: `fingerprints.json` per-identity. NO regenera por session
// (consistency). Solo regenera si user invoca `regenerate(identityId, seed?)`
// explícitamente.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const log = require('./logger')

// =================== BLUEPRINT TABLES ====================
// Cada "blueprint" es un perfil coherente — UA + screen + GPU son consistentes
// (un MacBook Pro M2 NO tendría GPU de Windows). El seed selecciona UN
// blueprint y luego se randomizan campos ortogonales (languages, timezone).
//
// Los UAs son recientes (Chrome 130-135 / Edge equivalente) para no destacar
// como "outdated" en Pixelscan (UA viejo = sospechoso).

const BLUEPRINTS = [
  // --- macOS Apple Silicon ---
  {
    id: 'mac-arm64-chrome-135',
    platform: 'MacIntel',
    appVersion:
      '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    hardwareConcurrencyOptions: [8, 10, 12],
    deviceMemoryOptions: [8, 16],
    screenOptions: [
      { w: 1512, h: 982, colorDepth: 30, dprOptions: [2] }, // MBP 13" M2 default zoom
      { w: 1728, h: 1117, colorDepth: 30, dprOptions: [2] }, // MBP 14" M2 Pro
      { w: 1920, h: 1200, colorDepth: 30, dprOptions: [2] }, // MBP 16" M2 Max
    ],
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      vendorOptions: ['Google Inc. (Apple)', 'Apple Inc.'],
      rendererOptions: [
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
      ],
    },
  },
  {
    id: 'mac-x64-chrome-135',
    platform: 'MacIntel',
    appVersion:
      '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    hardwareConcurrencyOptions: [4, 6, 8, 12],
    deviceMemoryOptions: [8, 16, 32],
    screenOptions: [
      { w: 1440, h: 900, colorDepth: 24, dprOptions: [1, 2] }, // iMac legacy
      { w: 1680, h: 1050, colorDepth: 24, dprOptions: [1, 2] },
      { w: 2560, h: 1440, colorDepth: 30, dprOptions: [2] },
    ],
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 645, OpenGL 4.1)',
      vendorOptions: ['Google Inc. (Intel)'],
      rendererOptions: [
        'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 645, OpenGL 4.1)',
        'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
      ],
    },
  },
  // --- Windows x64 ---
  {
    id: 'win-x64-chrome-135',
    platform: 'Win32',
    appVersion:
      '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    hardwareConcurrencyOptions: [4, 6, 8, 12, 16],
    deviceMemoryOptions: [4, 8, 16, 32],
    screenOptions: [
      { w: 1920, h: 1080, colorDepth: 24, dprOptions: [1] }, // most common
      { w: 1366, h: 768, colorDepth: 24, dprOptions: [1] }, // budget laptop
      { w: 2560, h: 1440, colorDepth: 24, dprOptions: [1] }, // QHD
      { w: 3840, h: 2160, colorDepth: 30, dprOptions: [1.5, 2] }, // 4K
    ],
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      vendorOptions: ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)'],
      rendererOptions: [
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (Intel, Intel(R) UHD Graphics 770, D3D11)',
        'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ],
    },
  },
  {
    id: 'win-x64-edge-135',
    platform: 'Win32',
    appVersion:
      '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.2906.86',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.2906.86',
    hardwareConcurrencyOptions: [4, 6, 8, 12, 16],
    deviceMemoryOptions: [4, 8, 16],
    screenOptions: [
      { w: 1920, h: 1080, colorDepth: 24, dprOptions: [1] },
      { w: 1366, h: 768, colorDepth: 24, dprOptions: [1] },
    ],
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770, D3D11)',
      vendorOptions: ['Google Inc. (Intel)'],
      rendererOptions: [
        'ANGLE (Intel, Intel(R) UHD Graphics 770, D3D11)',
        'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)',
      ],
    },
  },
  // --- Linux x64 ---
  {
    id: 'linux-x64-chrome-135',
    platform: 'Linux x86_64',
    appVersion:
      '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    hardwareConcurrencyOptions: [4, 8, 12, 16],
    deviceMemoryOptions: [8, 16, 32],
    screenOptions: [
      { w: 1920, h: 1080, colorDepth: 24, dprOptions: [1] },
      { w: 2560, h: 1440, colorDepth: 24, dprOptions: [1] },
    ],
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
      vendorOptions: ['Google Inc. (Intel)', 'Google Inc. (NVIDIA Corporation)'],
      rendererOptions: [
        'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
        'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.6)',
      ],
    },
  },
]

// Plugins that real Chrome reports — same on every platform (PDF viewer).
const STANDARD_PLUGINS = [
  {
    name: 'PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      },
      {
        type: 'text/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      },
    ],
  },
  {
    name: 'Chrome PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      },
    ],
  },
  {
    name: 'Chromium PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      },
    ],
  },
  {
    name: 'Microsoft Edge PDF Viewer',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      },
    ],
  },
  {
    name: 'WebKit built-in PDF',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
      },
    ],
  },
]

// Locale combinations — language + accept-languages + matching timezone.
// We pick a subset matching common user demographics so the fingerprint
// looks plausible even when the GeoIP coherence (1.9d) hasn't kicked in.
const LOCALE_PROFILES = [
  { locale: 'en-US', languages: ['en-US', 'en'], timezone: 'America/New_York' },
  { locale: 'en-US', languages: ['en-US', 'en'], timezone: 'America/Los_Angeles' },
  { locale: 'en-US', languages: ['en-US', 'en'], timezone: 'America/Chicago' },
  { locale: 'en-GB', languages: ['en-GB', 'en'], timezone: 'Europe/London' },
  { locale: 'es-ES', languages: ['es-ES', 'es', 'en'], timezone: 'Europe/Madrid' },
  {
    locale: 'es-AR',
    languages: ['es-AR', 'es', 'en'],
    timezone: 'America/Argentina/Buenos_Aires',
  },
  { locale: 'es-MX', languages: ['es-MX', 'es', 'en'], timezone: 'America/Mexico_City' },
  { locale: 'pt-BR', languages: ['pt-BR', 'pt', 'en'], timezone: 'America/Sao_Paulo' },
  { locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en'], timezone: 'Europe/Paris' },
  { locale: 'de-DE', languages: ['de-DE', 'de', 'en'], timezone: 'Europe/Berlin' },
  { locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'], timezone: 'Asia/Tokyo' },
]

// Speech voices — a real-ish subset commonly reported. Not exhaustive — we
// just need enough variability that fingerprint sites see "this user has
// voices" without giving up the spoof.
const SPEECH_VOICES_BY_LOCALE = {
  'en-US': [
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
    { name: 'Google US English', lang: 'en-US' },
  ],
  'en-GB': [
    { name: 'Google UK English Female', lang: 'en-GB' },
    { name: 'Google UK English Male', lang: 'en-GB' },
    { name: 'Daniel', lang: 'en-GB' },
  ],
  'es-ES': [
    { name: 'Google español', lang: 'es-ES' },
    { name: 'Mónica', lang: 'es-ES' },
  ],
  'es-AR': [{ name: 'Diego', lang: 'es-AR' }],
  'es-MX': [
    { name: 'Jorge', lang: 'es-MX' },
    { name: 'Paulina', lang: 'es-MX' },
  ],
  'pt-BR': [
    { name: 'Google português do Brasil', lang: 'pt-BR' },
    { name: 'Luciana', lang: 'pt-BR' },
  ],
  'fr-FR': [
    { name: 'Google français', lang: 'fr-FR' },
    { name: 'Thomas', lang: 'fr-FR' },
  ],
  'de-DE': [
    { name: 'Google Deutsch', lang: 'de-DE' },
    { name: 'Anna', lang: 'de-DE' },
  ],
  'ja-JP': [
    { name: 'Google 日本語', lang: 'ja-JP' },
    { name: 'Kyoko', lang: 'ja-JP' },
  ],
}

// =================== SEEDED RNG ============================================
// Determinism guarantee: cualquier output del fingerprint depende SOLO del
// seed, no del Date.now() ni de Math.random(). Esto permite test:
//   buildProfile(seed) === buildProfile(seed)  (always)
// Y permite que el preload script regenere el mismo perfil sin red trip.

function seedToHash(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest()
}

function makeRng(seedBuffer) {
  // Use sha256 bytes as a stream of pseudo-random uint32. Index resets per
  // call to next32() in a closure.
  let cursor = 0
  let buf = seedBuffer
  function ensure(bytes) {
    while (cursor + bytes > buf.length) {
      // Re-hash to extend.
      buf = Buffer.concat([buf, crypto.createHash('sha256').update(buf).digest()])
    }
  }
  return {
    next32() {
      ensure(4)
      const v = buf.readUInt32BE(cursor)
      cursor += 4
      return v
    },
    pickFrom(arr) {
      if (!arr || arr.length === 0) return null
      ensure(4)
      const idx = buf.readUInt32BE(cursor) % arr.length
      cursor += 4
      return arr[idx]
    },
    randomFloat() {
      // Returns 0..1 deterministic.
      ensure(4)
      const v = buf.readUInt32BE(cursor)
      cursor += 4
      return v / 0xffffffff
    },
  }
}

// =================== BUILD PROFILE =========================================

/**
 * Generate a deterministic fingerprint profile from a seed. The same seed
 * ALWAYS produces the same profile (consistency); different seeds produce
 * coherently varied profiles (diversity).
 *
 * @param {string} seed - the identity's fingerprintSeed UUID.
 * @returns {object} fingerprint profile with all 11 v1 vectors.
 */
function buildProfile(seed) {
  if (!seed) throw new Error('fingerprint-engine.buildProfile: seed required')
  const rng = makeRng(seedToHash(seed))

  const blueprint = rng.pickFrom(BLUEPRINTS)
  const screen = rng.pickFrom(blueprint.screenOptions)
  const dpr = rng.pickFrom(screen.dprOptions)
  const hardwareConcurrency = rng.pickFrom(blueprint.hardwareConcurrencyOptions)
  const deviceMemory = rng.pickFrom(blueprint.deviceMemoryOptions)
  const locale = rng.pickFrom(LOCALE_PROFILES)
  const webglVendor = rng.pickFrom(blueprint.webgl.vendorOptions)
  const webglRenderer = rng.pickFrom(blueprint.webgl.rendererOptions)
  // Plugins: pick the ones matching this UA family. Chrome and Edge ship
  // 5 PDF entries each for compat.
  const pluginCount = blueprint.id.includes('edge') ? 4 : 5
  const plugins = STANDARD_PLUGINS.slice(0, pluginCount)
  const voices =
    SPEECH_VOICES_BY_LOCALE[locale.locale] || SPEECH_VOICES_BY_LOCALE['en-US']

  // Battery — Chrome stopped exposing this on most OSes around v82, but
  // some sites still test it. We return a "plausible" steady-state battery
  // (charged, plugged in) which matches what Chrome would say if the API
  // were enabled.
  const battery = {
    charging: true,
    chargingTime: 0,
    dischargingTime: Infinity,
    level: 1,
  }

  return {
    seed,
    blueprintId: blueprint.id,
    ua: blueprint.ua,
    platform: blueprint.platform,
    appVersion: blueprint.appVersion,
    appName: 'Netscape', // Chrome reports this verbatim
    vendor: blueprint.id.includes('edge') ? '' : 'Google Inc.',
    hardwareConcurrency,
    deviceMemory,
    languages: locale.languages,
    language: locale.languages[0],
    locale: locale.locale,
    timezone: locale.timezone,
    screen: {
      width: screen.w,
      height: screen.h,
      availWidth: screen.w,
      availHeight: screen.h - 24, // dock/menubar
      colorDepth: screen.colorDepth,
      pixelDepth: screen.colorDepth,
    },
    devicePixelRatio: dpr,
    plugins,
    battery,
    speechVoices: voices,
    webgl: {
      vendor: webglVendor,
      renderer: webglRenderer,
    },
    // canvasNoiseSeed: 32-bit int derived from seed; the preload uses it to
    // perturb pixels deterministically (so same canvas operation always
    // produces same noisy output for this identity).
    canvasNoiseSeed: rng.next32(),
    // audioNoiseSeed (v3-C-audio / alpha.110): 32-bit int derived from seed.
    // El preload lo usa para perturbar levísimamente las muestras de audio
    // (AudioBuffer.getChannelData + AnalyserNode.getFloatFrequencyData) de
    // forma determinista → el AudioContext fingerprint es estable per-identity
    // pero distinto entre identities. Mismo patrón que canvasNoiseSeed.
    audioNoiseSeed: rng.next32(),
    generatedAt: Date.now(),
  }
}

// =================== ENGINE CLASS ==========================================

class FingerprintEngine {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'fingerprints.json')
    this.cache = {} // identityId → profile
    this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') this.cache = parsed
      }
    } catch (err) {
      console.error('[fingerprint-engine] failed to load:', err)
      this.cache = {}
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('[fingerprint-engine] failed to save:', err)
    }
  }

  /**
   * Get the fingerprint for an identity, generating + caching it if missing.
   * The seed must be passed by the caller (typically the IdentityManager
   * passes identity.fingerprintSeed). Returns the profile object.
   */
  getOrCreate(identityId, seed) {
    if (this.cache[identityId]) return { ...this.cache[identityId] }
    if (!seed) {
      throw new Error(
        'fingerprint-engine.getOrCreate: seed required for first generation',
      )
    }
    const profile = buildProfile(seed)
    this.cache[identityId] = profile
    this._save()
    log.info('fingerprint-engine', 'profile generated', {
      identityId,
      blueprintId: profile.blueprintId,
      locale: profile.locale,
      timezone: profile.timezone,
    })
    return { ...profile }
  }

  /**
   * Force-regenerate. Optional `newSeed` — if absent, mints a new one. After
   * regenerate, the user should reload all tabs of this identity to pick up
   * the new fingerprint (the preload reads it on page load).
   */
  regenerate(identityId, newSeed) {
    const seed = newSeed || crypto.randomBytes(8).toString('hex')
    const profile = buildProfile(seed)
    this.cache[identityId] = profile
    this._save()
    log.info('fingerprint-engine', 'profile regenerated', {
      identityId,
      blueprintId: profile.blueprintId,
    })
    return { ...profile }
  }

  /**
   * Apply a GeoIP-derived locale suggestion. Used by 1.9d after a proxy is
   * tested + classified by country. Mutates the cached profile (timezone +
   * languages + locale) WITHOUT regenerating the rest (so screen + UA stay
   * consistent across re-locations).
   *
   * V3-C: `source` records whether this came from an explicit user action
   * ('manual', default — preserves legacy callers) or from proxy auto-match
   * ('auto'). Auto-match callers consult `geoSource` first so they never
   * clobber a manual override (see geo-match.shouldAutoApplyGeo).
   */
  applyGeoSuggestion(
    identityId,
    { timezone, languages, locale } = {},
    source = 'manual',
  ) {
    const profile = this.cache[identityId]
    if (!profile) return null
    if (timezone) profile.timezone = timezone
    if (languages && Array.isArray(languages) && languages.length > 0) {
      profile.languages = languages.slice()
      profile.language = languages[0]
    }
    if (locale) profile.locale = locale
    profile.geoOverridden = true
    profile.geoOverriddenAt = Date.now()
    profile.geoSource = source === 'auto' ? 'auto' : 'manual'
    this._save()
    log.info('fingerprint-engine', 'geo suggestion applied', {
      identityId,
      timezone: profile.timezone,
      languages: profile.languages,
      source: profile.geoSource,
    })
    return { ...profile }
  }

  /** Inspect cached profile. Returns null if not generated yet. */
  get(identityId) {
    const profile = this.cache[identityId]
    return profile ? { ...profile } : null
  }

  /** Cleanup when an identity is removed. */
  remove(identityId) {
    if (!this.cache[identityId]) return false
    delete this.cache[identityId]
    this._save()
    return true
  }
}

module.exports = {
  FingerprintEngine,
  buildProfile, // exported for tests + standalone use
  BLUEPRINTS,
  LOCALE_PROFILES,
  STANDARD_PLUGINS,
  SPEECH_VOICES_BY_LOCALE,
}
