// OZ Browser — Device Info (Bloque D-1.1).
//
// Qué hace: identifica unívocamente esta instalación de OZ Browser para que
// el cloud backup (Dropbox) y futuras features cross-device puedan rutear
// snapshots a una carpeta dedicada por device sin colisionar.
//
// Doc: docs/modules/device-info.md
// ADR: docs/architecture/0025-cloud-backup.md (pendiente — sale en D-1.8)
//
// Output persistido (idempotente):
//   userData/device-info.json
//   {
//     "uuid": "a1b2c3d4-...-...-...",  // UUID v4, generado al primer boot
//     "shortId": "a1b2c3d4",           // primeros 8 chars del UUID (sin dashes)
//     "hostname": "Jose's MacBook Pro", // os.hostname() raw, para mostrar al user
//     "hostnameSlug": "joses-macbook-pro", // safe para path Dropbox
//     "deviceFolder": "joses-macbook-pro-a1b2c3d4", // `${hostnameSlug}-${shortId}`
//     "createdAt": "2026-05-10T22:00:00.000Z",
//     "schemaVersion": 1
//   }
//
// Por qué UUID + hostname (vs MAC address o hostname solo):
//   - macOS hace Private Address Randomization → MAC inestable, mala llave.
//   - Hostname solo colisiona si el user tiene dos Macs con el mismo nombre
//     (frecuente en team). UUID local resuelve.
//   - El UUID es local-only, NO se sube ni se loguea fuera del propio archivo
//     y del path Dropbox. No es un identificador para tracking.
//
// Lifecycle:
//   - Primera llamada a ensureDeviceInfo() genera + persiste.
//   - Subsiguientes llamadas leen del disco (idempotente).
//   - getDeviceInfo() es sync-cached (memoiza tras primer ensureDeviceInfo).
//
// Edge cases manejados:
//   - hostname con caracteres unicode/symbols → slug seguro [a-z0-9-]
//   - hostname vacío → fallback "device"
//   - hostname extra largo → truncado a 32 chars (path Dropbox tiene límite ~255
//     pero queremos folders cortos para listing legible)
//   - JSON corrupto → log + regenera (mismo trade-off que workspaces.json en 1.4)
//   - schemaVersion mismatch (futuro) → migration path
//
// Test inyectable: `injectHostname(fakeFn)` para tests determinísticos.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const osMod = require('os')
const log = require('./logger')

const DEVICE_INFO_FILENAME = 'device-info.json'
const SCHEMA_VERSION = 1
const MAX_SLUG_LENGTH = 32

let _hostnameFn = () => osMod.hostname()

/**
 * Override the hostname source. For tests only.
 */
function injectHostname(fn) {
  _hostnameFn = typeof fn === 'function' ? fn : () => osMod.hostname()
}

/**
 * Slugify a hostname into a Dropbox-path-safe identifier.
 *   "Jose's MacBook Pro"   → "joses-macbook-pro"
 *   "ALPHA NUM 123 !!"     → "alpha-num-123"
 *   "🎉 emoji host 🎉"     → "emoji-host"
 *   ""                     → "device"
 *   "a".repeat(100)        → first 32 chars
 */
function slugifyHostname(raw) {
  if (typeof raw !== 'string') raw = ''
  let s = raw
    .normalize('NFKD') // decompose accented chars
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    // Strip joining punctuation FIRST so "jose's" → "joses" (not "jose-s")
    .replace(/['’‘"“”`]/g, '')
    .replace(/[^a-z0-9]+/g, '-') // anything not alnum → dash
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .replace(/-{2,}/g, '-') // collapse multi-dash
  if (s.length === 0) s = 'device'
  if (s.length > MAX_SLUG_LENGTH) s = s.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '')
  return s
}

/**
 * Extract short id from UUID: primeros 8 hex chars (sin dashes).
 *   "a1b2c3d4-e5f6-7890-..." → "a1b2c3d4"
 */
function _shortIdFromUuid(uuid) {
  return uuid.replace(/-/g, '').slice(0, 8)
}

function _generateUuid() {
  // crypto.randomUUID disponible en Node 14.17+. Si por algún motivo no lo
  // está (no debería con Node 26), fallback a randomBytes manual.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  // RFC 4122 v4: set version + variant bits
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  )
}

function _buildFresh() {
  const hostname = _hostnameFn() || ''
  const hostnameSlug = slugifyHostname(hostname)
  const uuid = _generateUuid()
  const shortId = _shortIdFromUuid(uuid)
  return {
    uuid,
    shortId,
    hostname,
    hostnameSlug,
    deviceFolder: `${hostnameSlug}-${shortId}`,
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  }
}

function _filePath(userDataDir) {
  return path.join(userDataDir, DEVICE_INFO_FILENAME)
}

function _isValid(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof obj.uuid !== 'string' || obj.uuid.length < 32) return false
  if (typeof obj.shortId !== 'string' || obj.shortId.length !== 8) return false
  if (typeof obj.deviceFolder !== 'string' || obj.deviceFolder.length < 2) return false
  if (typeof obj.schemaVersion !== 'number') return false
  return true
}

/**
 * Read device-info from disk if present + valid. Returns null otherwise.
 */
function _readFromDisk(userDataDir) {
  const fp = _filePath(userDataDir)
  let raw
  try {
    raw = fs.readFileSync(fp, 'utf-8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('device-info', 'read error (treating as fresh)', { error: err.message })
    }
    return null
  }
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (err) {
    log.warn('device-info', 'corrupt JSON — will regenerate', { error: err.message })
    return null
  }
  if (!_isValid(obj)) {
    log.warn('device-info', 'invalid shape — will regenerate', {
      has: Object.keys(obj || {}),
    })
    return null
  }
  return obj
}

function _writeToDisk(userDataDir, info) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const fp = _filePath(userDataDir)
  const tmp = fp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf-8')
  fs.renameSync(tmp, fp)
}

/**
 * Factory. Returns an instance scoped to a userData dir.
 *
 * Usage en main.js:
 *   const deviceInfo = createDeviceInfo({ userDataDir: app.getPath('userData') })
 *   deviceInfo.ensureDeviceInfo()
 *   const info = deviceInfo.getDeviceInfo()
 */
function createDeviceInfo({ userDataDir }) {
  if (typeof userDataDir !== 'string' || !userDataDir) {
    throw new Error('createDeviceInfo: userDataDir required')
  }
  let cached = null

  function ensureDeviceInfo() {
    if (cached) return cached
    const existing = _readFromDisk(userDataDir)
    if (existing) {
      cached = existing
      return cached
    }
    const fresh = _buildFresh()
    _writeToDisk(userDataDir, fresh)
    log.info('device-info', 'first-boot device record created', {
      shortId: fresh.shortId,
      deviceFolder: fresh.deviceFolder,
    })
    cached = fresh
    return cached
  }

  function getDeviceInfo() {
    if (!cached) return ensureDeviceInfo()
    return cached
  }

  function reload() {
    cached = null
    return ensureDeviceInfo()
  }

  return {
    ensureDeviceInfo,
    getDeviceInfo,
    reload,
    // Path accessor para que cloud-backup-manager arme paths consistentes
    getDeviceFolder: () => getDeviceInfo().deviceFolder,
  }
}

module.exports = {
  createDeviceInfo,
  // Helpers exportados para tests
  slugifyHostname,
  injectHostname,
  DEVICE_INFO_FILENAME,
  SCHEMA_VERSION,
  MAX_SLUG_LENGTH,
  _shortIdFromUuid,
  _generateUuid,
  _isValid,
}
