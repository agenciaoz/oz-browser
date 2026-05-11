// OZ Browser — Team Keystore (Bloque E-3).
//
// ECIES wrap/unwrap del masterKey del vault para compartir entre team
// members. Reglas + amenazas en ADR 0027 §4 (Decision). Esta sub-pieza es
// solo crypto pura — la I/O Dropbox vive en team-manager.js (E-5).
//
// Doc: docs/modules/team-keystore.md
// ADR: docs/architecture/0027-team-mode.md
//
// Wrap protocol:
//   1. ephPriv = random 32 bytes
//   2. ephPub  = x25519.getPublicKey(ephPriv)
//   3. shared  = x25519.getSharedSecret(ephPriv, peerPub)   // 32 bytes
//   4. salt    = random 32 bytes
//   5. wrapKey = HKDF-SHA256(shared, salt, KEY_WRAP_INFO, 32 bytes)
//   6. iv      = random 12 bytes
//   7. ct,tag  = AES-256-GCM(wrapKey, iv, masterKey, aad=peerPub)
//   8. blob    = ephPub | salt | iv | tag | ct
//   sizes      = 32   + 32   + 12 + 16 + 32  = 124 bytes
//
// Unwrap (member side):
//   1. blob → [ephPub, salt, iv, tag, ct]
//   2. shared  = x25519.getSharedSecret(myPriv, ephPub)
//   3. wrapKey = HKDF-SHA256(shared, salt, KEY_WRAP_INFO, 32 bytes)
//   4. masterKey = AES-256-GCM-decrypt(wrapKey, iv, ct, tag, aad=myPub)
//
// Security properties:
//   - Forward secrecy: ephemeral keypair per wrap → leaked masterKey doesn't
//     compromise other wraps.
//   - AEAD with peerPub as AAD: a blob copied to a wrong member's slot in
//     Dropbox can't be successfully unwrapped → tampering detected.
//   - Domain separator KEY_WRAP_INFO prevents cross-protocol attacks.

const crypto = require('crypto')
const log = require('./logger')

const KEY_WRAP_VERSION = 1
const KEY_WRAP_INFO = Buffer.from('oz-browser-team-key-wrap-v1', 'utf-8')
const MASTER_KEY_LEN = 32
const PUB_KEY_LEN = 32
const PRIV_KEY_LEN = 32
const SHARED_SECRET_LEN = 32
const WRAP_KEY_LEN = 32
const IV_LEN = 12
const AUTH_TAG_LEN = 16
const SALT_LEN = 32
const BLOB_LEN = PUB_KEY_LEN + SALT_LEN + IV_LEN + AUTH_TAG_LEN + MASTER_KEY_LEN // 124

class KeystoreError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'KEYSTORE_ERROR'
  }
}

// ---------- curve injection (mirror team-identity) ----------

let _curvesMod = null
function _curves() {
  if (_curvesMod) return _curvesMod
  _curvesMod = require('@noble/curves/ed25519.js')
  return _curvesMod
}
function injectCurves(fake) {
  _curvesMod = fake || null
}

// ---------- HKDF-SHA256 ----------

/**
 * HKDF-SHA256 wrapper. Node 15+ provides `crypto.hkdfSync(digest, ikm, salt,
 * info, keylen)` which returns ArrayBuffer. We wrap into Buffer.
 */
function _hkdf(ikm, salt, info, keylen) {
  // crypto.hkdfSync returns ArrayBuffer in Node 18+, Buffer in some older.
  const out = crypto.hkdfSync('sha256', ikm, salt, info, keylen)
  return Buffer.from(out)
}

// ---------- core: wrap ----------

/**
 * Wrap a 32-byte masterKey for the given peer public key. Returns a 124-byte
 * Buffer that the peer (with their X25519 private key) can decrypt.
 *
 * Caller validates inputs first — we still defensive-check.
 */
function wrapMasterKey(peerPublicKey, masterKey, { rngBytes } = {}) {
  if (!Buffer.isBuffer(peerPublicKey) || peerPublicKey.length !== PUB_KEY_LEN) {
    throw new KeystoreError(`peerPublicKey must be Buffer(${PUB_KEY_LEN})`, 'BAD_ARG')
  }
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_LEN) {
    throw new KeystoreError(`masterKey must be Buffer(${MASTER_KEY_LEN})`, 'BAD_ARG')
  }
  const { x25519 } = _curves()
  const rand = rngBytes || ((n) => crypto.randomBytes(n))

  // Ephemeral keypair
  const ephPriv = rand(PRIV_KEY_LEN)
  if (!Buffer.isBuffer(ephPriv) || ephPriv.length !== PRIV_KEY_LEN) {
    throw new KeystoreError('rngBytes returned wrong length for ephPriv', 'BAD_RNG')
  }
  const ephPub = Buffer.from(x25519.getPublicKey(ephPriv))

  // X25519 ECDH
  const shared = Buffer.from(x25519.getSharedSecret(ephPriv, peerPublicKey))
  if (shared.length !== SHARED_SECRET_LEN) {
    throw new KeystoreError('shared secret unexpected length', 'BAD_SDK')
  }

  // KDF
  const salt = rand(SALT_LEN)
  const wrapKey = _hkdf(shared, salt, KEY_WRAP_INFO, WRAP_KEY_LEN)

  // AEAD encrypt
  const iv = rand(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv, {
    authTagLength: AUTH_TAG_LEN,
  })
  cipher.setAAD(peerPublicKey)
  const ct = Buffer.concat([cipher.update(masterKey), cipher.final()])
  const tag = cipher.getAuthTag()

  if (ct.length !== MASTER_KEY_LEN || tag.length !== AUTH_TAG_LEN) {
    throw new KeystoreError(
      `unexpected AES-GCM output (ct=${ct.length}, tag=${tag.length})`,
      'BAD_SDK',
    )
  }

  // Zeroize transient buffers — V8 GC doesn't guarantee, but explicit fill
  // limits the exposure window if the buffer is later inspected.
  shared.fill(0)
  wrapKey.fill(0)
  ephPriv.fill(0)

  return Buffer.concat([ephPub, salt, iv, tag, ct])
}

// ---------- core: unwrap ----------

/**
 * Unwrap a 124-byte blob using our private key. `ownPublicKey` MUST be the
 * public key that pairs with the private key (AES-GCM AAD must match what
 * was used at wrap time).
 *
 * Throws KeystoreError code 'AUTH_TAG_MISMATCH' if blob was tampered, was
 * intended for a different member, or the private key doesn't pair.
 */
function unwrapMasterKey(ownPrivateKey, ownPublicKey, blob) {
  if (!Buffer.isBuffer(ownPrivateKey) || ownPrivateKey.length !== PRIV_KEY_LEN) {
    throw new KeystoreError(`ownPrivateKey must be Buffer(${PRIV_KEY_LEN})`, 'BAD_ARG')
  }
  if (!Buffer.isBuffer(ownPublicKey) || ownPublicKey.length !== PUB_KEY_LEN) {
    throw new KeystoreError(`ownPublicKey must be Buffer(${PUB_KEY_LEN})`, 'BAD_ARG')
  }
  if (!Buffer.isBuffer(blob) || blob.length !== BLOB_LEN) {
    throw new KeystoreError(
      `blob must be Buffer(${BLOB_LEN}), got ${blob && blob.length}`,
      'BAD_BLOB',
    )
  }

  let off = 0
  const ephPub = blob.subarray(off, off + PUB_KEY_LEN)
  off += PUB_KEY_LEN
  const salt = blob.subarray(off, off + SALT_LEN)
  off += SALT_LEN
  const iv = blob.subarray(off, off + IV_LEN)
  off += IV_LEN
  const tag = blob.subarray(off, off + AUTH_TAG_LEN)
  off += AUTH_TAG_LEN
  const ct = blob.subarray(off, off + MASTER_KEY_LEN)

  const { x25519 } = _curves()
  const shared = Buffer.from(x25519.getSharedSecret(ownPrivateKey, ephPub))
  const wrapKey = _hkdf(shared, salt, KEY_WRAP_INFO, WRAP_KEY_LEN)

  let masterKey
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, iv, {
      authTagLength: AUTH_TAG_LEN,
    })
    decipher.setAuthTag(tag)
    decipher.setAAD(ownPublicKey)
    masterKey = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch (err) {
    log.warn('team-keystore', 'unwrap auth failed', { message: err.message })
    throw new KeystoreError(
      'Unwrap failed: wrong key, blob tampered, or wrong recipient',
      'AUTH_TAG_MISMATCH',
    )
  } finally {
    shared.fill(0)
    wrapKey.fill(0)
  }

  if (masterKey.length !== MASTER_KEY_LEN) {
    throw new KeystoreError('unwrapped output unexpected length', 'BAD_SDK')
  }
  return masterKey
}

module.exports = {
  wrapMasterKey,
  unwrapMasterKey,
  KeystoreError,
  KEY_WRAP_VERSION,
  KEY_WRAP_INFO,
  MASTER_KEY_LEN,
  PUB_KEY_LEN,
  PRIV_KEY_LEN,
  IV_LEN,
  AUTH_TAG_LEN,
  SALT_LEN,
  BLOB_LEN,
  injectCurves,
  // Internal exports for tests
  _hkdf,
}
