// OZ Browser — Ghost Browser crypto (G-2a).
//
// Decryption of Chromium / Ghost Browser encrypted_value blobs on macOS.
// Pure module — no Electron deps. Keychain access via injectable exec dep
// so tests don't hit the real Keychain.
//
// Algorithm (Chromium standard on macOS, inherited by Ghost):
//   1. Fetch safe-storage key from macOS Keychain entry:
//        service = "Ghost Browser Safe Storage", account = "Ghost Browser"
//      Implementation: `security find-generic-password -s <s> -a <a> -w`.
//      First invocation triggers macOS access dialog. User clicks Allow.
//   2. Derive AES key:
//        key = PBKDF2(safeStorageKey, salt="saltysalt", iter=1003, len=16)
//      Algorithm: HMAC-SHA1.
//   3. Strip "v10" or "v11" prefix from blob (first 3 bytes).
//   4. Decrypt with AES-128-CBC, IV = 16 bytes of 0x20 (ASCII space).
//   5. Strip PKCS#7 padding from result.
//
// Notes:
//   - Cookies in Chrome 80+ are usually v10. Some Ghost values may be older
//     (v11 used for the account-bound profile sync). Reader returns all
//     encrypted_value blobs as-is; this module checks the prefix.
//   - Unencrypted cookies (rare, older Chrome) have NO v10/v11 prefix and
//     the cookie's `value` column is populated instead. Reader exposes both.
//   - For password rows, `password_value` follows the same v10/v11 format.

const crypto = require('crypto')

const KEYCHAIN_SERVICE = 'Ghost Browser Safe Storage'
const KEYCHAIN_ACCOUNT = 'Ghost Browser'
const PBKDF2_SALT = Buffer.from('saltysalt')
const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEYLEN = 16 // AES-128
const PBKDF2_DIGEST = 'sha1'
const AES_IV = Buffer.alloc(16, 0x20) // 16 bytes of ASCII space
const SUPPORTED_PREFIXES = ['v10', 'v11']

// Default exec runner uses Node's child_process. Tests inject a fake.
function _defaultExec(cmd, args) {
  const { spawnSync } = require('child_process')
  const res = spawnSync(cmd, args, { encoding: 'utf8' })
  if (res.error) throw res.error
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

// fetchGhostKeychainKey({ exec? }) → Promise<string>
// Returns the safe-storage key from macOS Keychain. First call triggers
// access dialog. Returns key as a UTF-8 string (typically base64-encoded
// bytes but treated as opaque by the PBKDF2 step).
//
// Throws GhostCryptoError with code:
//   - 'KEYCHAIN_DENIED' if user denies access (security exits non-zero with
//     "User canceled the operation." in stderr)
//   - 'KEYCHAIN_NOT_FOUND' if the entry does not exist (Ghost not installed
//     or never opened)
//   - 'KEYCHAIN_FAILURE' for other failures
async function fetchGhostKeychainKey(opts = {}) {
  const exec = opts.exec || _defaultExec
  const args = [
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT,
    '-w',
  ]
  let res
  try {
    res = await exec('security', args)
  } catch (err) {
    throw new GhostCryptoError(
      `security command failed: ${err.message}`,
      'KEYCHAIN_FAILURE',
    )
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim()
    if (/canceled|cancelled/i.test(stderr)) {
      throw new GhostCryptoError(
        'User denied Keychain access for "Ghost Browser Safe Storage"',
        'KEYCHAIN_DENIED',
      )
    }
    if (/could not be found|not found/i.test(stderr)) {
      throw new GhostCryptoError(
        'Keychain entry "Ghost Browser Safe Storage" not found — Ghost Browser may not be installed',
        'KEYCHAIN_NOT_FOUND',
      )
    }
    throw new GhostCryptoError(
      `security exited with status ${res.status}: ${stderr}`,
      'KEYCHAIN_FAILURE',
    )
  }
  // security -w prints the password followed by a newline.
  return (res.stdout || '').replace(/\n$/, '')
}

// deriveKey(safeStorageKey) → Buffer(16)
// PBKDF2-HMAC-SHA1 with Chromium-standard params.
function deriveKey(safeStorageKey) {
  const passphrase =
    typeof safeStorageKey === 'string'
      ? Buffer.from(safeStorageKey, 'utf8')
      : safeStorageKey
  return crypto.pbkdf2Sync(
    passphrase,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  )
}

// _prefixOf(blob) → "v10" | "v11" | null
function _prefixOf(blob) {
  if (!blob || blob.length < 3) return null
  const head = String.fromCharCode(blob[0], blob[1], blob[2])
  return SUPPORTED_PREFIXES.includes(head) ? head : null
}

// decryptBlob(blob, derivedKey, { strict? }) → string
// blob: Uint8Array | Buffer with v10/v11 prefix + AES-CBC ciphertext.
// derivedKey: 16-byte Buffer (from deriveKey()).
// strict: if true (default), unknown/missing prefix throws. If false, blob
//   without a prefix is treated as unencrypted-but-empty (returns '').
//
// Returns the plaintext string (UTF-8 decoded).
function decryptBlob(blob, derivedKey, opts = {}) {
  const strict = opts.strict !== false
  if (!blob) return ''
  // Coerce Uint8Array → Buffer view (no copy).
  const buf = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)

  const prefix = _prefixOf(buf)
  if (!prefix) {
    if (strict) {
      throw new GhostCryptoError(
        `Blob has no recognized prefix (got ${buf.slice(0, 3).toString('hex')})`,
        'BAD_PREFIX',
      )
    }
    return ''
  }

  const ciphertext = buf.slice(3)
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new GhostCryptoError(
      `Ciphertext length ${ciphertext.length} is not a multiple of 16`,
      'BAD_CIPHERTEXT_LEN',
    )
  }

  const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, AES_IV)
  decipher.setAutoPadding(true)
  let plain
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new GhostCryptoError(
      `AES-128-CBC decryption failed: ${err.message}`,
      'DECRYPT_FAILED',
    )
  }
  return plain.toString('utf8')
}

// decryptCookies(cookies, derivedKey, opts?) → cookies with value_plaintext
// For each cookie row from reader.readIdentity(): if encrypted_value has a
// recognized prefix, decrypt and attach value_plaintext. If the row has a
// non-empty `value` column (old unencrypted format), preserve it as
// value_plaintext. Decryption errors per-row are caught — failed cookies
// get value_plaintext=null and an error field.
function decryptCookies(cookies, derivedKey, opts = {}) {
  return cookies.map((c) => {
    // Old unencrypted cookies: value column is the plaintext.
    if (c.value && (!c.encrypted_value || c.encrypted_value.length === 0)) {
      return { ...c, value_plaintext: c.value, _decryptError: null }
    }
    try {
      const plain = decryptBlob(c.encrypted_value, derivedKey, opts)
      return { ...c, value_plaintext: plain, _decryptError: null }
    } catch (err) {
      return { ...c, value_plaintext: null, _decryptError: err.code || 'UNKNOWN' }
    }
  })
}

// decryptPasswords(logins, derivedKey, opts?) → logins with password_plaintext
function decryptPasswords(logins, derivedKey, opts = {}) {
  return logins.map((l) => {
    try {
      const plain = decryptBlob(l.password_value, derivedKey, opts)
      return { ...l, password_plaintext: plain, _decryptError: null }
    } catch (err) {
      return {
        ...l,
        password_plaintext: null,
        _decryptError: err.code || 'UNKNOWN',
      }
    }
  })
}

// encryptBlobForTest(plaintext, derivedKey, prefix='v10') → Buffer
// Used ONLY by tests to generate synthetic Ghost-format encrypted blobs.
// NOT exported in the public API; consumers should never call this.
function _encryptBlobForTest(plaintext, derivedKey, prefix = 'v10') {
  const cipher = crypto.createCipheriv('aes-128-cbc', derivedKey, AES_IV)
  const enc = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from(prefix, 'utf8'), enc])
}

class GhostCryptoError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'GhostCryptoError'
    this.code = code
  }
}

module.exports = {
  fetchGhostKeychainKey,
  deriveKey,
  decryptBlob,
  decryptCookies,
  decryptPasswords,
  GhostCryptoError,
  // constants exposed for tests / debug:
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  SUPPORTED_PREFIXES,
  // test-only:
  _encryptBlobForTest,
}
