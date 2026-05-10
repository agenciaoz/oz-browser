// OZ Browser — Bookmark Manager (1.7b — MVP).
//
// Qué hace: CRUD mínimo de bookmarks per-identity + persistencia bookmarks.json.
// Esta es la base storage; la página completa de gestión (search/edit/folders)
// llega en Bloque 1.10 (Settings UI + Bookmarks/Downloads/History).
//
// Doc: docs/modules/bookmark-manager.md
// ADR: docs/architecture/0016-tab-context-menu.md (sección Bookmarks MVP)
//
// Modelo:
//   {
//     id,           // uuid hex
//     identityId,   // owning identity (bookmark visibility filtered per-id)
//     url,          // navegable href
//     title,        // display string
//     favicon,      // dataURL/string opcional
//     addedAt,      // epoch ms
//   }
//
// Storage: ~/Library/Application Support/<appName>/bookmarks.json (JSON array).
//
// Diseño:
//  - addFromTab(tab) toma {id, identityId, url, title, favicon} de la tab y
//    deduplica por (identityId,url) — re-bookmark del mismo URL es noop.
//  - list() acepta filter opcional {identityId} para mostrar solo los de una
//    identidad (la página de bookmarks del 1.10 los agrupará por identity).
//  - Ningún folder en v1 — flat list. Folders en 1.10 si Jose lo pide.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const log = require('./logger')

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

class BookmarkManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'bookmarks.json')
    this.bookmarks = []
    this._load()
  }

  // ---------- persistence ----------

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.bookmarks = JSON.parse(raw)
        if (!Array.isArray(this.bookmarks)) this.bookmarks = []
      }
    } catch (err) {
      console.error('[bookmark-manager] failed to load bookmarks.json:', err)
      this.bookmarks = []
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.bookmarks, null, 2), 'utf-8')
    } catch (err) {
      console.error('[bookmark-manager] failed to save bookmarks.json:', err)
    }
  }

  // ---------- CRUD ----------

  /** All bookmarks (or filtered by identityId). */
  list(filter = null) {
    let out = this.bookmarks.map((b) => ({ ...b }))
    if (filter && filter.identityId) {
      out = out.filter((b) => b.identityId === filter.identityId)
    }
    return out
  }

  get(id) {
    return this.bookmarks.find((b) => b.id === id) || null
  }

  /**
   * Find an existing bookmark for (identityId, url) or null. Used by addFromTab
   * to avoid duplicates when the user re-bookmarks the same URL on the same
   * identity (silent noop instead of two entries).
   */
  findByUrl(identityId, url) {
    return (
      this.bookmarks.find((b) => b.identityId === identityId && b.url === url) || null
    )
  }

  add({ identityId, url, title, favicon } = {}) {
    if (!identityId || !url) {
      log.warn('bookmark-manager', 'add: missing identityId or url')
      return null
    }
    // Dedup
    const existing = this.findByUrl(identityId, url)
    if (existing) {
      log.debug('bookmark-manager', 'add: duplicate, returning existing', {
        id: existing.id,
      })
      return { ...existing, deduped: true }
    }
    const bookmark = {
      id: uuid(),
      identityId,
      url,
      title: title || url,
      favicon: favicon || null,
      addedAt: now(),
    }
    this.bookmarks.push(bookmark)
    this._save()
    log.info('bookmark-manager', 'bookmark added', {
      id: bookmark.id,
      identityId,
      url,
      total: this.bookmarks.length,
    })
    return { ...bookmark }
  }

  /**
   * Convenience overload — extracts {identityId,url,title,favicon} from a tab
   * (or tab spec) object. Returns the bookmark or null on missing fields.
   */
  addFromTab(tab) {
    if (!tab) return null
    const url = tab.url || (tab.pendingUrl ? tab.pendingUrl : '')
    return this.add({
      identityId: tab.identityId,
      url,
      title: tab.title,
      favicon: tab.favicon,
    })
  }

  remove(id) {
    const before = this.bookmarks.length
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id)
    if (this.bookmarks.length === before) return false
    this._save()
    log.info('bookmark-manager', 'bookmark removed', { id })
    return true
  }

  /** Bulk delete — used when an identity is removed (Bloque 1.10 cleanup). */
  removeByIdentity(identityId) {
    const before = this.bookmarks.length
    this.bookmarks = this.bookmarks.filter((b) => b.identityId !== identityId)
    const deleted = before - this.bookmarks.length
    if (deleted > 0) {
      this._save()
      log.info('bookmark-manager', 'identity bookmarks purged', {
        identityId,
        deleted,
      })
    }
    return deleted
  }
}

module.exports = { BookmarkManager }
