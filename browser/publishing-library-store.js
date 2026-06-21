// OZ Browser — Publishing library store (E1-E4 → MCP-first migration, MAIN).
//
// Las colecciones de autoría del Publishing Studio (plantillas de caption,
// grupos de hashtags, media library) vivían en localStorage del renderer →
// el MCP no las podía tocar. Esto las mueve al MAIN (JSON atómico) para que el
// agente las maneje vía oz.publishing.lib* y la UI lea de la misma fuente.
//
// Persistencia: userData/publishing-library.json
//   { version, templates:[{id,name,caption,hashtags[]}],
//     hashtags:[{id,name,tags[]}], media:[{id,path}] }
//
// ADR: 0038 (publishing-studio) · 0005 (modular).

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SCHEMA_VERSION = 1
const KINDS = ['templates', 'hashtags', 'media']

function _id() {
  return 'lib-' + crypto.randomBytes(6).toString('hex')
}

class PublishingLibraryStore {
  constructor(opts = {}) {
    if (!opts.userDataDir) throw new Error('PublishingLibraryStore: userDataDir required')
    this.filePath = path.join(opts.userDataDir, 'publishing-library.json')
    this._data = { templates: [], hashtags: [], media: [] }
    this._load()
  }

  list(kind) {
    if (KINDS.indexOf(kind) < 0) return []
    return this._data[kind].map((x) => ({ ...x }))
  }

  /**
   * Crea un item en la colección. Normaliza por kind. Devuelve el item o null
   * si el kind es inválido.
   */
  save(kind, item = {}) {
    if (KINDS.indexOf(kind) < 0) return null
    let normalized
    if (kind === 'templates') {
      normalized = {
        id: _id(),
        name: String(item.name || 'Untitled').slice(0, 80),
        caption: String(item.caption || ''),
        hashtags: Array.isArray(item.hashtags) ? item.hashtags.slice() : [],
      }
    } else if (kind === 'hashtags') {
      normalized = {
        id: _id(),
        name: String(item.name || 'Group').slice(0, 60),
        tags: (Array.isArray(item.tags) ? item.tags : [])
          .map((t) => String(t).trim().replace(/^#+/, ''))
          .filter(Boolean),
      }
    } else {
      // media: { id, path } (acepta también un string crudo).
      const p = (
        typeof item === 'string' ? item : String((item && item.path) || '')
      ).trim()
      if (!p) return null
      // dedupe by path
      this._data.media = this._data.media.filter((m) => m.path !== p)
      normalized = { id: _id(), path: p }
    }
    this._data[kind].unshift(normalized)
    this._persist()
    return { ...normalized }
  }

  remove(kind, id) {
    if (KINDS.indexOf(kind) < 0) return false
    const before = this._data[kind].length
    this._data[kind] = this._data[kind].filter((x) => x.id !== id)
    if (this._data[kind].length === before) return false
    this._persist()
    return true
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (_e) {
      return
    }
    if (!raw || raw.version !== SCHEMA_VERSION) return
    for (const k of KINDS) if (Array.isArray(raw[k])) this._data[k] = raw[k]
  }

  _persist() {
    const out = { version: SCHEMA_VERSION, ...this._data }
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}

module.exports = { PublishingLibraryStore, SCHEMA_VERSION, KINDS }
