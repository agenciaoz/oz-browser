// OZ Browser — Identity Manager
//
// An Identity is a persistent isolated browsing profile (cookies, storage,
// optional proxy, optional UA). Tabs are bound to one Identity at create time.
//
// Storage: ~/Library/Application Support/<appName>/identities.json
// Sessions: lazily created via session.fromPartition('persist:identity-<id>')
// Cached so that all tabs of the same Identity share the same Session object.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app, session } = require('electron')

const DEFAULT_COLORS = [
  '#5b8def', '#ff7a45', '#36b37e', '#ffab00', '#9c5cf2',
  '#e85a8c', '#00b8d9', '#f15a5a', '#36b37e', '#ff5630',
]

function uuid() {
  // Short, URL-safe id. crypto.randomUUID() works but is too long for partition names.
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

class IdentityManager {
  constructor() {
    this.dataDir = app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'identities.json')
    this.identities = []
    this.sessionCache = new Map() // id -> Session

    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.identities = JSON.parse(raw)
      }
    } catch (err) {
      console.error('[identity-manager] failed to load identities.json:', err)
      this.identities = []
    }

    // Ensure default identity exists.
    if (!this.identities.some((id) => id.isDefault)) {
      this.identities.unshift({
        id: 'default',
        name: 'Default',
        color: '#8a8a8a',
        fingerprintSeed: uuid(),
        createdAt: now(),
        isDefault: true,
      })
      this._save()
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.identities, null, 2), 'utf-8')
    } catch (err) {
      console.error('[identity-manager] failed to save identities.json:', err)
    }
  }

  // ---------- CRUD ----------

  list() {
    return this.identities.map((i) => ({ ...i }))
  }

  get(id) {
    return this.identities.find((i) => i.id === id) || null
  }

  getDefault() {
    return this.identities.find((i) => i.isDefault) || this.identities[0]
  }

  create({ name = 'New Identity', color } = {}) {
    const used = new Set(this.identities.map((i) => i.color))
    const pickedColor =
      color ||
      DEFAULT_COLORS.find((c) => !used.has(c)) ||
      DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]

    const identity = {
      id: uuid(),
      name,
      color: pickedColor,
      fingerprintSeed: uuid(),
      createdAt: now(),
    }
    this.identities.push(identity)
    this._save()
    return { ...identity }
  }

  rename(id, name) {
    const ident = this.get(id)
    if (!ident) return null
    ident.name = name
    this._save()
    return { ...ident }
  }

  setColor(id, color) {
    const ident = this.get(id)
    if (!ident) return null
    ident.color = color
    this._save()
    return { ...ident }
  }

  remove(id) {
    const ident = this.get(id)
    if (!ident) return false
    if (ident.isDefault) {
      console.warn('[identity-manager] refusing to remove default identity')
      return false
    }
    this.identities = this.identities.filter((i) => i.id !== id)
    this.sessionCache.delete(id)
    this._save()
    // NOTE: partition data on disk is NOT cleared here — leave for Bloque 1.6.
    return true
  }

  // ---------- sessions ----------

  /**
   * Returns the Electron Session associated with this Identity, creating it
   * (via persist: partition) on first call and caching it thereafter.
   *
   * The 'default' identity uses session.defaultSession so that the
   * Chrome Web Store extensions registered in main.js work for it. Other
   * identities use isolated partitions; extension support for them is
   * deferred to Bloque 1.5.
   */
  getSession(id) {
    if (!id) id = this.getDefault().id

    if (this.sessionCache.has(id)) {
      return this.sessionCache.get(id)
    }

    const ident = this.get(id)
    let ses
    if (ident && ident.isDefault) {
      ses = session.defaultSession
    } else {
      ses = session.fromPartition(`persist:identity-${id}`, { cache: true })
    }

    this.sessionCache.set(id, ses)
    return ses
  }

  /**
   * Convenience: returns { identity, session } for a given id (or default).
   */
  resolve(id) {
    const ident = this.get(id) || this.getDefault()
    return { identity: ident, session: this.getSession(ident.id) }
  }
}

module.exports = { IdentityManager }
