// OZ Browser — Projects store (Ghost-style "save & restore", F2).
//
// Guarda sets de tabs con nombre que el usuario puede cerrar y reabrir idénticos.
// Dos alcances (Jose, 2026-06-20):
//   - type 'workspace' → las tabs del workspace activo.
//   - type 'session'   → las tabs de TODOS los workspaces (snapshot completo).
//
// Cada tab guardada: { identityId, url, title, workspaceId }. Al reabrir, el
// handler recrea las tabs (lazy) bajo su identity. La captura del estado vivo
// (leer browser.windows) vive en project-handlers.js; acá solo persistencia.
//
// Persistencia: userData/projects.json atómico (tmp+rename), mismo patrón que
// bulk-runs / crawl-frontier.
//
// ADR: 0005 (modular).

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SCHEMA_VERSION = 1
const VALID_TYPES = ['workspace', 'session']

class ProjectStore {
  constructor(opts = {}) {
    if (!opts.userDataDir) throw new Error('ProjectStore: userDataDir required')
    this.filePath = path.join(opts.userDataDir, 'projects.json')
    this.clock = opts.clock || { now: () => Date.now() }
    this._projects = [] // [{id,name,type,createdAt,tabs:[...]}]
    this._load()
  }

  /** Metadata-only list (sin las tabs), ordenada por más reciente. */
  list() {
    return this._projects
      .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        createdAt: p.createdAt,
        tabCount: Array.isArray(p.tabs) ? p.tabs.length : 0,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  /** Full project (con tabs) o null. */
  get(id) {
    const p = this._projects.find((x) => x.id === id)
    return p ? JSON.parse(JSON.stringify(p)) : null
  }

  /**
   * Guarda un proyecto nuevo. `tabs` ya viene capturado por el handler.
   * @returns {object} el proyecto guardado (metadata).
   */
  save({ name, type, tabs }) {
    const cleanName = (typeof name === 'string' && name.trim()) || 'Untitled'
    const cleanType = VALID_TYPES.indexOf(type) >= 0 ? type : 'workspace'
    const cleanTabs = Array.isArray(tabs)
      ? tabs
          .filter((t) => t && typeof t.url === 'string' && t.url)
          .map((t) => ({
            identityId: t.identityId || null,
            url: t.url,
            title: t.title || '',
            workspaceId: t.workspaceId || null,
          }))
      : []
    const project = {
      id: 'prj-' + crypto.randomBytes(6).toString('hex'),
      name: cleanName,
      type: cleanType,
      createdAt: this.clock.now(),
      tabs: cleanTabs,
    }
    this._projects.push(project)
    this._persist()
    return {
      id: project.id,
      name: project.name,
      type: project.type,
      tabCount: cleanTabs.length,
    }
  }

  rename(id, name) {
    const p = this._projects.find((x) => x.id === id)
    if (!p) return false
    const clean = (typeof name === 'string' && name.trim()) || p.name
    p.name = clean
    this._persist()
    return true
  }

  remove(id) {
    const before = this._projects.length
    this._projects = this._projects.filter((x) => x.id !== id)
    if (this._projects.length === before) return false
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
      return // corrupt → start fresh
    }
    if (!raw || raw.version !== SCHEMA_VERSION || !Array.isArray(raw.projects)) return
    this._projects = raw.projects.filter((p) => p && p.id && Array.isArray(p.tabs))
  }

  _persist() {
    const out = { version: SCHEMA_VERSION, projects: this._projects }
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}

module.exports = { ProjectStore, SCHEMA_VERSION, VALID_TYPES }
