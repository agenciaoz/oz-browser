// OZ Browser — Bulk Rate-limit Registry (v2 sub-bloque 6).
//
// Counter persistente que trackea cuántos actions ejecutó cada identity
// per platform per día. Sirve para evitar soft-bans:
//   - Cada plataforma tiene un cap diario seguro (IG follow ~150, etc.).
//   - Antes de cada item, el bulk runner consulta `wouldExceed()`.
//   - Si el cap se alcanzó, el item se skip-ea con `reason='rate-limit'`.
//
// Persistencia: `userData/bulk-rate-limits.json` atómico (tmp+rename).
// Estructura:
//   {
//     version: 1,
//     counters: {
//       "<identityId>::<platform>::<YYYY-MM-DD>": <count>,
//       ...
//     }
//   }
//
// Clave per-day → al cambiar el día, la entry vieja queda obsoleta pero
// no crece sin control: `purgeOldEntries()` borra entries de >30 días al
// boot.
//
// Caps default per platform (conservadores — sin science exacto pero
// reflejan los umbrales típicos antes de soft-ban):
//   instagram.com: like=200, follow=150, comment=50, post=10
//   x.com:         like=500, post=100
//   tiktok.com:    like=500, follow=200
//   facebook.com:  like=300, follow=100
//
// Override per-action via opts.caps al instanciar, o por env var
// `OZ_BULK_CAP_<platform>_<action>=N` (test/dev).
//
// API:
//   const reg = new BulkRateLimit({ userDataDir, clock? })
//   reg.getCount(identityId, platform, actionId) → number
//   reg.getCap(platform, actionId) → number
//   reg.wouldExceed(identityId, platform, actionId) → boolean
//   reg.increment(identityId, platform, actionId) → newCount
//   reg.purgeOldEntries(daysOld=30)
//   reg.stats(identityId?) → { byKey: {...} }
//
// Doc: docs/modules/bulk-rate-limit.md (TBD)

'use strict'

const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 1

// Default caps per (platform, actionId). Conservative.
const DEFAULT_CAPS = {
  'instagram.com': {
    ig_like: 200,
    ig_follow: 150,
    ig_comment: 50,
    ig_post: 10,
    _default: 100,
  },
  'x.com': {
    x_like: 500,
    x_post: 100,
    _default: 200,
  },
  'tiktok.com': {
    tiktok_like: 500,
    tiktok_follow: 200,
    _default: 200,
  },
  'facebook.com': {
    fb_like: 300,
    fb_follow: 100,
    fb_post: 25,
    _default: 100,
  },
  'threads.net': {
    threads_post: 30,
    _default: 100,
  },
  // Platform agnostic (echo / navigate) — no rate limit.
  _default: {
    _default: Infinity,
  },
}

class BulkRateLimit {
  constructor(opts = {}) {
    if (!opts.userDataDir) throw new Error('BulkRateLimit: userDataDir required')
    this.userDataDir = opts.userDataDir
    this.filePath = path.join(this.userDataDir, 'bulk-rate-limits.json')
    this.clock = opts.clock || _realClock()
    this.caps = _mergeCaps(DEFAULT_CAPS, opts.caps || {})
    this._counters = new Map() // key → count
    this._loadFromDisk()
  }

  // ---------- public API ----------------------------------------------------

  /**
   * Returns the cap for (platform, actionId). Falls back to platform
   * _default, then global _default (Infinity for non-platform actions).
   */
  getCap(platform, actionId) {
    if (!platform) return Infinity
    const pcaps = this.caps[platform]
    if (!pcaps) return Infinity
    if (actionId && pcaps[actionId] != null) return pcaps[actionId]
    if (pcaps._default != null) return pcaps._default
    return Infinity
  }

  /**
   * Current count for (identity, platform, actionId, today).
   */
  getCount(identityId, platform, actionId) {
    const key = this._key(identityId, platform, actionId)
    return this._counters.get(key) || 0
  }

  /**
   * Would calling this action right now exceed the cap?
   */
  wouldExceed(identityId, platform, actionId) {
    const cap = this.getCap(platform, actionId)
    if (cap === Infinity) return false
    const cur = this.getCount(identityId, platform, actionId)
    return cur >= cap
  }

  /**
   * Increment and persist. Returns the new count.
   */
  increment(identityId, platform, actionId) {
    const key = this._key(identityId, platform, actionId)
    const next = (this._counters.get(key) || 0) + 1
    this._counters.set(key, next)
    this._persist()
    return next
  }

  /**
   * Remove entries whose day is older than `daysOld` days (default 30).
   * Returns the number of entries purged.
   */
  purgeOldEntries(daysOld = 30) {
    const cutoff = this._dayKey(this.clock.now() - daysOld * 86_400_000)
    let removed = 0
    for (const key of Array.from(this._counters.keys())) {
      const parts = key.split('::')
      const day = parts[parts.length - 1]
      if (day < cutoff) {
        this._counters.delete(key)
        removed++
      }
    }
    if (removed > 0) this._persist()
    return removed
  }

  /**
   * Snapshot of all counters. If identityId given, filters to that
   * identity. Useful for UI display.
   */
  stats(identityId) {
    const out = {}
    for (const [key, count] of this._counters.entries()) {
      const [id, platform, action, day] = key.split('::')
      if (identityId && id !== identityId) continue
      out[key] = { identityId: id, platform, actionId: action, day, count }
    }
    return out
  }

  // ---------- internal ------------------------------------------------------

  _key(identityId, platform, actionId) {
    const day = this._dayKey(this.clock.now())
    return `${identityId}::${platform || '_'}::${actionId || '_'}::${day}`
  }

  _dayKey(epochMs) {
    const d = new Date(epochMs)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  _loadFromDisk() {
    if (!fs.existsSync(this.filePath)) return
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (_e) {
      // corrupt — start fresh
      return
    }
    if (!raw || raw.version !== SCHEMA_VERSION) return
    const counters = raw.counters || {}
    for (const [key, count] of Object.entries(counters)) {
      if (typeof count === 'number' && count >= 0) {
        this._counters.set(key, count)
      }
    }
  }

  _persist() {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const out = { version: SCHEMA_VERSION, counters: {} }
    for (const [key, count] of this._counters.entries()) {
      out.counters[key] = count
    }
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}

function _realClock() {
  return { now: () => Date.now() }
}

function _mergeCaps(base, overrides) {
  // Deep merge per platform — overrides[platform][action] beats base.
  const out = {}
  for (const platform of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    out[platform] = { ...(base[platform] || {}), ...(overrides[platform] || {}) }
  }
  return out
}

module.exports = {
  BulkRateLimit,
  DEFAULT_CAPS,
  SCHEMA_VERSION,
}
