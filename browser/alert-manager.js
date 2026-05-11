// OZ Browser — Alert manager (E2-C-5).
//
// Qué hace: log persistente in-app de eventos importantes que el user
// querría revisar después (account needs relogin, proxy auto-disabled,
// snapshot creado, identity cap reached, etc). Convive con las OS
// notifications nativas — el panel registra TODO; las OS notifications
// siguen para urgentes (controlables vía settings).
//
// Doc: docs/modules/alert-manager.md
// ADR: ninguna (orquestación sobre primitivas existentes — JSON file +
//      broadcast channel).
//
// Persistencia: userData/alerts.json (cap 500 FIFO, throttled save 1s).
// Schema v1:
//   { version: 1, alerts: [Alert...] }
// Alert v1:
//   {
//     id: 'a-<hex>',
//     ts: 1746939600123,         // ms epoch
//     type: 'anti-logout' | 'proxy-disabled' | 'snapshot' |
//            'identity-cap' | 'crash-recovery' | 'lock-conflict' | ...
//     severity: 'urgent' | 'info' | 'success',
//     title: 'Account needs relogin',
//     message: 'IG Cliente A cookies expired. Click to re-login.',
//     identityId?: 'abc...',     // optional — for "Open identity" action
//     action?: {                 // optional — UI surfaces button if present
//       kind: 'open-modal' | 'open-identity' | 'open-proxy-mgr' |
//              'open-time-machine' | 'select-tab',
//       payload?: any
//     },
//     read: false
//   }
//
// API:
//   const am = new AlertManager({ userDataDir, broadcast, saveDelayMs? })
//   const alert = am.add({ type, severity, title, message, identityId?, action? })
//   am.list({ limit?, type?, unreadOnly?, since? }) → array (newest first)
//   am.markRead(id) → boolean
//   am.markAllRead() → number (count marked)
//   am.clear() → number (count removed)
//   am.unreadCount() → number
//   am.flush() → forces sync save (for before-quit)
//
// Side effects:
//   - On every add/markRead/markAllRead/clear, calls broadcast('oz:alerts:changed')
//     so UI refreshes badge counter + panel content live.
//
// Cap eviction: when alerts.length > 500, oldest non-urgent are evicted
// first. Urgent unread alerts are protected (only evicted if EVERY entry
// in the list is urgent, fallback to plain FIFO).

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const log = require('./logger')

const ALERT_FILE = 'alerts.json'
const SCHEMA_VERSION = 1
const MAX_ALERTS = 500
const DEFAULT_SAVE_DELAY_MS = 1000

const VALID_SEVERITIES = ['urgent', 'info', 'success']

function newAlertId() {
  return 'a-' + crypto.randomBytes(6).toString('hex')
}

class AlertManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir
   * @param {(channel:string)=>void} [opts.broadcast]
   * @param {number} [opts.saveDelayMs=1000]
   * @param {()=>number} [opts.clock]
   */
  constructor({ userDataDir, broadcast, saveDelayMs, clock } = {}) {
    if (!userDataDir) throw new Error('AlertManager: userDataDir required')
    this.userDataDir = userDataDir
    this.filePath = path.join(userDataDir, ALERT_FILE)
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {}
    this.saveDelayMs =
      typeof saveDelayMs === 'number' ? saveDelayMs : DEFAULT_SAVE_DELAY_MS
    this.clock = clock || (() => Date.now())
    this.alerts = []
    this._saveTimer = null
    this._dirty = false
    this._load()
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === SCHEMA_VERSION && Array.isArray(parsed.alerts)) {
        this.alerts = parsed.alerts
      } else {
        log.warn('alert-manager', 'alerts.json schema mismatch — starting fresh')
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('alert-manager', 'load failed — starting fresh', {
          message: err.message,
        })
      }
    }
  }

  _scheduleSave() {
    this._dirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this.flush()
    }, this.saveDelayMs)
  }

  flush() {
    if (!this._dirty && !this._saveTimer) return
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true })
      const payload = { version: SCHEMA_VERSION, alerts: this.alerts }
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2))
      this._dirty = false
    } catch (err) {
      log.error('alert-manager', 'save failed', {
        message: err.message,
        path: this.filePath,
      })
    }
  }

  _evict() {
    if (this.alerts.length <= MAX_ALERTS) return
    // Evict oldest non-urgent first to protect critical unread alerts.
    while (this.alerts.length > MAX_ALERTS) {
      const idx = this.alerts.findIndex((a) => a.severity !== 'urgent' || a.read)
      if (idx >= 0) {
        this.alerts.splice(idx, 1)
      } else {
        // Everything is urgent + unread — fallback to plain FIFO.
        this.alerts.shift()
      }
    }
  }

  /**
   * Add a new alert. Returns the created alert with id + ts populated.
   */
  add({ type, severity, title, message, identityId, action } = {}) {
    if (!type || typeof type !== 'string') {
      log.warn('alert-manager', 'add() missing type — skip')
      return null
    }
    const sev = VALID_SEVERITIES.includes(severity) ? severity : 'info'
    const alert = {
      id: newAlertId(),
      ts: this.clock(),
      type,
      severity: sev,
      title: typeof title === 'string' ? title : type,
      message: typeof message === 'string' ? message : '',
      read: false,
    }
    if (identityId) alert.identityId = identityId
    if (action && typeof action === 'object') alert.action = action
    this.alerts.push(alert)
    this._evict()
    this._scheduleSave()
    log.info('alert-manager', 'alert added', {
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
    })
    this.broadcast('oz:alerts:changed')
    return alert
  }

  /**
   * List alerts, newest first.
   * @param {object} [opts]
   * @param {number} [opts.limit] — max entries returned
   * @param {string|string[]} [opts.type] — filter by type(s)
   * @param {boolean} [opts.unreadOnly]
   * @param {number} [opts.since] — only entries with ts >= since
   */
  list(opts = {}) {
    let out = this.alerts.slice().reverse()
    if (opts.unreadOnly) out = out.filter((a) => !a.read)
    if (opts.type) {
      const types = Array.isArray(opts.type) ? opts.type : [opts.type]
      out = out.filter((a) => types.includes(a.type))
    }
    if (typeof opts.since === 'number') {
      out = out.filter((a) => a.ts >= opts.since)
    }
    if (typeof opts.limit === 'number' && opts.limit >= 0) {
      out = out.slice(0, opts.limit)
    }
    return out.map((a) => ({ ...a }))
  }

  markRead(id) {
    const alert = this.alerts.find((a) => a.id === id)
    if (!alert) return false
    if (alert.read) return true
    alert.read = true
    this._scheduleSave()
    this.broadcast('oz:alerts:changed')
    return true
  }

  markAllRead() {
    let count = 0
    for (const a of this.alerts) {
      if (!a.read) {
        a.read = true
        count++
      }
    }
    if (count > 0) {
      this._scheduleSave()
      this.broadcast('oz:alerts:changed')
    }
    return count
  }

  clear() {
    const count = this.alerts.length
    if (count === 0) return 0
    this.alerts = []
    this._scheduleSave()
    this.broadcast('oz:alerts:changed')
    return count
  }

  /** Remove a single alert by id. Returns true if removed. */
  remove(id) {
    const idx = this.alerts.findIndex((a) => a.id === id)
    if (idx < 0) return false
    this.alerts.splice(idx, 1)
    this._scheduleSave()
    this.broadcast('oz:alerts:changed')
    return true
  }

  unreadCount() {
    let n = 0
    for (const a of this.alerts) if (!a.read) n++
    return n
  }
}

module.exports = { AlertManager, ALERT_FILE, SCHEMA_VERSION, MAX_ALERTS }
