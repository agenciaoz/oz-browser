// OZ Browser — Pre-bulk-destructive proxy snapshot (H-2 extras, v1.1.6).
//
// Por qué existe: las acciones bulk destructivas (delete N proxies,
// disable N proxies) pueden ser catastróficas si el user se equivoca de
// selección. Antes de ejecutarlas, snapshoteamos el state actual del
// pool en disk para que sea recuperable manualmente.
//
// Storage: `userData/proxy-bulk-backups/<isoTimestamp>.json`. Cada backup
// es un blob JSON con shape:
//   {
//     ts: '2026-05-15T21:50:00.000Z',
//     reason: 'bulk-delete' | 'bulk-disable' | 'bulk-other',
//     ids: ['<the ids being acted on>'],
//     proxies: [<full proxy records snapshot from proxyManager.list()>]
//   }
//
// Retention: mantenemos los últimos 20 backups; los más viejos se podan.
// 20 es un compromiso — la mayoría de bulk ops son raras, pero si Jose
// hace 30 imports en un día queremos los más recientes accesibles.
//
// Restore: NO hay UI de restore en v1.1.6 — el path se loguea, el user
// puede inspeccionar/restaurar manualmente. Por qué no auto-restore:
// merge logic es delicado (proxy IDs pueden colisionar con creates post-
// backup) y queremos pensarlo bien antes de shippear.
//
// Doc: docs/modules/proxy-bulk-backup.md (TBD)

const fs = require('fs')
const path = require('path')
const log = require('./logger')

const SUBDIR = 'proxy-bulk-backups'
const MAX_KEPT = 20

function buildProxyBulkBackup({ proxyManager, userDataDir, now }) {
  if (!userDataDir) throw new Error('proxy-bulk-backup: userDataDir required')
  const dir = path.join(userDataDir, SUBDIR)
  const nowFn = typeof now === 'function' ? now : () => new Date()

  // mkdir if needed — defer to first snapshot so we don't pollute the
  // userData dir for users who never run bulk ops.
  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  /**
   * Take a snapshot of the current proxy pool. Returns { ok, path, count }.
   * Failure swallowed and logged — we DON'T want a backup failure to block
   * the actual bulk op (defensive UX: better to do the op without backup
   * than to deny the user the action). Caller checks `ok`.
   */
  function snapshot({ reason, ids } = {}) {
    if (!proxyManager) {
      return { ok: false, reason: 'NO_PROXY_MANAGER' }
    }
    try {
      ensureDir()
      const proxies = typeof proxyManager.list === 'function' ? proxyManager.list() : []
      const ts = nowFn().toISOString()
      const filename = `${ts.replace(/[:.]/g, '-')}.json`
      const fp = path.join(dir, filename)
      const payload = {
        ts,
        reason: String(reason || 'bulk-other'),
        ids: Array.isArray(ids) ? ids.slice(0, 1000) : [],
        proxies,
      }
      fs.writeFileSync(fp, JSON.stringify(payload, null, 2), 'utf-8')
      pruneOldBackups()
      log.info('proxy-bulk-backup', 'snapshot saved', {
        path: fp,
        count: proxies.length,
        reason: payload.reason,
      })
      return { ok: true, path: fp, count: proxies.length, ts, reason: payload.reason }
    } catch (err) {
      log.warn('proxy-bulk-backup', 'snapshot failed', { message: err && err.message })
      return { ok: false, reason: 'WRITE_FAILED', message: err && err.message }
    }
  }

  /**
   * List all backups in the dir, sorted newest-first.
   * Returns [{ ts, reason, count, idsCount, path }].
   */
  function list() {
    if (!fs.existsSync(dir)) return []
    const out = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const fp = path.join(dir, name)
      try {
        const raw = fs.readFileSync(fp, 'utf-8')
        const j = JSON.parse(raw)
        out.push({
          ts: j.ts || name.replace(/\.json$/, ''),
          reason: j.reason || 'unknown',
          count: Array.isArray(j.proxies) ? j.proxies.length : 0,
          idsCount: Array.isArray(j.ids) ? j.ids.length : 0,
          path: fp,
        })
      } catch (_err) {
        // Skip malformed files but don't fail the whole list.
      }
    }
    // Newest-first.
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    return out
  }

  /**
   * Trim old backups beyond MAX_KEPT. Called automatically after each
   * snapshot. Exposed for tests + manual ops.
   */
  function pruneOldBackups() {
    if (!fs.existsSync(dir)) return { kept: 0, deleted: 0 }
    const entries = list()
    if (entries.length <= MAX_KEPT) {
      return { kept: entries.length, deleted: 0 }
    }
    const toDelete = entries.slice(MAX_KEPT)
    let deleted = 0
    for (const e of toDelete) {
      try {
        fs.unlinkSync(e.path)
        deleted++
      } catch (err) {
        log.warn('proxy-bulk-backup', 'prune failed', {
          path: e.path,
          message: err && err.message,
        })
      }
    }
    return { kept: MAX_KEPT, deleted }
  }

  return { snapshot, list, pruneOldBackups, _dir: dir }
}

module.exports = { buildProxyBulkBackup, MAX_KEPT }
