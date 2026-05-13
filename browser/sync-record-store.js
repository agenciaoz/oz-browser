// OZ Browser — Sync Record Store (D-3a CORE).
//
// Encrypt/decrypt sync records using the vault's master key + AES-256-GCM.
// Mirrors the on-disk format used by backup-manager.js (D-1) for consistency:
//
//   [headerLen u32 LE][headerJson UTF-8][iv 12B][authTag 16B][ciphertext]
//
// Header is visible to listFolder/getMetadata callers (Dropbox sees
// schemaVersion, updatedAt, deviceFolder, recordType, recordId, deleted) so
// the sync engine can decide what to pull without decrypting all payloads.
// Body (the actual identity/workspace JSON) is ciphered. authTag (AES-GCM)
// guarantees tampering detection on any byte of either header or body.
//
// Spec: docs/architecture/0026-sync-engine.md §7 (encryption format).
//
// Consumer: browser/sync-engine.js (D-3b/c) calls encodeRecord() before
// upload and decodeRecord() after download.

'use strict'

const crypto = require('crypto')
const { assertValidHeader } = require('./sync-merge')

const IV_BYTES = 12
const AUTHTAG_BYTES = 16
const HEADER_LEN_BYTES = 4
// Sanity caps so a pathological input cannot trigger giant Buffer allocs.
// Real identity records are ~1KB; 5MB leaves room for future schema growth
// without enabling DoS by malformed/oversized blobs.
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024

class SyncRecordStoreError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'SyncRecordStoreError'
  }
}

function _assertKey(key) {
  if (!Buffer.isBuffer(key)) {
    throw new SyncRecordStoreError('master key must be a Buffer', 'BAD_KEY')
  }
  if (key.length !== 32) {
    throw new SyncRecordStoreError(
      `master key must be 32 bytes (got ${key.length})`,
      'BAD_KEY',
    )
  }
}

function _validateHeader(header) {
  try {
    assertValidHeader(header)
  } catch (err) {
    throw new SyncRecordStoreError(err.message, 'HEADER_INVALID')
  }
}

/**
 * Encode a sync record into a self-contained Buffer ready to upload.
 *
 * The body is `null` for tombstones (header.deleted === true). For all other
 * records, body must be a plain JSON-serializable object.
 *
 * @param {Buffer} masterKey  32-byte AES-256-GCM key (from Vault.getMasterKey())
 * @param {object} header     see ADR 0026 §3+§7
 * @param {object|null} body  the record payload (identity/workspace JSON) or
 *                            null when header.deleted === true (tombstone).
 * @returns {Buffer}
 */
function encodeRecord(masterKey, header, body) {
  _assertKey(masterKey)
  _validateHeader(header)

  if (header.deleted) {
    if (body !== null && body !== undefined) {
      // Tombstones shouldn't carry a body. Strict to surface accidents
      // early — otherwise a stale body would leak post-delete metadata.
      throw new SyncRecordStoreError(
        'tombstone records must not carry a body (pass null)',
        'TOMBSTONE_HAS_BODY',
      )
    }
  } else if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new SyncRecordStoreError(
      'non-tombstone records require a non-null plain object body',
      'MISSING_BODY',
    )
  }

  const headerJson = Buffer.from(JSON.stringify(header), 'utf-8')
  if (headerJson.length > MAX_HEADER_BYTES) {
    throw new SyncRecordStoreError(
      `header JSON exceeds ${MAX_HEADER_BYTES} bytes`,
      'HEADER_TOO_LARGE',
    )
  }
  const headerLen = Buffer.alloc(HEADER_LEN_BYTES)
  headerLen.writeUInt32LE(headerJson.length, 0)

  // Tombstones encode an empty `{}` body cipher so the file layout is
  // always uniform — decoder normalizes back to null.
  const plaintext = Buffer.from(JSON.stringify(body || {}), 'utf-8')
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  const out = Buffer.concat([headerLen, headerJson, iv, authTag, ciphertext])
  if (out.length > MAX_PAYLOAD_BYTES) {
    throw new SyncRecordStoreError(
      `encoded record exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      'PAYLOAD_TOO_LARGE',
    )
  }
  return out
}

/**
 * Decode a Buffer previously produced by encodeRecord().
 *
 * @param {Buffer} masterKey
 * @param {Buffer} buffer
 * @returns {{header: object, body: object|null}}
 *   body is `null` for tombstones (the encoded empty-object body is folded).
 * @throws SyncRecordStoreError on tampering / wrong key / malformed input.
 */
function decodeRecord(masterKey, buffer) {
  _assertKey(masterKey)
  if (!Buffer.isBuffer(buffer)) {
    throw new SyncRecordStoreError('buffer must be a Buffer', 'BAD_INPUT')
  }
  if (buffer.length > MAX_PAYLOAD_BYTES) {
    throw new SyncRecordStoreError(
      `buffer exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      'PAYLOAD_TOO_LARGE',
    )
  }
  if (buffer.length < HEADER_LEN_BYTES + IV_BYTES + AUTHTAG_BYTES) {
    throw new SyncRecordStoreError(
      'buffer too small to contain a record',
      'BUFFER_TOO_SMALL',
    )
  }

  const headerLen = buffer.readUInt32LE(0)
  if (headerLen <= 0 || headerLen > MAX_HEADER_BYTES) {
    throw new SyncRecordStoreError(
      `headerLen out of range (got ${headerLen})`,
      'BAD_HEADER_LEN',
    )
  }
  const minRequired = HEADER_LEN_BYTES + headerLen + IV_BYTES + AUTHTAG_BYTES
  if (buffer.length < minRequired) {
    throw new SyncRecordStoreError(
      `buffer truncated (need ${minRequired} bytes, got ${buffer.length})`,
      'TRUNCATED',
    )
  }

  let header
  try {
    header = JSON.parse(
      buffer.slice(HEADER_LEN_BYTES, HEADER_LEN_BYTES + headerLen).toString('utf-8'),
    )
  } catch (err) {
    throw new SyncRecordStoreError(
      `header JSON parse failed: ${err.message}`,
      'HEADER_CORRUPT',
    )
  }
  _validateHeader(header)

  const ivStart = HEADER_LEN_BYTES + headerLen
  const tagStart = ivStart + IV_BYTES
  const ctStart = tagStart + AUTHTAG_BYTES
  const iv = buffer.slice(ivStart, tagStart)
  const authTag = buffer.slice(tagStart, ctStart)
  const ciphertext = buffer.slice(ctStart)

  let plaintext
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv)
    decipher.setAuthTag(authTag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new SyncRecordStoreError(
      `decrypt failed (wrong key, tampered ciphertext, or bad authTag): ${err.message}`,
      'DECRYPT_FAILED',
    )
  }

  let body
  try {
    body = JSON.parse(plaintext.toString('utf-8'))
  } catch (err) {
    throw new SyncRecordStoreError(
      `body JSON parse failed: ${err.message}`,
      'BODY_CORRUPT',
    )
  }

  // Tombstones encode {} for layout uniformity — surface as null to callers
  // so they don't special-case the empty body.
  if (
    header.deleted &&
    body &&
    typeof body === 'object' &&
    Object.keys(body).length === 0
  ) {
    body = null
  }
  return { header, body }
}

module.exports = {
  encodeRecord,
  decodeRecord,
  SyncRecordStoreError,
  IV_BYTES,
  AUTHTAG_BYTES,
  HEADER_LEN_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_HEADER_BYTES,
}
