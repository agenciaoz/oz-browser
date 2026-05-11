// OZ Browser — Team Identity (Bloque E-2).
//
// X25519 keypair per OZ install + memberId UUID. Used by team mode to:
//   - Identify this device within a team (memberId).
//   - Receive wrapped master keys from the team owner (ECIES, see team-keystore).
//   - Provide own publicKey so other devices can wrap things FOR this device.
//
// Doc: docs/modules/team-identity.md
// ADR: docs/architecture/0027-team-mode.md
//
// Storage layout:
//   userData/team-identity.json:
//     {
//       "memberId": "uuid",
//       "publicKey": "base64url-32",
//       "createdAt": "ISO",
//       "schemaVersion": 1
//     }
//   macOS Keychain (via @napi-rs/keyring):
//     service:  "oz-browser-team"
//     account:  memberId (UUID)
//     password: privateKey as base64url-32 chars
//
// Why memberId (UUID) instead of deviceFolder (from device-info.js):
//   deviceFolder slugifies hostname → changes if user renames Mac → unstable
//   as a team-membership identifier. memberId is UUID v4 set once at first
//   team interaction; persists across hostname changes + Mac upgrades.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const log = require('./logger')

const KEYCHAIN_SERVICE = 'oz-browser-team'
const IDENTITY_FILENAME = 'team-identity.json'
const SCHEMA_VERSION = 1

// Lazy require so tests can swap via inject.
let _curvesMod = null
function _curves() {
  if (_curvesMod) return _curvesMod
  _curvesMod = require('@noble/curves/ed25519.js')
  return _curvesMod
}
function injectCurves(fake) {
  _curvesMod = fake || null
}

// Same Keychain inject pattern as oauth-helper for testability.
let _keyringMod = null
function _keyring() {
  if (_keyringMod) return _keyringMod
  _keyringMod = require('@napi-rs/keyring')
  return _keyringMod
}
function injectKeyring(fake) {
  _keyringMod = fake || null
}
function _entry(account) {
  const { Entry } = _keyring()
  return new Entry(KEYCHAIN_SERVICE, account)
}

// ---------- base64url helpers ----------

function _b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function _b64urlDecode(str) {
  if (typeof str !== 'string') throw new Error('base64url decode: expected string')
  const pad = str.length % 4
  if (pad) str += '='.repeat(4 - pad)
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// ---------- keypair generation ----------

/**
 * Generate a fresh X25519 keypair. Returns { privateKey: Buffer(32), publicKey: Buffer(32) }.
 * Private key is a uniformly random 32-byte secret; public key is its X25519 mapping.
 */
function generateTeamKeypair() {
  const { x25519 } = _curves()
  const privateKey = Buffer.from(x25519.utils.randomSecretKey())
  const publicKey = Buffer.from(x25519.getPublicKey(privateKey))
  if (privateKey.length !== 32 || publicKey.length !== 32) {
    throw new Error(
      `generateTeamKeypair: unexpected key sizes priv=${privateKey.length} pub=${publicKey.length}`,
    )
  }
  return { privateKey, publicKey }
}

// ---------- file I/O ----------

function _filePath(userDataDir) {
  return path.join(userDataDir, IDENTITY_FILENAME)
}

function _isValid(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof obj.memberId !== 'string' || obj.memberId.length < 16) return false
  if (typeof obj.publicKey !== 'string' || obj.publicKey.length < 40) return false
  if (typeof obj.schemaVersion !== 'number') return false
  return true
}

function _readFromDisk(userDataDir) {
  try {
    const raw = fs.readFileSync(_filePath(userDataDir), 'utf-8')
    const obj = JSON.parse(raw)
    if (!_isValid(obj)) {
      log.warn('team-identity', 'on-disk shape invalid — regenerate', {
        keys: Object.keys(obj || {}),
      })
      return null
    }
    return obj
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('team-identity', 'disk read failed — regenerate', { message: err.message })
    }
    return null
  }
}

function _writeToDisk(userDataDir, info) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const fp = _filePath(userDataDir)
  const tmp = fp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf-8')
  fs.renameSync(tmp, fp)
}

function _genUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-' +
    h.slice(12, 16) +
    '-' +
    h.slice(16, 20) +
    '-' +
    h.slice(20, 32)
  )
}

// ---------- factory ----------

/**
 * Factory scoped to a userData dir.
 *
 * Usage en main.js / team-manager.js:
 *   const ti = createTeamIdentity({ userDataDir: app.getPath('userData') })
 *   const me = ti.ensureIdentity()      // { memberId, publicKey, createdAt }
 *   const priv = ti.getPrivateKey()     // Buffer(32) — from Keychain
 *   ti.clear()                          // wipe local identity (leave team flow)
 */
function createTeamIdentity({ userDataDir }) {
  if (typeof userDataDir !== 'string' || !userDataDir) {
    throw new Error('createTeamIdentity: userDataDir required')
  }
  let cached = null

  function _persistPrivKey(memberId, privateKey) {
    _entry(memberId).setPassword(_b64urlEncode(privateKey))
  }

  function _readPrivKey(memberId) {
    try {
      const raw = _entry(memberId).getPassword()
      if (!raw) return null
      return _b64urlDecode(raw)
    } catch (err) {
      log.warn('team-identity', 'private key read failed', { message: err.message })
      return null
    }
  }

  function _deletePrivKey(memberId) {
    try {
      _entry(memberId).deletePassword()
    } catch (err) {
      log.warn('team-identity', 'private key delete failed (may not exist)', {
        message: err.message,
      })
    }
  }

  /**
   * Returns the public identity record. First call generates + persists.
   * Idempotent: subsequent calls read from disk + return same memberId.
   *
   * If the file is on disk BUT the corresponding Keychain entry is missing
   * (e.g. user cleared Keychain manually), we treat the identity as fresh
   * and regenerate. UX: rare, but better than silently broken team join.
   */
  function ensureIdentity() {
    if (cached) return _publicView(cached)
    const existing = _readFromDisk(userDataDir)
    if (existing) {
      const priv = _readPrivKey(existing.memberId)
      if (priv && priv.length === 32) {
        cached = existing
        return _publicView(cached)
      }
      log.warn(
        'team-identity',
        'private key missing for existing memberId — regenerating',
        {
          memberId: existing.memberId,
        },
      )
    }
    const memberId = _genUuid()
    const { privateKey, publicKey } = generateTeamKeypair()
    _persistPrivKey(memberId, privateKey)
    const fresh = {
      memberId,
      publicKey: _b64urlEncode(publicKey),
      createdAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
    }
    _writeToDisk(userDataDir, fresh)
    log.info('team-identity', 'first-boot team identity created', {
      memberId,
      pubKeyPrefix: fresh.publicKey.slice(0, 8),
    })
    cached = fresh
    return _publicView(cached)
  }

  function _publicView(rec) {
    return {
      memberId: rec.memberId,
      publicKey: rec.publicKey, // base64url string (UI / disk friendly)
      createdAt: rec.createdAt,
    }
  }

  /**
   * Returns the private key as Buffer(32). Throws if identity not yet created.
   * The caller is responsible for treating the buffer as secret (don't log,
   * don't serialize). Keychain access still happens on every call — no
   * in-memory cache to limit exposure window.
   */
  function getPrivateKey() {
    if (!cached) ensureIdentity()
    const priv = _readPrivKey(cached.memberId)
    if (!priv) throw new Error('team-identity: private key missing from Keychain')
    return priv
  }

  /**
   * Returns the public key as Buffer(32) (decoded from disk).
   */
  function getPublicKey() {
    if (!cached) ensureIdentity()
    return _b64urlDecode(cached.publicKey)
  }

  /**
   * Wipe local team identity. Called on leaveTeam / disbandTeam. Removes
   * both the disk file and the Keychain private key. Generates a fresh
   * identity on next ensureIdentity() call.
   */
  function clear() {
    if (!cached) cached = _readFromDisk(userDataDir)
    if (cached) {
      _deletePrivKey(cached.memberId)
      try {
        fs.unlinkSync(_filePath(userDataDir))
      } catch (err) {
        if (err.code !== 'ENOENT') {
          log.warn('team-identity', 'disk file delete failed', { message: err.message })
        }
      }
      log.info('team-identity', 'team identity cleared', { memberId: cached.memberId })
    }
    cached = null
  }

  return {
    ensureIdentity,
    getPrivateKey,
    getPublicKey,
    clear,
    // Introspection only — no caching of underlying value beyond memberId.
    getMemberId: () => (cached || ensureIdentity()) && cached.memberId,
  }
}

module.exports = {
  createTeamIdentity,
  generateTeamKeypair,
  KEYCHAIN_SERVICE,
  IDENTITY_FILENAME,
  SCHEMA_VERSION,
  injectCurves,
  injectKeyring,
  // Internal helpers for tests
  _b64urlEncode,
  _b64urlDecode,
  _genUuid,
  _isValid,
}
