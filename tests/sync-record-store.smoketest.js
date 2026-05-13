// OZ Browser — Sync Record Store smoke test (D-3a CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-record-store.smoketest.js
//
// Cubre:
//   - round-trip encode/decode (identity-shaped body)
//   - round-trip with deleted=true tombstone (null body)
//   - tampering: flip a byte in ciphertext → DECRYPT_FAILED
//   - tampering: flip a byte in authTag → DECRYPT_FAILED
//   - wrong key → DECRYPT_FAILED
//   - bad inputs: non-Buffer key, wrong-length key, non-Buffer buffer
//   - corrupt header JSON → HEADER_CORRUPT
//   - invalid header (missing fields) → HEADER_INVALID
//   - truncated buffer → BUFFER_TOO_SMALL / TRUNCATED / DECRYPT_FAILED
//   - tombstone with body throws TOMBSTONE_HAS_BODY
//   - non-tombstone with null body throws MISSING_BODY
//   - large body (10KB) round-trip
//   - distinct IV across calls (probabilistic)

'use strict'

const crypto = require('crypto')
const {
  encodeRecord,
  decodeRecord,
  SyncRecordStoreError,
  IV_BYTES,
  AUTHTAG_BYTES,
  HEADER_LEN_BYTES,
} = require('../browser/sync-record-store')

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

function throwsWithCode(label, fn, code) {
  let caught = null
  try {
    fn()
  } catch (e) {
    caught = e
  }
  ok(
    label,
    !!caught && caught.code === code,
    caught
      ? `threw code=${caught.code} message=${caught.message.slice(0, 80)}`
      : 'did not throw',
  )
}

function section(name) {
  console.log(`\n— ${name} —`)
}

function makeHeader(over = {}) {
  return {
    schemaVersion: 1,
    updatedAt: '2026-05-11T10:00:00.000Z',
    deviceFolder: 'mac-aaaa1111',
    recordType: 'identity',
    recordId: 'rec-abc123',
    deleted: false,
    ...over,
  }
}

function makeBody() {
  return {
    id: 'rec-abc123',
    name: 'Cliente IG #42',
    color: '#5b8def',
    fingerprintSeed: 'deadbeefcafef00d',
    workspaceId: 'general',
    userAgent: null,
    locked: false,
    createdAt: 1715346000000,
  }
}

const key = crypto.randomBytes(32)

console.log('OZ Browser — sync-record-store smoke test')

// 1. Round-trip
section('Round-trip')
{
  const header = makeHeader()
  const body = makeBody()
  const buf = encodeRecord(key, header, body)
  ok('encodeRecord returns Buffer', Buffer.isBuffer(buf))
  ok('buffer non-empty', buf.length > 0)
  const { header: h2, body: b2 } = decodeRecord(key, buf)
  ok('decoded header.recordId matches', h2.recordId === header.recordId)
  ok('decoded header.updatedAt matches', h2.updatedAt === header.updatedAt)
  ok('decoded header.deviceFolder matches', h2.deviceFolder === header.deviceFolder)
  ok('decoded header.schemaVersion matches', h2.schemaVersion === 1)
  ok('decoded header.recordType matches', h2.recordType === 'identity')
  ok('decoded header.deleted === false', h2.deleted === false)
  ok('decoded body.name matches', b2.name === 'Cliente IG #42')
  ok('decoded body.fingerprintSeed matches', b2.fingerprintSeed === 'deadbeefcafef00d')
  ok('decoded body.color matches', b2.color === '#5b8def')
  ok('decoded body.workspaceId matches', b2.workspaceId === 'general')
}

// 2. Tombstone round-trip
section('Tombstone (deleted=true, null body)')
{
  const header = makeHeader({
    deleted: true,
    deletedAt: '2026-05-11T10:00:00.000Z',
  })
  const buf = encodeRecord(key, header, null)
  const { header: h2, body: b2 } = decodeRecord(key, buf)
  ok('decoded tombstone header.deleted === true', h2.deleted === true)
  ok('decoded tombstone deletedAt preserved', h2.deletedAt === header.deletedAt)
  ok('decoded tombstone body === null', b2 === null)
}

// 3. Tampering — ciphertext / authTag / wrong key
section('Tampering detection')
{
  const buf = encodeRecord(key, makeHeader(), makeBody())
  const tampered = Buffer.from(buf)
  tampered[tampered.length - 1] ^= 0x01 // last byte is inside ciphertext
  throwsWithCode(
    'flipped ciphertext byte → DECRYPT_FAILED',
    () => decodeRecord(key, tampered),
    'DECRYPT_FAILED',
  )
}
{
  const buf = encodeRecord(key, makeHeader(), makeBody())
  const tampered = Buffer.from(buf)
  const headerLen = tampered.readUInt32LE(0)
  const tagStart = HEADER_LEN_BYTES + headerLen + IV_BYTES
  tampered[tagStart + 4] ^= 0x01
  throwsWithCode(
    'flipped authTag byte → DECRYPT_FAILED',
    () => decodeRecord(key, tampered),
    'DECRYPT_FAILED',
  )
}
{
  const buf = encodeRecord(key, makeHeader(), makeBody())
  const wrongKey = crypto.randomBytes(32)
  throwsWithCode(
    'wrong key → DECRYPT_FAILED',
    () => decodeRecord(wrongKey, buf),
    'DECRYPT_FAILED',
  )
}

// 4. Bad key / buffer inputs
section('Bad inputs')
throwsWithCode(
  'non-Buffer key (encode) → BAD_KEY',
  () => encodeRecord('not-a-buffer', makeHeader(), makeBody()),
  'BAD_KEY',
)
throwsWithCode(
  'short key (encode) → BAD_KEY',
  () => encodeRecord(crypto.randomBytes(16), makeHeader(), makeBody()),
  'BAD_KEY',
)
throwsWithCode(
  'short key (decode) → BAD_KEY',
  () => decodeRecord(crypto.randomBytes(31), Buffer.alloc(64)),
  'BAD_KEY',
)
throwsWithCode(
  'non-Buffer buffer (decode) → BAD_INPUT',
  () => decodeRecord(key, 'not-a-buffer'),
  'BAD_INPUT',
)

// 5. Body invariants
section('Body invariants')
throwsWithCode(
  'tombstone with body → TOMBSTONE_HAS_BODY',
  () =>
    encodeRecord(
      key,
      makeHeader({ deleted: true, deletedAt: '2026-05-11T10:00:00.000Z' }),
      { foo: 'bar' },
    ),
  'TOMBSTONE_HAS_BODY',
)
throwsWithCode(
  'non-tombstone with null body → MISSING_BODY',
  () => encodeRecord(key, makeHeader(), null),
  'MISSING_BODY',
)
throwsWithCode(
  'non-tombstone with string body → MISSING_BODY',
  () => encodeRecord(key, makeHeader(), 'string-body'),
  'MISSING_BODY',
)
throwsWithCode(
  'non-tombstone with array body → MISSING_BODY',
  () => encodeRecord(key, makeHeader(), [1, 2, 3]),
  'MISSING_BODY',
)

// 6. Header validation (wrapped as HEADER_INVALID by encode/decode)
section('Header validation')
throwsWithCode(
  'encode invalid header → HEADER_INVALID',
  () => encodeRecord(key, makeHeader({ schemaVersion: undefined }), makeBody()),
  'HEADER_INVALID',
)
throwsWithCode(
  'encode header with bad updatedAt → HEADER_INVALID',
  () => encodeRecord(key, makeHeader({ updatedAt: 'not-iso' }), makeBody()),
  'HEADER_INVALID',
)

// 7. Truncation / corruption
section('Truncation / corruption')
throwsWithCode(
  'buffer < min size → BUFFER_TOO_SMALL',
  () => decodeRecord(key, Buffer.alloc(8)),
  'BUFFER_TOO_SMALL',
)
{
  const buf = Buffer.alloc(64)
  buf.writeUInt32LE(99999, 0)
  throwsWithCode(
    'absurd headerLen → BAD_HEADER_LEN',
    () => decodeRecord(key, buf),
    'BAD_HEADER_LEN',
  )
}
{
  const buf = Buffer.alloc(64)
  buf.writeUInt32LE(0, 0)
  throwsWithCode(
    'zero headerLen → BAD_HEADER_LEN',
    () => decodeRecord(key, buf),
    'BAD_HEADER_LEN',
  )
}
{
  // Header reports a length that overshoots the buffer
  const buf = Buffer.alloc(64)
  buf.writeUInt32LE(100, 0)
  throwsWithCode(
    'headerLen overshoot → TRUNCATED',
    () => decodeRecord(key, buf),
    'TRUNCATED',
  )
}
{
  // Corrupt header JSON (replace header body with non-JSON bytes)
  const good = encodeRecord(key, makeHeader(), makeBody())
  const tampered = Buffer.from(good)
  const headerLen = tampered.readUInt32LE(0)
  for (let i = HEADER_LEN_BYTES; i < HEADER_LEN_BYTES + headerLen; i++) {
    tampered[i] = 0xff
  }
  throwsWithCode(
    'corrupt header JSON → HEADER_CORRUPT',
    () => decodeRecord(key, tampered),
    'HEADER_CORRUPT',
  )
}
{
  // Header is valid JSON but missing required fields → HEADER_INVALID
  const good = encodeRecord(key, makeHeader(), makeBody())
  const tampered = Buffer.from(good)
  const malformedHeader = Buffer.from(JSON.stringify({ ohai: 'incomplete' }), 'utf-8')
  // We need to rebuild a new buffer because headerLen would differ.
  const headerLenBuf = Buffer.alloc(HEADER_LEN_BYTES)
  headerLenBuf.writeUInt32LE(malformedHeader.length, 0)
  const oldHeaderLen = tampered.readUInt32LE(0)
  const rebuilt = Buffer.concat([
    headerLenBuf,
    malformedHeader,
    tampered.slice(HEADER_LEN_BYTES + oldHeaderLen),
  ])
  throwsWithCode(
    'valid JSON but missing fields → HEADER_INVALID',
    () => decodeRecord(key, rebuilt),
    'HEADER_INVALID',
  )
}

// 8. Large body
section('Large body')
{
  const bigBody = Object.assign({}, makeBody(), { blob: 'x'.repeat(10 * 1024) })
  const buf = encodeRecord(key, makeHeader(), bigBody)
  const { body: b2 } = decodeRecord(key, buf)
  ok('10KB body round-trips', b2.blob.length === 10 * 1024 && b2.blob[0] === 'x')
}

// 9. IV uniqueness (probabilistic, with N=32 trials)
section('IV uniqueness')
{
  const seenIvs = new Set()
  for (let i = 0; i < 32; i++) {
    const buf = encodeRecord(key, makeHeader(), makeBody())
    const headerLen = buf.readUInt32LE(0)
    const iv = buf.slice(
      HEADER_LEN_BYTES + headerLen,
      HEADER_LEN_BYTES + headerLen + IV_BYTES,
    )
    seenIvs.add(iv.toString('hex'))
  }
  ok('32 encodes produce 32 distinct IVs (no static IV)', seenIvs.size === 32)
}

// 10. Sanity: SyncRecordStoreError is exported and has .code
section('Error class shape')
{
  let caught
  try {
    decodeRecord(key, Buffer.alloc(4))
  } catch (e) {
    caught = e
  }
  ok('thrown error is SyncRecordStoreError', caught instanceof SyncRecordStoreError)
  ok('thrown error has .code', typeof caught.code === 'string')
  ok('thrown error has .name', caught.name === 'SyncRecordStoreError')
}

// ---------- Summary ---------------------------------------------------------
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}

// Reference AUTHTAG_BYTES so eslint doesn't flag unused import.
void AUTHTAG_BYTES
