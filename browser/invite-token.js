// OZ Browser — Team invite token (Bloque E-4).
//
// Codifica los metadatos públicos de un invite del owner para que el member
// pueda iniciar el flujo de join: identificar el team, cross-check la public
// key del owner contra el folder shared en Dropbox, y descartar invites
// expirados.
//
// Doc: docs/modules/invite-token.md
// ADR: docs/architecture/0027-team-mode.md §7
//
// Formato lógico (JSON luego base64url):
//   {
//     "v": 1,                       // schemaVersion
//     "teamId": "uuid",             // identifica el team
//     "ownerMemberId": "uuid",      // pub key del owner busca en /team/members/<id>.pub
//     "ownerPublicKey": "b64u-32",  // duplicado en el token para cross-check
//     "expiresAt": "ISO",           // typically 24h from gen
//     "nonce": "b64u-16"            // replay defense
//   }
//
// URL: oz://team/invite?token=<base64url-of-JSON>
//
// Threat model v1 (más detalle en ADR 0027 §11): token NO está firmado.
// Trust anchor: la public key del owner está EN el token Y publicada en el
// Dropbox shared folder bajo `/team/members/<ownerMemberId>.pub`. El member,
// al aceptar, descarga ese archivo + valida que matche el token. Sin acceso
// al shared folder (que el owner controla), un atacante con el link no
// puede falsificar la public key con éxito.
//
// v2 podría firmar el token con Ed25519 del owner para auth aun sin acceso
// al folder.

const crypto = require('crypto')

const TOKEN_SCHEMA_VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const NONCE_LEN = 16
const URL_BASE = 'oz://team/invite'

class InviteTokenError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'INVITE_TOKEN_ERROR'
  }
}

// ---------- base64url helpers ----------

function _b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function _b64urlDecode(str) {
  if (typeof str !== 'string') {
    throw new InviteTokenError('base64url decode: expected string', 'BAD_ARG')
  }
  const pad = str.length % 4
  if (pad) str += '='.repeat(4 - pad)
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// ---------- validation ----------

function _isUuid(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  )
}

function _isB64url(s, minLen = 1) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length >= minLen
}

function _isIso(s) {
  if (typeof s !== 'string') return false
  const t = Date.parse(s)
  return !Number.isNaN(t)
}

/**
 * Returns true if obj has the expected shape for a v1 token. Does NOT check
 * expiry — see isExpired() separately.
 */
function isValidShape(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (obj.v !== TOKEN_SCHEMA_VERSION) return false
  if (!_isUuid(obj.teamId)) return false
  if (!_isUuid(obj.ownerMemberId)) return false
  // Owner public key: 32 bytes → base64url 43 chars (without padding)
  if (!_isB64url(obj.ownerPublicKey, 40)) return false
  if (!_isIso(obj.expiresAt)) return false
  if (!_isB64url(obj.nonce, 16)) return false
  return true
}

function isExpired(obj, { now } = {}) {
  if (!_isIso(obj.expiresAt)) return true
  const t = Date.parse(obj.expiresAt)
  return (now || Date.now()) >= t
}

// ---------- generate ----------

/**
 * Build a v1 invite token.
 *
 * @param {object} opts
 * @param {string} opts.teamId         UUID v4
 * @param {string} opts.ownerMemberId  UUID v4
 * @param {Buffer|string} opts.ownerPublicKey  32 bytes (Buffer) OR base64url
 * @param {number} [opts.ttlMs]        default 24h
 * @param {number} [opts.now]          inject for tests
 * @returns {{ token, tokenObj, url }}
 */
function generateInviteToken(opts) {
  if (!opts) throw new InviteTokenError('opts required', 'BAD_ARG')
  if (!_isUuid(opts.teamId)) throw new InviteTokenError('teamId must be UUID', 'BAD_ARG')
  if (!_isUuid(opts.ownerMemberId)) {
    throw new InviteTokenError('ownerMemberId must be UUID', 'BAD_ARG')
  }
  let pubB64
  if (Buffer.isBuffer(opts.ownerPublicKey)) {
    if (opts.ownerPublicKey.length !== 32) {
      throw new InviteTokenError('ownerPublicKey buffer must be 32 bytes', 'BAD_ARG')
    }
    pubB64 = _b64urlEncode(opts.ownerPublicKey)
  } else if (typeof opts.ownerPublicKey === 'string') {
    if (!_isB64url(opts.ownerPublicKey, 40)) {
      throw new InviteTokenError('ownerPublicKey string not base64url-32', 'BAD_ARG')
    }
    pubB64 = opts.ownerPublicKey
  } else {
    throw new InviteTokenError('ownerPublicKey required', 'BAD_ARG')
  }
  const ttlMs =
    typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const expiresAt = new Date(now + ttlMs).toISOString()
  const nonce = _b64urlEncode(crypto.randomBytes(NONCE_LEN))
  const tokenObj = {
    v: TOKEN_SCHEMA_VERSION,
    teamId: opts.teamId,
    ownerMemberId: opts.ownerMemberId,
    ownerPublicKey: pubB64,
    expiresAt,
    nonce,
  }
  const json = JSON.stringify(tokenObj)
  const token = _b64urlEncode(Buffer.from(json, 'utf-8'))
  const url = `${URL_BASE}?token=${token}`
  return { token, tokenObj, url }
}

// ---------- parse ----------

/**
 * Parse a token string (the base64url part). Throws if shape invalid.
 * Caller should run isExpired() separately to surface a user-facing
 * "this invite expired" message distinct from "invalid".
 *
 * Returns the parsed object (same shape as tokenObj from generate).
 */
function parseInviteToken(tokenStr) {
  if (typeof tokenStr !== 'string' || tokenStr.length === 0) {
    throw new InviteTokenError('token must be non-empty string', 'BAD_ARG')
  }
  let bytes
  try {
    bytes = _b64urlDecode(tokenStr)
  } catch (err) {
    throw new InviteTokenError(
      `token base64url decode failed: ${err.message}`,
      'BAD_FORMAT',
    )
  }
  let obj
  try {
    obj = JSON.parse(bytes.toString('utf-8'))
  } catch (err) {
    throw new InviteTokenError(`token JSON parse failed: ${err.message}`, 'BAD_FORMAT')
  }
  if (!isValidShape(obj)) {
    throw new InviteTokenError('token shape invalid for v1', 'BAD_SHAPE')
  }
  return obj
}

/**
 * Convenience: extract the token param from `oz://team/invite?token=XXX`.
 * Returns the token string OR throws if the URL is not the expected scheme.
 */
function extractTokenFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new InviteTokenError('url must be string', 'BAD_ARG')
  }
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (err) {
    throw new InviteTokenError(`URL parse failed: ${err.message}`, 'BAD_FORMAT')
  }
  if (parsed.protocol !== 'oz:') {
    throw new InviteTokenError('expected oz:// scheme', 'BAD_SCHEME')
  }
  const expectedPath = `${URL_BASE.replace('oz://', '')}` // 'team/invite'
  const got = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '')
  if (got !== expectedPath) {
    throw new InviteTokenError(`expected team/invite path, got: ${got}`, 'BAD_PATH')
  }
  const token = parsed.searchParams.get('token')
  if (!token) throw new InviteTokenError('missing ?token= query param', 'MISSING_TOKEN')
  return token
}

module.exports = {
  generateInviteToken,
  parseInviteToken,
  extractTokenFromUrl,
  isValidShape,
  isExpired,
  InviteTokenError,
  TOKEN_SCHEMA_VERSION,
  DEFAULT_TTL_MS,
  URL_BASE,
  NONCE_LEN,
  // Internal helpers for tests
  _b64urlEncode,
  _b64urlDecode,
  _isUuid,
  _isB64url,
  _isIso,
}
