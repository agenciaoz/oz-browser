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
const { EventEmitter } = require('events')
const { app } = require('electron')
const log = require('./logger')

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}

function now() {
  return Date.now()
}

// D-4 mini b: bookmarks sync as a SINGLE-record (full-file LWW per ADR 0026
// §1). recordId is a fixed string so the engine can treat the collection
// as one row.
const BOOKMARKS_RECORD_ID = 'all'

function nowIso() {
  return new Date().toISOString()
}

class BookmarkManager extends EventEmitter {
  /**
   * D-4 mini b — emits 'changed' after every mutation. Payload:
   *   { op: 'update', recordType: 'bookmarks', recordId: 'all', updatedAt }
   *
   * `updatedAt` is persisted in a SIDECAR file (`bookmarks-sync-meta.json`)
   * so the existing bookmarks.json format is untouched. Zero migration
   * risk for the bookmark file itself.
   */
  constructor(opts = {}) {
    super()
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'bookmarks.json')
    this.metaFilePath = path.join(this.dataDir, 'bookmarks-sync-meta.json')
    this.bookmarks = []
    this._updatedAt = null
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
    // D-4 mini b: load sidecar updatedAt (separate file — bookmarks.json
    // format is unchanged for backwards compat).
    this._updatedAt = this._loadMeta()
  }

  _loadMeta() {
    if (!fs.existsSync(this.metaFilePath)) return null
    try {
      const raw = fs.readFileSync(this.metaFilePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        typeof parsed.updatedAt === 'string' &&
        !Number.isNaN(Date.parse(parsed.updatedAt))
      ) {
        return parsed.updatedAt
      }
    } catch (err) {
      log.warn('bookmark-manager', 'meta read failed', { message: err.message })
    }
    return null
  }

  _saveMeta() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      const tmp = this.metaFilePath + '.tmp'
      fs.writeFileSync(
        tmp,
        JSON.stringify({ schemaVersion: 1, updatedAt: this._updatedAt }, null, 2),
        'utf-8',
      )
      fs.renameSync(tmp, this.metaFilePath)
    } catch (err) {
      log.warn('bookmark-manager', 'meta save failed', { message: err.message })
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

  /** D-4 mini b: ISO 8601 stamp tracked in the sidecar meta file. */
  getUpdatedAt() {
    return this._updatedAt
  }

  /**
   * D-4 mini b: sync payload — the whole bookmark collection as a single
   * "record" with id='all'. The sync engine treats this as one row;
   * fetchRecord('all') returns this on the push side; the apply side
   * replaces the local array wholesale with body.bookmarks.
   */
  getSyncRecord() {
    return {
      id: BOOKMARKS_RECORD_ID,
      updatedAt: this._updatedAt || nowIso(),
      bookmarks: this.bookmarks.map((b) => ({ ...b })),
    }
  }

  /** D-4 mini b: stamp + emit. Called by every mutation after _save(). */
  _stampAndEmit() {
    this._updatedAt = nowIso()
    this._saveMeta()
    try {
      this.emit('changed', {
        op: 'update',
        recordType: 'bookmark',
        recordId: BOOKMARKS_RECORD_ID,
        updatedAt: this._updatedAt,
      })
    } catch (err) {
      log.warn('bookmark-manager', "'changed' listener threw", {
        message: err.message,
      })
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
    this._stampAndEmit()
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
    this._stampAndEmit()
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
      this._stampAndEmit()
      log.info('bookmark-manager', 'identity bookmarks purged', {
        identityId,
        deleted,
      })
    }
    return deleted
  }
}

module.exports = { BookmarkManager, BOOKMARKS_RECORD_ID }
