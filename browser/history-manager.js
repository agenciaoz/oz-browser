// OZ Browser — History Manager (1.10b).
//
// Qué hace: tracking per-identity de navigation history. Hook into Tab events
// (tab-created → tab-updated cuando cambia URL) y persiste history.json.
//
// Doc: docs/modules/history-manager.md
// ADR: docs/architecture/0019-settings-model.md (sección History)
//
// Modelo:
//   {
//     id, identityId,
//     url, title?, faviconUrl?,
//     visitedAt
//   }
//
// Storage: ~/Library/Application Support/<appName>/history.json
//
// Cap: 10000 entries TOTAL (oldest evicted). Per-identity filter en list().
// Decisión: no per-identity cap por simplicidad. Si una identity domina
// porque tiene mucha actividad, las otras pierden history más viejo. v2
// puede añadir per-identity cap.
//
// Dedup: si el last entry para (identityId, url) está dentro de 60s, NO se
// agrega un nuevo record (avoid spam de SPAs que disparan did-navigate-in-page).

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const log = require('./logger')

const MAX_HISTORY = 10000
const DEDUP_WINDOW_MS = 60 * 1000

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}
function now() {
  return Date.now()
}

class HistoryManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'history.json')
    this.entries = []
    this._broadcast = opts.broadcast || null
    // Throttled save — coalesce bursts of did-navigate events
    this._saveTimer = null
    this._dirty = false
    this._saveDelayMs = opts.saveDelayMs || 2000
    this._load()
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.entries = parsed
    } catch (err) {
      console.error('[history-manager] failed to load:', err)
      this.entries = []
    }
  }

  _scheduleSave() {
    this._dirty = true
    if (this._saveDelayMs <= 0) {
      this._flush()
      return
    }
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => this._flush(), this._saveDelayMs)
  }

  _flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (!this._dirty) return
    this._dirty = false
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf-8')
    } catch (err) {
      console.error('[history-manager] failed to save:', err)
    }
  }

  flush() {
    this._flush()
  }

  _evictIfNeeded() {
    if (this.entries.length <= MAX_HISTORY) return
    // Drop oldest. Sort newest first then trim.
    this.entries.sort((a, b) => b.visitedAt - a.visitedAt)
    this.entries.length = MAX_HISTORY
  }

  /**
   * Add a visit to history. Dedups if the same (identityId, url) was added
   * within DEDUP_WINDOW_MS — only updates the existing record's title +
   * visitedAt. Returns the record (new or updated).
   */
  addVisit({ identityId, url, title, faviconUrl } = {}) {
    if (!identityId || !url) return null
    if (url.startsWith('about:') || url.startsWith('chrome-extension:')) {
      return null // skip internal pages
    }
    const t = now()
    // Dedup recent
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.identityId === identityId && e.url === url) {
        if (t - e.visitedAt < DEDUP_WINDOW_MS) {
          if (title && title !== e.title) e.title = title
          if (faviconUrl && faviconUrl !== e.faviconUrl) e.faviconUrl = faviconUrl
          e.visitedAt = t
          this._scheduleSave()
          return { ...e }
        }
        break
      }
    }
    const record = {
      id: uuid(),
      identityId,
      url,
      title: title || null,
      faviconUrl: faviconUrl || null,
      visitedAt: t,
    }
    this.entries.push(record)
    this._evictIfNeeded()
    this._scheduleSave()
    if (this._broadcast) this._broadcast('oz:history:changed')
    return { ...record }
  }

  /**
   * List entries with optional filter:
   *   { identityId, search (case-insensitive substring on url+title), limit }
   */
  list(filter = {}) {
    let out = this.entries.slice()
    if (filter.identityId) {
      out = out.filter((e) => e.identityId === filter.identityId)
    }
    if (filter.search && typeof filter.search === 'string') {
      const q = filter.search.toLowerCase()
      out = out.filter(
        (e) =>
          (e.url && e.url.toLowerCase().includes(q)) ||
          (e.title && e.title.toLowerCase().includes(q)),
      )
    }
    out.sort((a, b) => b.visitedAt - a.visitedAt)
    if (filter.limit && out.length > filter.limit) out = out.slice(0, filter.limit)
    return out
  }

  remove(id) {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    this._scheduleSave()
    if (this._broadcast) this._broadcast('oz:history:changed')
    return true
  }

  clear(filter = null) {
    const before = this.entries.length
    if (!filter) this.entries = []
    else if (filter.identityId) {
      this.entries = this.entries.filter((e) => e.identityId !== filter.identityId)
    } else if (filter.beforeMs) {
      this.entries = this.entries.filter((e) => e.visitedAt >= filter.beforeMs)
    }
    const removed = before - this.entries.length
    if (removed > 0) {
      this._scheduleSave()
      if (this._broadcast) this._broadcast('oz:history:changed')
    }
    return removed
  }

  /**
   * Hook into a Tabs instance: listen for tab-updated events (which fire on
   * did-navigate / page-title-updated / page-favicon-updated) and call
   * addVisit. Idempotent via tag.
   */
  hookTabs(tabs) {
    if (!tabs || tabs._ozHistoryHooked) return
    tabs._ozHistoryHooked = true
    tabs.on('tab-updated', (tab, info) => {
      // info has the same shape as serialize() — has url, title, identityId
      const url = info && info.url
      if (!url) return
      this.addVisit({
        identityId: tab.identityId,
        url,
        title: info.title,
        faviconUrl: info.favicon,
      })
    })
    log.debug('history-manager', 'tabs hooked')
  }
}

module.exports = { HistoryManager, MAX_HISTORY, DEDUP_WINDOW_MS }
