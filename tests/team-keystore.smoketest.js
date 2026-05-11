// OZ Browser — Team Keystore (ECIES) smoke test (Bloque E-3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/team-keystore.smoketest.js
//
// Cubre:
//   - wrap → unwrap roundtrip recovers exact masterKey
//   - blob has expected length (124 bytes)
//   - different ephemeral keys per wrap → blob bytes differ even with same inputs
//   - wrong private key → AUTH_TAG_MISMATCH
//   - wrong public key (AAD mismatch) → AUTH_TAG_MISMATCH
//   - tampered ciphertext → AUTH_TAG_MISMATCH
//   - tampered authTag → AUTH_TAG_MISMATCH
//   - tampered IV → AUTH_TAG_MISMATCH
//   - tampered salt (changes HKDF output) → AUTH_TAG_MISMATCH
//   - bad arg validation (sizes, types)
//   - HKDF determinism: same inputs → same output

const crypto = require('crypto')

const {
  wrapMasterKey,
  unwrapMasterKey,
  KeystoreError,
  BLOB_LEN,
  PUB_KEY_LEN,
  PRIV_KEY_LEN,
  MASTER_KEY_LEN,
  IV_LEN,
  AUTH_TAG_LEN,
  SALT_LEN,
  _hkdf,
} = require('../browser/team-keystore')
const { x25519 } = require('@noble/curves/ed25519.js')

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
    console.error(`  ✗ ${label}`)
    if (detail !== undefined) console.error(`      → ${JSON.stringify(detail)}`)
  }
}
function group(name, fn) {
  console.log(`\n[${name}]`)
  fn()
}

function makeKeypair() {
  const priv = Buffer.from(x25519.utils.randomSecretKey())
  const pub = Buffer.from(x25519.getPublicKey(priv))
  return { priv, pub }
}

// ---------- roundtrip happy ----------
group('wrap → unwrap roundtrip', () => {
  const owner = makeKeypair()
  const member = makeKeypair()
  const masterKey = crypto.randomBytes(MASTER_KEY_LEN)
  const blob = wrapMasterKey(member.pub, masterKey)
  ok('blob is Buffer', Buffer.isBuffer(blob))
  ok(`blob length = ${BLOB_LEN}`, blob.length === BLOB_LEN)
  const recovered = unwrapMasterKey(member.priv, member.pub, blob)
  ok('recovered length 32', recovered.length === MASTER_KEY_LEN)
  ok('recovered === original', recovered.equals(masterKey))
  // owner's priv must NOT recover member's blob (different keypair)
  let threw = null
  try {
    unwrapMasterKey(owner.priv, owner.pub, blob)
  } catch (e) {
    threw = e
  }
  ok(
    'wrong recipient priv → AUTH_TAG_MISMATCH',
    threw && threw.code === 'AUTH_TAG_MISMATCH',
  )
})

// ---------- ephemeral per wrap ----------
group('different ephemerals per wrap', () => {
  const member = makeKeypair()
  const mk = crypto.randomBytes(MASTER_KEY_LEN)
  const blob1 = wrapMasterKey(member.pub, mk)
  const blob2 = wrapMasterKey(member.pub, mk)
  ok('two wraps differ (ephemeral randomness)', !blob1.equals(blob2))
  // Both unwrap to same masterKey
  ok('blob1 unwraps OK', unwrapMasterKey(member.priv, member.pub, blob1).equals(mk))
  ok('blob2 unwraps OK', unwrapMasterKey(member.priv, member.pub, blob2).equals(mk))
})

// ---------- AAD bind: wrong public key on unwrap fails ----------
group('AAD mismatch (wrong public key)', () => {
  const memberA = makeKeypair()
  const memberB = makeKeypair()
  const mk = crypto.randomBytes(MASTER_KEY_LEN)
  // Wrap for A
  const blob = wrapMasterKey(memberA.pub, mk)
  // Try to unwrap with A's priv but B's pub as AAD — should fail
  let threw = null
  try {
    unwrapMasterKey(memberA.priv, memberB.pub, blob)
  } catch (e) {
    threw = e
  }
  ok('AAD mismatch → AUTH_TAG_MISMATCH', threw && threw.code === 'AUTH_TAG_MISMATCH')
})

// ---------- tampering: ciphertext byte flip ----------
group('tampered blob detection', () => {
  const member = makeKeypair()
  const mk = crypto.randomBytes(MASTER_KEY_LEN)
  const blob = wrapMasterKey(member.pub, mk)
  // ciphertext starts at: PUB_KEY_LEN + SALT_LEN + IV_LEN + AUTH_TAG_LEN
  const ctStart = PUB_KEY_LEN + SALT_LEN + IV_LEN + AUTH_TAG_LEN
  const t1 = Buffer.from(blob)
  t1[ctStart] = t1[ctStart] ^ 0x01
  let threw = null
  try {
    unwrapMasterKey(member.priv, member.pub, t1)
  } catch (e) {
    threw = e
  }
  ok('tampered ciphertext detected', threw && threw.code === 'AUTH_TAG_MISMATCH')
  // tag tampering
  const tagStart = PUB_KEY_LEN + SALT_LEN + IV_LEN
  const t2 = Buffer.from(blob)
  t2[tagStart] = t2[tagStart] ^ 0x01
  threw = null
  try {
    unwrapMasterKey(member.priv, member.pub, t2)
  } catch (e) {
    threw = e
  }
  ok('tampered authTag detected', threw && threw.code === 'AUTH_TAG_MISMATCH')
  // IV tampering
  const ivStart = PUB_KEY_LEN + SALT_LEN
  const t3 = Buffer.from(blob)
  t3[ivStart] = t3[ivStart] ^ 0x01
  threw = null
  try {
    unwrapMasterKey(member.priv, member.pub, t3)
  } catch (e) {
    threw = e
  }
  ok('tampered IV detected', threw && threw.code === 'AUTH_TAG_MISMATCH')
  // salt tampering (changes HKDF output → wrong wrapKey)
  const saltStart = PUB_KEY_LEN
  const t4 = Buffer.from(blob)
  t4[saltStart] = t4[saltStart] ^ 0x01
  threw = null
  try {
    unwrapMasterKey(member.priv, member.pub, t4)
  } catch (e) {
    threw = e
  }
  ok('tampered salt detected', threw && threw.code === 'AUTH_TAG_MISMATCH')
  // ephPub tampering (changes shared secret → wrong wrapKey)
  const t5 = Buffer.from(blob)
  t5[0] = t5[0] ^ 0x01
  threw = null
  try {
    unwrapMasterKey(member.priv, member.pub, t5)
  } catch (e) {
    threw = e
  }
  ok('tampered ephPub detected', threw && threw.code === 'AUTH_TAG_MISMATCH')
})

// ---------- validation ----------
group('input validation', () => {
  const mk = crypto.randomBytes(MASTER_KEY_LEN)
  // wrap: wrong pub size
  let threw = null
  try {
    wrapMasterKey(Buffer.alloc(16), mk)
  } catch (e) {
    threw = e
  }
  ok('wrap rejects short pub', threw && threw.code === 'BAD_ARG')
  threw = null
  try {
    wrapMasterKey('not a buffer', mk)
  } catch (e) {
    threw = e
  }
  ok('wrap rejects non-Buffer pub', threw && threw.code === 'BAD_ARG')
  threw = null
  try {
    wrapMasterKey(Buffer.alloc(PUB_KEY_LEN), Buffer.alloc(16))
  } catch (e) {
    threw = e
  }
  ok('wrap rejects short masterKey', threw && threw.code === 'BAD_ARG')
  // unwrap: wrong blob size
  threw = null
  try {
    unwrapMasterKey(
      Buffer.alloc(PRIV_KEY_LEN),
      Buffer.alloc(PUB_KEY_LEN),
      Buffer.alloc(50),
    )
  } catch (e) {
    threw = e
  }
  ok('unwrap rejects short blob', threw && threw.code === 'BAD_BLOB')
})

// ---------- HKDF determinism ----------
group('HKDF determinism', () => {
  const ikm = Buffer.from('a'.repeat(32))
  const salt = Buffer.from('b'.repeat(32))
  const info = Buffer.from('test-info', 'utf-8')
  const o1 = _hkdf(ikm, salt, info, 32)
  const o2 = _hkdf(ikm, salt, info, 32)
  ok('same inputs → same output', o1.equals(o2))
  ok('output length matches', o1.length === 32)
  // Different salt → different output
  const o3 = _hkdf(ikm, Buffer.from('c'.repeat(32)), info, 32)
  ok('different salt → different output', !o1.equals(o3))
})

// ---------- summary ----------
console.log(`\n${'='.repeat(50)}`)
console.log(`team-keystore smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f.label}`)
}
process.exit(failed === 0 ? 0 : 1)
