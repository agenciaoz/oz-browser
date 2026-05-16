// OZ Browser — Settings Manager (1.10a).
//
// Qué hace: persistencia de user preferences globales del browser. Schema
// versionado para migrations futuras. Validation per-key con whitelist.
//
// Doc: docs/modules/settings-manager.md
// ADR: docs/architecture/0019-settings-model.md
//
// Storage: ~/Library/Application Support/<appName>/settings.json
//
// Schema v1:
//   {
//     version: 1,
//     general: {
//       devMode: false,           // logs verbose + DevTools shortcuts
//       freeTier: false,          // OZ_TIER=free equivalent (limit 3 identities)
//       logLevel: 'INFO',         // DEBUG | INFO | WARN | ERROR
//     },
//     privacy: {
//       autoClearOnQuit: false,   // wipe session storage at quit (preserve cookies)
//     },
//     automation: {
//       mcpEnabled: false,        // expose MCP server on :9223 (security flag)
//       mcpPort: 9223,
//       mcpToken: null,           // optional bearer token
//     },
//     backup: {
//       dailySnapshot: true,      // 1.6 daily-3am cron toggle
//       retentionDays: 30,        // keep daily snapshots for N days
//     },
//     onboarding: {
//       completed: false,         // first-run onboarding flag (1.10c)
//       skippedAt: null,
//     },
//     performance: {              // 1.10d Apple Silicon perf
//       autoTabDiscard: true,     // discard idle tabs >30 min
//       discardIdleMin: 30,
//     },
//   }

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const log = require('./logger')

const SCHEMA_VERSION = 1

const DEFAULTS = Object.freeze({
  version: SCHEMA_VERSION,
  general: {
    devMode: false,
    freeTier: false,
    logLevel: 'INFO',
    // i18n v1 (1.1.0): UI locale. 'auto' resolves to app.getLocale() at boot.
    // 'en' / 'es' force a specific catalog. Anything else falls back to 'auto'.
    locale: 'auto',
  },
  privacy: {
    autoClearOnQuit: false,
  },
  automation: {
    mcpEnabled: false,
    mcpPort: 9223,
    mcpToken: null,
  },
  backup: {
    dailySnapshot: true,
    retentionDays: 30,
  },
  onboarding: {
    completed: false,
    skippedAt: null,
  },
  // v1.4.6: 5-step action wizard (workspace → proxies → identities → assign → test).
  // Independent flag from `onboarding` (welcome info screens) so users who saw
  // welcome but want to re-trigger the wizard from Settings keep welcome dismissed.
  onboardingWizard: {
    completed: false,
    skippedAt: null,
    skippedAtStep: null,
  },
  performance: {
    autoTabDiscard: true,
    discardIdleMin: 30,
  },
  // E2-C-5: notification preferences. Panel always records alerts; OS-level
  // alerts (Notification API) controlled by showOSAlert (default true).
  notifications: {
    showOSAlert: true,
  },
  // D-3c-3c: cross-device sync via Dropbox. Default OFF — user opts in from
  // Settings → Sync. firstEnableAt is set the first time enable=true is
  // committed so cold-start (push-all sweep) runs exactly once across the
  // life of the install.
  sync: {
    enabled: false,
    firstEnableAt: null,
  },
  // I-2 (v1.6.0): auto-updater preferences. enabled controls the periodic
  // 4h poll — when off, auto-updater-setup skips its scheduled checks but
  // the manual "Check now" button still works. Default ON because Mac
  // users expect silent background updates (standard for modern apps).
  autoUpdate: {
    enabled: true,
  },
})

const VALID_LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

class SettingsManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'settings.json')
    this.settings = deepClone(DEFAULTS)
    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      // Merge with defaults so newly-introduced keys appear without erroring.
      this.settings = mergeWithDefaults(parsed, DEFAULTS)
      // Migration hook for future schema bumps.
      if (this.settings.version !== SCHEMA_VERSION) {
        log.info('settings-manager', 'migrating settings', {
          from: this.settings.version,
          to: SCHEMA_VERSION,
        })
        // v1 is the initial version — no migrations yet.
        this.settings.version = SCHEMA_VERSION
        this._save()
      }
    } catch (err) {
      console.error('[settings-manager] failed to load settings.json:', err)
      this.settings = deepClone(DEFAULTS)
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8')
    } catch (err) {
      console.error('[settings-manager] failed to save settings.json:', err)
    }
  }

  // ---------- API ----------

  /** Get the entire settings object (deep copy, safe to mutate). */
  getAll() {
    return deepClone(this.settings)
  }

  /** Get a section: 'general' | 'privacy' | 'automation' | 'backup' | 'onboarding' | 'onboardingWizard' | 'performance' | 'notifications' | 'sync' | 'autoUpdate'. */
  get(section) {
    if (!this.settings[section]) return null
    return { ...this.settings[section] }
  }

  /**
   * Set a section's keys (partial merge). Validates per-key whitelist.
   * Returns the updated section object or { __error } on validation failure.
   */
  set(section, patch) {
    if (!this.settings[section]) {
      return { __error: { code: 'UNKNOWN_SECTION', section } }
    }
    const original = { ...this.settings[section] }
    const next = { ...original }
    for (const k of Object.keys(patch || {})) {
      if (!(k in DEFAULTS[section])) {
        log.warn('settings-manager', 'set: unknown key ignored', { section, key: k })
        continue
      }
      const v = patch[k]
      const validation = validateKey(section, k, v)
      if (!validation.ok) {
        return {
          __error: {
            code: 'INVALID_VALUE',
            section,
            key: k,
            value: v,
            reason: validation.reason,
          },
        }
      }
      next[k] = v
    }
    this.settings[section] = next
    this._save()
    log.info('settings-manager', 'section updated', {
      section,
      changedKeys: Object.keys(patch || {}).filter((k) => original[k] !== next[k]),
    })
    return { ...next }
  }

  /** Reset a section to defaults. */
  resetSection(section) {
    if (!DEFAULTS[section]) {
      return { __error: { code: 'UNKNOWN_SECTION', section } }
    }
    this.settings[section] = deepClone(DEFAULTS[section])
    this._save()
    log.info('settings-manager', 'section reset', { section })
    return { ...this.settings[section] }
  }

  /** Reset everything. */
  resetAll() {
    this.settings = deepClone(DEFAULTS)
    this._save()
    log.info('settings-manager', 'all settings reset')
    return deepClone(this.settings)
  }

  /**
   * Convenience: mark onboarding completed (1.10c).
   */
  markOnboarded() {
    this.set('onboarding', { completed: true })
  }

  /**
   * Convenience: mark onboarding skipped with timestamp (1.10c).
   */
  markOnboardingSkipped() {
    this.set('onboarding', { completed: true, skippedAt: Date.now() })
  }
}

// ---------- helpers ---------------------------------------------------------

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

function mergeWithDefaults(loaded, defaults) {
  const out = deepClone(defaults)
  for (const section of Object.keys(defaults)) {
    if (loaded && loaded[section] && typeof loaded[section] === 'object') {
      out[section] = { ...defaults[section], ...loaded[section] }
    }
  }
  if (loaded && typeof loaded.version === 'number') out.version = loaded.version
  return out
}

function validateKey(section, key, value) {
  // Per-key validation. Returns { ok: true } or { ok: false, reason }.
  if (key === 'logLevel') {
    if (typeof value !== 'string' || !VALID_LOG_LEVELS.includes(value)) {
      return {
        ok: false,
        reason: `must be one of ${VALID_LOG_LEVELS.join('/')}`,
      }
    }
  }
  if (key === 'mcpPort' || key === 'discardIdleMin' || key === 'retentionDays') {
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, reason: 'must be a positive integer' }
    }
    if (key === 'mcpPort' && value > 65535) {
      return { ok: false, reason: 'port must be ≤ 65535' }
    }
  }
  if (
    key === 'devMode' ||
    key === 'freeTier' ||
    key === 'autoClearOnQuit' ||
    key === 'mcpEnabled' ||
    key === 'dailySnapshot' ||
    key === 'completed' ||
    key === 'autoTabDiscard' ||
    key === 'showOSAlert' ||
    key === 'enabled'
  ) {
    if (typeof value !== 'boolean') {
      return { ok: false, reason: 'must be boolean' }
    }
  }
  if (key === 'firstEnableAt') {
    if (value !== null && typeof value !== 'string') {
      return { ok: false, reason: 'must be ISO 8601 string or null' }
    }
  }
  if (key === 'mcpToken') {
    if (value !== null && typeof value !== 'string') {
      return { ok: false, reason: 'must be string or null' }
    }
  }
  if (key === 'skippedAt') {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      return { ok: false, reason: 'must be epoch ms or null' }
    }
  }
  // v1.4.6: wizard skip step index.
  if (key === 'skippedAtStep') {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
      return { ok: false, reason: 'must be small non-negative integer or null' }
    }
  }
  if (key === 'locale') {
    const VALID = ['auto', 'en', 'es']
    if (typeof value !== 'string' || !VALID.includes(value)) {
      return { ok: false, reason: `must be one of ${VALID.join('/')}` }
    }
  }
  return { ok: true }
}

module.exports = { SettingsManager, DEFAULTS, SCHEMA_VERSION, VALID_LOG_LEVELS }
