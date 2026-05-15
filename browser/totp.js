// OZ Browser — TOTP generator (J-3, v1.3.0).
//
// RFC 6238 Time-based One-Time Password generator. Pure, no external deps —
// uses Node's built-in crypto module only. Generates the same codes that
// Google Authenticator, Authy, 1Password, etc. produce.
//
// Por qué cero deps: agregar `otplib` u otra lib (incluso lightweight) suma
// surface attack y un dep que mantener. RFC 6238 + HMAC-SHA1 + base32 fit en
// ~80 LOC y se valida contra los test vectors del RFC.
//
// Algorithm:
//   1. Decode the user's secret from base32 (the format Authenticator apps
//      print/QR — RFC 4648 with A-Z and 2-7).
//   2. Compute counter T = floor((now() - T0) / X) where T0=0 and X=30 sec.
//   3. HMAC-SHA1(secret, big-endian 8-byte counter).
//   4. Dynamic truncation: take last 4 bits of the HMAC as offset O, then
//      4 bytes starting at O, mask the high bit, modulo 10^digits.
//   5. Pad to `digits` width with leading zeros (typically 6).
//
// Doc: docs/modules/totp.md
//
// Exports:
//   generateTotp(secret, opts) → 'NNNNNN'
//   decodeBase32(s) → Buffer
//   _hotp(secret, counter, digits) → 'NNNNNN'   (internal, exposed for tests)

const crypto = require('crypto')

const DEFAULT_DIGITS = 6
const DEFAULT_STEP_SEC = 30
const DEFAULT_T0_SEC = 0

/**
 * Generate a TOTP code for the given base32 secret.
 *
 * @param {string} secretBase32 - base32-encoded secret, with or without
 *   spaces / lowercase. Standard format Authenticator apps display.
 * @param {object} [opts]
 * @param {number} [opts.digits=6] - code length (Google Authenticator uses 6).
 * @param {number} [opts.stepSec=30] - time window in seconds.
 * @param {number} [opts.t0Sec=0] - Unix epoch offset (typically 0).
 * @param {number} [opts.nowMs=Date.now()] - injectable for tests.
 * @returns {string} - zero-padded numeric code.
 */
function generateTotp(secretBase32, opts = {}) {
  const digits = opts.digits || DEFAULT_DIGITS
  const stepSec = opts.stepSec || DEFAULT_STEP_SEC
  const t0Sec = opts.t0Sec != null ? opts.t0Sec : DEFAULT_T0_SEC
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now()
  const counter = Math.floor((Math.floor(nowMs / 1000) - t0Sec) / stepSec)
  const secret = decodeBase32(secretBase32)
  return _hotp(secret, counter, digits)
}

/**
 * Decode an RFC 4648 base32 string into a Buffer. Tolerates whitespace and
 * lowercase. Padding chars (=) accepted but not required.
 *
 * @param {string} s
 * @returns {Buffer}
 */
function decodeBase32(s) {
  if (typeof s !== 'string') {
    throw new Error('totp.decodeBase32: string required')
  }
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = s.toUpperCase().replace(/[\s=]+/g, '')
  if (!clean) return Buffer.alloc(0)
  if (!/^[A-Z2-7]+$/.test(clean)) {
    throw new Error('totp.decodeBase32: invalid base32 characters')
  }
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * Compute an HOTP code given a binary secret + 8-byte counter encoded.
 * @param {Buffer} secret
 * @param {number} counter
 * @param {number} digits
 * @returns {string}
 */
function _hotp(secret, counter, digits) {
  // Encode counter as big-endian 8-byte buffer. Node Bigint avoids precision
  // loss for counters > 2^32.
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest()
  // Dynamic truncation per RFC 4226 §5.3.
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const modulus = Math.pow(10, digits)
  return String(code % modulus).padStart(digits, '0')
}

module.exports = {
  generateTotp,
  decodeBase32,
  _hotp,
  DEFAULT_DIGITS,
  DEFAULT_STEP_SEC,
}
