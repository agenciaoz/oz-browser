// OZ Browser — Publishing plan store (E5, MAIN process). Ghost-style content
// plan: publications con workflow de aprobación, persistidas en main (JSON
// atómico) para que el MCP (oz.publishing.*) Y la UI las manejen — una sola
// fuente de verdad, no localStorage del renderer.
//
// Shape de publicación:
//   { id, status, platform, caption, media[], identities[], scheduledAt,
//     createdAt, updatedAt }
// Estados (workflow): draft → review → approved → published (ver publishing-plan.js).
//
// Persistencia: userData/publishing-plan.json (tmp+rename), patrón project-store.
//
// ADR: 0038 (publishing-studio) · 0005 (modular).

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SCHEMA_VERSION = 1
const STATUSES = ['draft', 'review', 'approved', 'published']

class PublishingPlanStore {
  constructor(opts = {}) {
    if (!opts.userDataDir) throw new Error('PublishingPlanStore: userDataDir required')
    this.filePath = path.join(opts.userDataDir, 'publishing-plan.json')
    this.clock = opts.clock || { now: () => Date.now() }
    this._pubs = []
    this._load()
  }

  list() {
    return this._pubs.map((p) => ({ ...p }))
  }
  listByStatus(status) {
    return this._pubs.filter((p) => p.status === status).map((p) => ({ ...p }))
  }
  get(id) {
    const p = this._pubs.find((x) => x.id === id)
    return p ? { ...p } : null
  }

  add(pub = {}) {
    const iso = new Date(this.clock.now()).toISOString()
    const item = {
      id: 'pub-' + crypto.randomBytes(6).toString('hex'),
      status: STATUSES.indexOf(pub.status) >= 0 ? pub.status : 'draft',
      platform: String(pub.platform || ''),
      caption: String(pub.caption || ''),
      media: Array.isArray(pub.media) ? pub.media.slice() : [],
      identities: Array.isArray(pub.identities) ? pub.identities.slice() : [],
      scheduledAt: pub.scheduledAt || null,
      createdAt: iso,
      updatedAt: iso,
    }
    this._pubs.unshift(item)
    this._persist()
    return { ...item }
  }

  /** Bulk add (Excel import). Returns count added. */
  addMany(pubs) {
    let added = 0
    for (const p of Array.isArray(pubs) ? pubs : []) {
      this.add(p)
      added++
    }
    return added
  }

  update(id, patch = {}) {
    const p = this._pubs.find((x) => x.id === id)
    if (!p) return null
    const allowed = [
      'status',
      'platform',
      'caption',
      'media',
      'identities',
      'scheduledAt',
    ]
    for (const k of allowed) if (k in patch) p[k] = patch[k]
    p.updatedAt = new Date(this.clock.now()).toISOString()
    this._persist()
    return { ...p }
  }

  setStatus(id, status) {
    if (STATUSES.indexOf(status) < 0) return null
    return this.update(id, { status })
  }

  remove(id) {
    const before = this._pubs.length
    this._pubs = this._pubs.filter((x) => x.id !== id)
    if (this._pubs.length === before) return false
    this._persist()
    return true
  }

  // ---------- persistence -----------------------------------------------------

  _load() {
    if (!fs.existsSync(this.filePath)) return
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (_e) {
      return
    }
    if (!raw || raw.version !== SCHEMA_VERSION || !Array.isArray(raw.publications)) return
    this._pubs = raw.publications.filter((p) => p && p.id)
  }

  _persist() {
    const out = { version: SCHEMA_VERSION, publications: this._pubs }
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}

module.exports = { PublishingPlanStore, SCHEMA_VERSION, STATUSES }
