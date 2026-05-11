// OZ Browser — Extensions per-identity sharing (E2-C-7).
//
// Qué hace: las extensions se instalan UNA VEZ en defaultSession (Default
// identity) vía Chrome Web Store. Después el usuario decide cuáles activar
// en cada identity custom — esa activación carga la extension en la
// partition de la identity (persist:identity-X) usando el mismo extension
// folder que ya está en disco (zero copy).
//
// Por qué este approach (decisión scope C-7):
//   - electron-chrome-extensions soporta multi-session (fromSession + opts.session
//     en el constructor) — verificable en node_modules/electron-chrome-extensions/
//     dist/types/index.d.ts. PERO instanciar Web Store install per partition
//     duplicaría todo el storage + UI flow + posibles colisiones de protocol
//     handler. Prefiero install-once + activate-N-times.
//   - Cada identity tiene aislamiento real de cookies/storage/IndexedDB
//     (eso ya lo da la partition), pero comparten el código de la extension.
//     Si uBlock Origin tiene la misma blocklist en IG-1 e IG-2, está OK.
//     Si quisieras configs distintas per identity, eso requeriría un fork
//     de la extension o múltiples installs (out of scope v1).
//
// Doc: docs/modules/extensions-share.md
// ADR: 0010 (Default uses defaultSession), 0005 (≤500 LOC)
//
// Storage: ~/Library/Application Support/<appName>/extension-sharing.json
//   { byIdentity: { identityId: [extensionId, ...] } }
//
// Lifecycle:
//   1. Usuario instala uBlock Origin desde Web Store en Default → carga en
//      defaultSession (flujo existente, sin cambios).
//   2. Usuario abre "Manage extensions for identity X" → ve lista de
//      Default-installed extensions con checkbox per row.
//   3. Marca "uBlock Origin" para identity X → enableForIdentity()
//      persiste el binding + carga la extension en la partition de X.
//   4. Al boot, el sessionInitHook lee el binding y carga cada extension
//      en su partition correspondiente.

const fs = require('fs')
const path = require('path')
const { app, session } = require('electron')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const log = require('./logger')

class ExtensionShareManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'extension-sharing.json')
    this.identityManager = opts.identityManager || null
    // Per-identity ElectronChromeExtensions instances (lazy).
    // Keyed by identityId. Default identity uses the global instance from
    // extensions-setup.js, NOT this map.
    this.perIdentityExtensions = new Map()
    this.bindings = { byIdentity: {} }
    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && parsed.byIdentity && typeof parsed.byIdentity === 'object') {
          this.bindings = parsed
        }
      }
    } catch (err) {
      console.error('[extensions-share] failed to load:', err)
      this.bindings = { byIdentity: {} }
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.bindings, null, 2), 'utf-8')
    } catch (err) {
      console.error('[extensions-share] failed to save:', err)
    }
  }

  // ---------- query API ----------

  /**
   * List all extensions installed on the Default identity (defaultSession).
   * Returns array of { id, name, version, description?, manifest, path }.
   * Excludes the WebUI extension (oz-browser internal).
   */
  listInstalledInDefault() {
    const ses = session.defaultSession
    if (!ses || !ses.extensions) return []
    const all = ses.extensions.getAllExtensions ? ses.extensions.getAllExtensions() : []
    return all
      .filter((e) => e && e.manifest && e.manifest.name !== 'WebUI')
      .map((e) => ({
        id: e.id,
        name: e.manifest.name,
        version: e.manifest.version,
        description: e.manifest.description || null,
        path: e.path,
        manifestVersion: e.manifest.manifest_version || null,
      }))
  }

  /** List enabled extension IDs for a given identity (excluding Default). */
  listEnabledForIdentity(identityId) {
    if (!identityId || identityId === this._defaultIdentityId()) {
      // Default has all extensions enabled by virtue of being defaultSession.
      return this.listInstalledInDefault().map((e) => e.id)
    }
    return Array.from(this.bindings.byIdentity[identityId] || [])
  }

  /**
   * Compose a per-identity report: each Default-installed extension + whether
   * it's enabled for the identity. Used by the UI modal.
   */
  reportForIdentity(identityId) {
    const installed = this.listInstalledInDefault()
    const enabled = new Set(this.listEnabledForIdentity(identityId))
    const isDefault = identityId === this._defaultIdentityId()
    return installed.map((e) => ({
      ...e,
      enabledForIdentity: isDefault ? true : enabled.has(e.id),
      isDefault,
    }))
  }

  // ---------- mutations ----------

  /**
   * Enable an extension for a given identity. No-op if already enabled.
   * Default identity is rejected (already always-enabled by virtue of being
   * defaultSession). Returns { ok, alreadyEnabled?, extension? }.
   */
  async enableForIdentity(identityId, extensionId) {
    if (!identityId || !extensionId) {
      return { ok: false, reason: 'identityId-and-extensionId-required' }
    }
    if (identityId === this._defaultIdentityId()) {
      return { ok: false, reason: 'default-always-enabled' }
    }
    const installed = this.listInstalledInDefault().find((e) => e.id === extensionId)
    if (!installed) {
      return { ok: false, reason: 'extension-not-installed-in-default' }
    }
    const list = this.bindings.byIdentity[identityId] || []
    if (list.includes(extensionId)) {
      return { ok: true, alreadyEnabled: true, extension: installed }
    }

    const loaded = await this._loadExtensionInIdentitySession(identityId, installed)
    if (!loaded.ok) return loaded

    list.push(extensionId)
    this.bindings.byIdentity[identityId] = list
    this._save()
    log.info('extensions-share', 'extension enabled for identity', {
      identityId,
      extensionId,
      name: installed.name,
    })
    return { ok: true, extension: installed }
  }

  /**
   * Disable an extension for a given identity. Removes the loaded extension
   * from that identity's session. Default identity rejects (out of scope —
   * to uninstall, use the existing chrome://extensions flow on Default).
   */
  disableForIdentity(identityId, extensionId) {
    if (identityId === this._defaultIdentityId()) {
      return { ok: false, reason: 'default-uninstall-via-chrome-extensions' }
    }
    const list = this.bindings.byIdentity[identityId] || []
    const idx = list.indexOf(extensionId)
    if (idx < 0) return { ok: true, alreadyDisabled: true }

    try {
      const ses = this._sessionForIdentity(identityId)
      if (ses && ses.extensions && typeof ses.extensions.removeExtension === 'function') {
        ses.extensions.removeExtension(extensionId)
      }
    } catch (err) {
      log.warn('extensions-share', 'removeExtension failed (proceeding)', {
        identityId,
        extensionId,
        message: err.message,
      })
    }

    list.splice(idx, 1)
    this.bindings.byIdentity[identityId] = list
    this._save()
    log.info('extensions-share', 'extension disabled for identity', {
      identityId,
      extensionId,
    })
    return { ok: true }
  }

  /**
   * Called by the IdentityManager session-init hook. Re-loads all enabled
   * extensions for this identity into its session. Idempotent — getExtension
   * check prevents double-load.
   */
  async hookSessionInit(identityId, ses) {
    if (!identityId || identityId === this._defaultIdentityId()) return
    const list = this.bindings.byIdentity[identityId] || []
    if (list.length === 0) return
    // Ensure ChromeExtensions API is registered on this session FIRST.
    this._ensureChromeExtensionsForSession(identityId, ses)

    const installed = this.listInstalledInDefault()
    for (const extId of list) {
      const ext = installed.find((e) => e.id === extId)
      if (!ext) {
        log.warn('extensions-share', 'enabled extension no longer installed in default', {
          identityId,
          extId,
        })
        continue
      }
      try {
        // Skip if already loaded in this session.
        const already =
          ses.extensions &&
          ses.extensions.getExtension &&
          ses.extensions.getExtension(extId)
        if (already) continue
        await ses.extensions.loadExtension(ext.path)
        log.debug('extensions-share', 'extension loaded into identity session', {
          identityId,
          extId,
          name: ext.name,
        })
      } catch (err) {
        log.error('extensions-share', 'loadExtension failed', {
          identityId,
          extId,
          message: err.message,
        })
      }
    }
  }

  // ---------- internal ----------

  async _loadExtensionInIdentitySession(identityId, ext) {
    try {
      const ses = this._sessionForIdentity(identityId)
      if (!ses) return { ok: false, reason: 'no-session-for-identity' }
      this._ensureChromeExtensionsForSession(identityId, ses)
      const already =
        ses.extensions &&
        ses.extensions.getExtension &&
        ses.extensions.getExtension(ext.id)
      if (!already) await ses.extensions.loadExtension(ext.path)
      return { ok: true }
    } catch (err) {
      log.error('extensions-share', 'load failed', {
        identityId,
        extId: ext.id,
        message: err.message,
      })
      return { ok: false, reason: 'load-failed', message: err.message }
    }
  }

  _sessionForIdentity(identityId) {
    if (!this.identityManager) return null
    return this.identityManager.getSession(identityId)
  }

  /**
   * Lazily create one ElectronChromeExtensions instance per identity session.
   * Cached in perIdentityExtensions. Without this, loaded extensions can't
   * call chrome.* APIs (no implementation registered for that session).
   * Reuses the createTab/selectTab/removeTab handlers conceptually — but
   * here we use minimal stubs since identity sessions don't need full window
   * orchestration (they share the global Browser windows already).
   */
  _ensureChromeExtensionsForSession(identityId, ses) {
    if (this.perIdentityExtensions.has(identityId)) return
    try {
      const inst = new ElectronChromeExtensions({
        license: 'internal-license-do-not-use',
        session: ses,
        // Minimal handlers — most chrome.* APIs that extensions actually use
        // (storage, runtime, declarativeNetRequest) work without these. Tab
        // orchestration goes through the Default instance's webContents which
        // has the same window registration.
        createTab: async () => {
          throw new Error('createTab not supported on identity-scoped extensions')
        },
        selectTab: () => {},
        removeTab: () => {},
        createWindow: async () => {
          throw new Error('createWindow not supported on identity-scoped extensions')
        },
        removeWindow: () => {},
      })
      ElectronChromeExtensions.handleCRXProtocol(ses)
      this.perIdentityExtensions.set(identityId, inst)
      log.info('extensions-share', 'ChromeExtensions registered for identity', {
        identityId,
      })
    } catch (err) {
      log.error('extensions-share', 'ChromeExtensions registration failed for identity', {
        identityId,
        message: err.message,
      })
    }
  }

  _defaultIdentityId() {
    if (!this.identityManager) return null
    const def = this.identityManager.getDefault()
    return def ? def.id : null
  }
}

module.exports = { ExtensionShareManager }
