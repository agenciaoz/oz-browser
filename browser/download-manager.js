// OZ Browser — Download Manager (1.10b).
//
// Qué hace: tracking per-identity de downloads. Hookea session.on('will-download')
// en cada identity session y persiste un registro completo en downloads.json.
//
// Doc: docs/modules/download-manager.md
// ADR: docs/architecture/0019-settings-model.md (sección Downloads)
//
// Modelo:
//   {
//     id, identityId,
//     filename, savePath,
//     url,
//     mimeType?, totalBytes?, receivedBytes,
//     state: 'progressing'|'completed'|'cancelled'|'interrupted',
//     startedAt, updatedAt, finishedAt?
//   }
//
// Storage: ~/Library/Application Support/<appName>/downloads.json
//
// Cap: 1000 downloads totales (oldest evicted). El user puede limpiar via UI.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const log = require('./logger')

const MAX_DOWNLOADS = 1000

function uuid() {
  return crypto.randomBytes(8).toString('hex')
}
function now() {
  return Date.now()
}

class DownloadManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || app.getPath('userData')
    this.filePath = path.join(this.dataDir, 'downloads.json')
    this.downloads = []
    this._broadcast = opts.broadcast || null
    this._load()
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.downloads = parsed
    } catch (err) {
      console.error('[download-manager] failed to load:', err)
      this.downloads = []
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.downloads, null, 2), 'utf-8')
    } catch (err) {
      console.error('[download-manager] failed to save:', err)
    }
  }

  _evictIfNeeded() {
    if (this.downloads.length <= MAX_DOWNLOADS) return
    // Drop oldest by startedAt — keep finished ones first then progressing.
    this.downloads.sort((a, b) => b.startedAt - a.startedAt)
    this.downloads.length = MAX_DOWNLOADS
  }

  // ---------- API ----------

  list(filter = null) {
    let out = this.downloads.map((d) => ({ ...d }))
    if (filter && filter.identityId) {
      out = out.filter((d) => d.identityId === filter.identityId)
    }
    if (filter && filter.state) {
      out = out.filter((d) => d.state === filter.state)
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id) {
    return this.downloads.find((d) => d.id === id) || null
  }

  remove(id) {
    const before = this.downloads.length
    this.downloads = this.downloads.filter((d) => d.id !== id)
    if (this.downloads.length === before) return false
    this._save()
    if (this._broadcast) this._broadcast('oz:downloads:changed')
    return true
  }

  clear(filter = null) {
    if (!filter) {
      const n = this.downloads.length
      this.downloads = []
      this._save()
      if (this._broadcast) this._broadcast('oz:downloads:changed')
      return n
    }
    const before = this.downloads.length
    if (filter.identityId) {
      this.downloads = this.downloads.filter((d) => d.identityId !== filter.identityId)
    }
    const removed = before - this.downloads.length
    if (removed > 0) {
      this._save()
      if (this._broadcast) this._broadcast('oz:downloads:changed')
    }
    return removed
  }

  /**
   * Hook a session: install will-download listener + push records as the
   * download progresses / finishes. Idempotent per session via a tag set
   * on the session object.
   */
  hookSession(identityId, session) {
    if (!session || session._ozDownloadHooked) return
    session._ozDownloadHooked = true
    session.on('will-download', (_event, item) => {
      const id = uuid()
      const record = {
        id,
        identityId,
        filename: item.getFilename(),
        savePath: item.getSavePath() || null,
        url: item.getURL(),
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes() || null,
        receivedBytes: 0,
        state: 'progressing',
        startedAt: now(),
        updatedAt: now(),
        finishedAt: null,
      }
      this.downloads.push(record)
      this._evictIfNeeded()
      this._save()
      if (this._broadcast) this._broadcast('oz:downloads:changed')
      log.info('download-manager', 'will-download', {
        id,
        identityId,
        filename: record.filename,
        url: record.url,
      })

      item.on('updated', (__e, state) => {
        record.receivedBytes = item.getReceivedBytes()
        record.savePath = item.getSavePath() || record.savePath
        record.updatedAt = now()
        if (state === 'interrupted') record.state = 'interrupted'
        // No save() on every progress tick — it would thrash. Save on
        // 'done' (final state) below.
      })
      item.once('done', (__e, state) => {
        record.state = state // 'completed' | 'cancelled' | 'interrupted'
        record.savePath = item.getSavePath() || record.savePath
        record.receivedBytes = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes() || record.totalBytes
        record.finishedAt = now()
        record.updatedAt = now()
        this._save()
        if (this._broadcast) this._broadcast('oz:downloads:changed')
        log.info('download-manager', 'done', {
          id,
          state,
          bytes: record.receivedBytes,
        })
      })
    })
  }
}

module.exports = { DownloadManager, MAX_DOWNLOADS }
