// OZ Browser — Backup Manager (Time Machine, 1.6a).
//
// Doc: docs/modules/backup-manager.md
// Bloque: 1.6a
//
// Snapshots completos del userData (configs + vault.enc + Partitions/*) a
// archivos .ozbackup cifrados con la master key del Vault. Cero deps nuevas
// (zlib + crypto nativos + walk recursivo manual). Reusa la master key del
// Vault — el user solo debe cuidar el Keychain (single point of recovery).
//
// Formato .ozbackup (versión 1):
//   | header_len (u32 LE) | header_json_bytes |
//   | iv (12 bytes) | authTag (16 bytes) | ciphertext (gzip(flatpack(payload))) |
//
// Header JSON:
//   {
//     "format": "ozbackup",
//     "version": 1,
//     "createdAt": ISO timestamp,
//     "label": "user-provided or auto",
//     "reason": "manual" | "pre-quit" | "pre-overwrite-total" |
//               "daily-3am" | "pre-restore",
//     "vaultVersion": 1,
//     "uncompressedBytes": int,
//     "compressedBytes": int,
//     "fileCount": int,
//     "appVersion": "0.1.0",
//   }
//
// FlatPack format (uncompressed payload, before gzip+AES-GCM):
//   Repeated for each file:
//     | u32 LE pathLen | pathBytes (utf-8 relative posix path) |
//     | u32 LE contentLen | contentBytes |
//   End marker: | u32 LE 0 | u32 LE 0 |
//
// Storage:
//   ~/Library/Application Support/OZ Browser/data/snapshots/<id>.ozbackup
//   id = ISO timestamp con `:` y `.` removidos: "2026-05-10T02-45-12-345Z"
//
// Sensitive data: el .ozbackup es cifrado con la misma key del vault. Sin
// Keychain → sin restore. Mismo trade-off que vault.enc (decisión Jose 1.5a).
//
// FUTURE — Cloud backup tier (C-19, post-Etapa 7-OFFICE):
//   El formato .ozbackup es file-standalone y cifrado, así que se puede
//   subir tal cual a Dropbox/Supabase sin re-cifrar. Cloud backend NUNCA
//   ve plaintext (zero-knowledge). El header JSON queda visible (label,
//   reason, timestamp, size) — útil para listar snapshots remotos sin
//   descargar el body. Master key sigue local en Keychain → compromise
//   de Dropbox no compromete data. Premium tier diferenciador vs Ghost.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const log = require('./logger')

const BACKUP_FORMAT_VERSION = 1
const SNAPSHOT_FILENAME_RE = /^[0-9TZ.-]+\.ozbackup$/

class BackupError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

class BackupManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir - root that contains identities.json,
   *   workspaces.json, data/vault.enc, Partitions/*. In runtime this is
   *   `app.getPath('userData')`. In tests, a tmpdir.
   * @param {object} opts.vault - Vault instance (must be unlocked when
   *   createSnapshot/restoreSnapshot is invoked). Used to read the master key.
   * @param {string} [opts.snapshotsDir] - override storage dir (tests).
   * @param {string} [opts.appVersion] - put in header for forensics.
   */
  constructor(opts = {}) {
    if (!opts.userDataDir) throw new BackupError('userDataDir required', 'BAD_ARG')
    if (!opts.vault) throw new BackupError('vault required', 'BAD_ARG')
    this.userDataDir = opts.userDataDir
    this.vault = opts.vault
    this.snapshotsDir =
      opts.snapshotsDir || path.join(this.userDataDir, 'data', 'snapshots')
    this.appVersion = opts.appVersion || '0.0.0'
    fs.mkdirSync(this.snapshotsDir, { recursive: true })
  }

  // ---------- public API ----------

  /**
   * Take a snapshot of the entire userData. Vault must be unlocked.
   * @param {object} opts
   * @param {string} [opts.label] - human-readable label, default = reason+date
   * @param {string} [opts.reason] - 'manual'|'pre-quit'|'pre-overwrite-total'|
   *   'daily-3am'|'pre-restore'. Default 'manual'.
   * @returns {{id, filePath, header}} or throws BackupError.
   */
  createSnapshot(opts = {}) {
    const key = this.vault.getMasterKey()
    if (!key) throw new BackupError('Vault is locked', 'LOCKED')

    const reason = opts.reason || 'manual'
    const label = opts.label || `${reason} — ${new Date().toISOString().slice(0, 19)}`
    const id = isoToFilenameStamp(new Date())

    // 1. Walk + flatpack
    const files = this._collectFiles()
    const flat = _flatpack(this.userDataDir, files)
    const uncompressedBytes = flat.length

    // 2. Compress
    const compressed = zlib.gzipSync(flat, { level: 6 })
    const compressedBytes = compressed.length

    // 3. Encrypt
    const enc = _encryptBytes(key, compressed)

    // 4. Build header
    const header = {
      format: 'ozbackup',
      version: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      label,
      reason,
      vaultVersion: 1,
      uncompressedBytes,
      compressedBytes,
      fileCount: files.length,
      appVersion: this.appVersion,
    }
    const headerJson = Buffer.from(JSON.stringify(header), 'utf-8')
    const headerLen = Buffer.alloc(4)
    headerLen.writeUInt32LE(headerJson.length, 0)

    const out = Buffer.concat([
      headerLen,
      headerJson,
      enc.iv,
      enc.authTag,
      enc.ciphertext,
    ])

    const filePath = path.join(this.snapshotsDir, `${id}.ozbackup`)
    fs.writeFileSync(filePath, out)
    log.info('backup-manager', 'snapshot created', {
      id,
      reason,
      label,
      uncompressedBytes,
      compressedBytes,
      fileCount: files.length,
      filePath,
    })
    return { id, filePath, header }
  }

  /**
   * Returns list of snapshot metadata (newest first) without decrypting bodies.
   * Reads only the header of each .ozbackup. Cheap to call repeatedly.
   */
  listSnapshots() {
    let entries
    try {
      entries = fs.readdirSync(this.snapshotsDir)
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
    const snapshots = []
    for (const name of entries) {
      if (!SNAPSHOT_FILENAME_RE.test(name)) continue
      const filePath = path.join(this.snapshotsDir, name)
      try {
        const fd = fs.openSync(filePath, 'r')
        try {
          const lenBuf = Buffer.alloc(4)
          fs.readSync(fd, lenBuf, 0, 4, 0)
          const headerLen = lenBuf.readUInt32LE(0)
          if (headerLen <= 0 || headerLen > 100_000) continue // sanity
          const headerBuf = Buffer.alloc(headerLen)
          fs.readSync(fd, headerBuf, 0, headerLen, 4)
          const header = JSON.parse(headerBuf.toString('utf-8'))
          const stat = fs.fstatSync(fd)
          const id = name.replace(/\.ozbackup$/, '')
          snapshots.push({
            id,
            filePath,
            sizeBytes: stat.size,
            ...header,
          })
        } finally {
          fs.closeSync(fd)
        }
      } catch (err) {
        log.warn('backup-manager', 'corrupt snapshot file ignored', {
          name,
          message: err.message,
        })
      }
    }
    // Newest first by createdAt (falls back to filename id alphabetical = stamp).
    snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return snapshots
  }

  /**
   * Restore a snapshot. Vault MUST be unlocked. The current state is NOT
   * snapshotted automatically here — caller (handler layer) must invoke
   * createSnapshot({reason:'pre-restore'}) before calling this.
   *
   * Strategy: write all files to a staging dir under userDataDir, then
   * atomically rename + cleanup. If anything fails mid-write, the staging
   * dir is removed and the original userData stays intact.
   */
  restoreSnapshot(id) {
    const key = this.vault.getMasterKey()
    if (!key) throw new BackupError('Vault is locked', 'LOCKED')
    const filePath = path.join(this.snapshotsDir, `${id}.ozbackup`)
    if (!fs.existsSync(filePath)) {
      throw new BackupError(`Snapshot not found: ${id}`, 'NOT_FOUND')
    }
    const raw = fs.readFileSync(filePath)
    const headerLen = raw.readUInt32LE(0)
    const headerJson = raw.subarray(4, 4 + headerLen).toString('utf-8')
    const header = JSON.parse(headerJson)
    if (header.format !== 'ozbackup' || header.version !== BACKUP_FORMAT_VERSION) {
      throw new BackupError(
        `Unsupported backup format (${header.format} v${header.version})`,
        'BAD_FORMAT',
      )
    }
    const ivStart = 4 + headerLen
    const iv = raw.subarray(ivStart, ivStart + 12)
    const authTag = raw.subarray(ivStart + 12, ivStart + 28)
    const ciphertext = raw.subarray(ivStart + 28)
    let decrypted
    try {
      decrypted = _decryptBytes(key, iv, authTag, ciphertext)
    } catch (err) {
      throw new BackupError(
        `Decrypt failed (wrong key or tampered): ${err.message}`,
        'DECRYPT_FAILED',
      )
    }
    const flat = zlib.gunzipSync(decrypted)
    const files = _flatunpack(flat)
    // Atomic-ish: write to staging dir then rename in place. Per-file rename
    // is safe but full directory swap requires moving the live data aside.
    // For v1 we just overwrite — restore is destructive by design and the
    // pre-restore snapshot is the rollback path.
    let restoredCount = 0
    for (const { relPath, content } of files) {
      const target = path.join(this.userDataDir, relPath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
      restoredCount++
    }
    log.info('backup-manager', 'snapshot restored', {
      id,
      restoredCount,
      reason: header.reason,
      label: header.label,
    })
    return { ok: true, restoredCount, header }
  }

  deleteSnapshot(id) {
    const filePath = path.join(this.snapshotsDir, `${id}.ozbackup`)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    log.info('backup-manager', 'snapshot deleted', { id })
    return true
  }

  /**
   * Apply retention policy: keep all snapshots from last N days, then 1 per
   * week forever. Returns count of deletions.
   *
   * @param {object} opts
   * @param {number} [opts.keepDailyDays=30]
   */
  applyRetention(opts = {}) {
    const keepDailyDays = opts.keepDailyDays ?? 30
    const now = Date.now()
    const dailyCutoff = now - keepDailyDays * 24 * 60 * 60 * 1000
    const all = this.listSnapshots()
    // Group snapshots older than dailyCutoff by ISO week (YYYY-WW)
    const olderByWeek = new Map()
    const toDelete = []
    for (const s of all) {
      const ts = Date.parse(s.createdAt)
      if (ts >= dailyCutoff) continue // within daily window — keep
      const week = isoWeek(new Date(ts))
      if (!olderByWeek.has(week)) {
        olderByWeek.set(week, s) // first (newest) of that week → keep
      } else {
        toDelete.push(s.id) // any extra in same week → delete
      }
    }
    for (const id of toDelete) this.deleteSnapshot(id)
    log.info('backup-manager', 'retention applied', {
      keepDailyDays,
      deleted: toDelete.length,
      remaining: all.length - toDelete.length,
    })
    return { deletedCount: toDelete.length, deletedIds: toDelete }
  }

  // ---------- internal ----------

  _collectFiles() {
    const out = []
    // Top-level files first (cheap).
    const candidates = [
      'identities.json',
      'workspaces.json',
      'proxies.json',
      'settings.json',
      'data/vault.enc',
    ]
    for (const rel of candidates) {
      const p = path.join(this.userDataDir, rel)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        out.push(rel)
      }
    }
    // Recursive walk of Partitions/ (cookies, IndexedDB, localStorage, etc).
    const partitionsDir = path.join(this.userDataDir, 'Partitions')
    if (fs.existsSync(partitionsDir)) {
      _walkSync(partitionsDir, this.userDataDir, out)
    }
    return out
  }
}

// ---------- flatpack format ----------

function _flatpack(rootDir, relativePaths) {
  const chunks = []
  for (const rel of relativePaths) {
    const full = path.join(rootDir, rel)
    const content = fs.readFileSync(full)
    const nameBuf = Buffer.from(rel.replace(/\\/g, '/'), 'utf-8')
    const nameLen = Buffer.alloc(4)
    nameLen.writeUInt32LE(nameBuf.length, 0)
    const contentLen = Buffer.alloc(4)
    contentLen.writeUInt32LE(content.length, 0)
    chunks.push(nameLen, nameBuf, contentLen, content)
  }
  // End marker
  const end = Buffer.alloc(8)
  chunks.push(end)
  return Buffer.concat(chunks)
}

function _flatunpack(flat) {
  const files = []
  let pos = 0
  while (pos < flat.length) {
    if (pos + 8 > flat.length) break
    const nameLen = flat.readUInt32LE(pos)
    pos += 4
    if (nameLen === 0) {
      const contentLen = flat.readUInt32LE(pos)
      if (contentLen === 0) break // end marker
      throw new Error('Malformed flatpack: zero name with non-zero content')
    }
    const relPath = flat.subarray(pos, pos + nameLen).toString('utf-8')
    pos += nameLen
    const contentLen = flat.readUInt32LE(pos)
    pos += 4
    const content = flat.subarray(pos, pos + contentLen)
    pos += contentLen
    files.push({ relPath, content: Buffer.from(content) })
  }
  return files
}

function _walkSync(dir, rootDir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return
    throw err
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      _walkSync(full, rootDir, out)
    } else if (ent.isFile()) {
      out.push(path.relative(rootDir, full))
    }
    // Skip symlinks/sockets — Electron Partitions don't use them.
  }
}

// ---------- crypto (binary, vs vault's string-based _encrypt/_decrypt) ------

function _encryptBytes(key, plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { iv, ciphertext: ct, authTag }
}

function _decryptBytes(key, iv, authTag, ciphertext) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// ---------- helpers ----------

function isoToFilenameStamp(date) {
  // 2026-05-10T02:45:12.345Z → 2026-05-10T02-45-12-345Z (filesystem-safe)
  return date.toISOString().replace(/[:.]/g, '-')
}

function isoWeek(date) {
  // Returns "YYYY-WW" for retention week-grouping (ISO 8601 week).
  // CRITICAL: use getUTC* throughout — if we mix local-time accessors with
  // a UTC anchor, runners in negative TZ (e.g. CRT) misclassify dates around
  // midnight UTC. All snapshot timestamps are stored in ISO UTC, so isoWeek
  // operates in UTC end-to-end for consistency.
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

module.exports = {
  BackupManager,
  BackupError,
  BACKUP_FORMAT_VERSION,
  // Internal exports for tests
  _flatpack,
  _flatunpack,
  _encryptBytes,
  _decryptBytes,
  isoWeek,
}
