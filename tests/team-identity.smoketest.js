// OZ Browser — Team Identity smoke test (Bloque E-2).
//
// Cómo correr:
//   cd oz-browser
//   node tests/team-identity.smoketest.js
//
// Cubre:
//   - base64url encode/decode roundtrip
//   - generateTeamKeypair: 32+32 bytes, X25519 ECDH matches between two keypairs
//   - _genUuid: RFC v4 shape
//   - _isValid: shape rejection
//   - ensureIdentity: first call generates + persists, second is idempotent
//   - factory: missing Keychain entry → regenerate (UX: rare but graceful)
//   - clear(): removes file + Keychain entry; next ensure generates fresh
//   - getPrivateKey + getPublicKey roundtrip equivalence

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-team-identity-'))

const {
  createTeamIdentity,
  generateTeamKeypair,
  IDENTITY_FILENAME,
  SCHEMA_VERSION,
  injectKeyring,
  _b64urlEncode,
  _b64urlDecode,
  _genUuid,
  _isValid,
} = require('../browser/team-identity')

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

function freshDir(name) {
  const dir = path.join(TEST_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- fake Keychain (in-memory) ----------
function makeFakeKeyring() {
  const store = new Map()
  class Entry {
    constructor(service, account) {
      this.key = `${service}::${account}`
    }
    setPassword(pw) {
      store.set(this.key, pw)
    }
    getPassword() {
      return store.get(this.key) || null
    }
    deletePassword() {
      store.delete(this.key)
    }
  }
  return { Entry, _store: store }
}

// Install fake keychain for the whole suite (test isolation: each test
// uses its own userDataDir + memberId, so the store doesn't bleed semantics).
const fakeKeyring = makeFakeKeyring()
injectKeyring(fakeKeyring)

// ---------- base64url ----------
group('base64url', () => {
  const buf = crypto.randomBytes(32)
  const enc = _b64urlEncode(buf)
  ok('encode produces URL-safe', /^[A-Za-z0-9_-]+$/.test(enc))
  ok('no padding chars', !enc.includes('='))
  const dec = _b64urlDecode(enc)
  ok('decode roundtrip', dec.equals(buf))
  // Non-string input throws
  let threw = false
  try {
    _b64urlDecode(null)
  } catch (_) {
    threw = true
  }
  ok('decode rejects non-string', threw)
})

// ---------- generateTeamKeypair ----------
group('generateTeamKeypair', () => {
  const k = generateTeamKeypair()
  ok('privateKey 32 bytes', k.privateKey.length === 32)
  ok('publicKey 32 bytes', k.publicKey.length === 32)
  const k2 = generateTeamKeypair()
  ok('two gens produce different priv keys', !k.privateKey.equals(k2.privateKey))
  ok('two gens produce different pub keys', !k.publicKey.equals(k2.publicKey))
  // ECDH: derive shared secret both ways, must match
  const { x25519 } = require('@noble/curves/ed25519.js')
  const ab = Buffer.from(x25519.getSharedSecret(k.privateKey, k2.publicKey))
  const ba = Buffer.from(x25519.getSharedSecret(k2.privateKey, k.publicKey))
  ok('ECDH symmetric (Alice→Bob == Bob→Alice)', ab.equals(ba))
  ok('shared secret 32 bytes', ab.length === 32)
})

// ---------- _genUuid ----------
group('_genUuid', () => {
  const u = _genUuid()
  ok(
    'RFC v4 format',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u),
  )
  ok('two gens differ', _genUuid() !== _genUuid())
})

// ---------- _isValid ----------
group('_isValid', () => {
  ok('rejects null', !_isValid(null))
  ok('rejects empty', !_isValid({}))
  ok(
    'rejects missing publicKey',
    !_isValid({ memberId: 'a'.repeat(36), schemaVersion: 1 }),
  )
  ok(
    'rejects short publicKey',
    !_isValid({ memberId: 'a'.repeat(36), publicKey: 'short', schemaVersion: 1 }),
  )
  ok(
    'accepts valid shape',
    _isValid({
      memberId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      publicKey: 'a'.repeat(43),
      schemaVersion: 1,
    }),
  )
})

// ---------- factory: first boot ----------
group('ensureIdentity — first boot', () => {
  const dir = freshDir('first-boot')
  const ti = createTeamIdentity({ userDataDir: dir })
  const me = ti.ensureIdentity()
  ok('memberId shape (uuid)', /^[0-9a-f-]{36}$/.test(me.memberId))
  ok('publicKey base64url 43 chars', /^[A-Za-z0-9_-]{43}$/.test(me.publicKey))
  ok('createdAt ISO', /^\d{4}-\d{2}-\d{2}T/.test(me.createdAt))
  // File persisted
  const fp = path.join(dir, IDENTITY_FILENAME)
  ok('file persisted', fs.existsSync(fp))
  const onDisk = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  ok('schemaVersion stored', onDisk.schemaVersion === SCHEMA_VERSION)
  // Private key in Keychain
  ok(
    'private key persisted in Keychain',
    fakeKeyring._store.has(`oz-browser-team::${me.memberId}`),
  )
  // getPublicKey roundtrips
  const pubBuf = ti.getPublicKey()
  ok('getPublicKey returns 32 bytes', pubBuf.length === 32)
  ok('getPublicKey matches stored', _b64urlEncode(pubBuf) === me.publicKey)
  // getPrivateKey roundtrip + ECDH
  const privBuf = ti.getPrivateKey()
  ok('getPrivateKey returns 32 bytes', privBuf.length === 32)
  const { x25519 } = require('@noble/curves/ed25519.js')
  const derivedPub = Buffer.from(x25519.getPublicKey(privBuf))
  ok('derived public matches stored', derivedPub.equals(pubBuf))
})

// ---------- factory: idempotent across calls ----------
group('ensureIdentity — idempotent', () => {
  const dir = freshDir('idempotent')
  const ti1 = createTeamIdentity({ userDataDir: dir })
  const me1 = ti1.ensureIdentity()
  // Second factory (simulates reboot): should read from disk
  const ti2 = createTeamIdentity({ userDataDir: dir })
  const me2 = ti2.ensureIdentity()
  ok('memberId stable across factory reload', me1.memberId === me2.memberId)
  ok('publicKey stable', me1.publicKey === me2.publicKey)
  ok('createdAt stable', me1.createdAt === me2.createdAt)
})

// ---------- factory: missing Keychain entry regen ----------
group('regen when Keychain entry missing', () => {
  const dir = freshDir('missing-keychain')
  const ti1 = createTeamIdentity({ userDataDir: dir })
  const me1 = ti1.ensureIdentity()
  // Wipe Keychain entry (simulates user clearing Keychain)
  fakeKeyring._store.delete(`oz-browser-team::${me1.memberId}`)
  // New factory: should detect missing privKey + regenerate fresh
  const ti2 = createTeamIdentity({ userDataDir: dir })
  const me2 = ti2.ensureIdentity()
  ok('regenerated memberId differs', me1.memberId !== me2.memberId)
  ok(
    'new Keychain entry present',
    fakeKeyring._store.has(`oz-browser-team::${me2.memberId}`),
  )
})

// ---------- clear() ----------
group('clear()', () => {
  const dir = freshDir('clear')
  const ti = createTeamIdentity({ userDataDir: dir })
  const me1 = ti.ensureIdentity()
  ok('file exists before clear', fs.existsSync(path.join(dir, IDENTITY_FILENAME)))
  ti.clear()
  ok('file removed after clear', !fs.existsSync(path.join(dir, IDENTITY_FILENAME)))
  ok(
    'Keychain entry removed',
    !fakeKeyring._store.has(`oz-browser-team::${me1.memberId}`),
  )
  // Next ensure generates fresh
  const me2 = ti.ensureIdentity()
  ok('new memberId after clear', me2.memberId !== me1.memberId)
})

// ---------- getMemberId ----------
group('getMemberId', () => {
  const dir = freshDir('getmemberid')
  const ti = createTeamIdentity({ userDataDir: dir })
  const id = ti.getMemberId()
  ok('returns string uuid', typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))
})

// ---------- factory validation ----------
group('factory validation', () => {
  let threw = false
  try {
    createTeamIdentity({})
  } catch (_) {
    threw = true
  }
  ok('missing userDataDir throws', threw)
})

// ---------- summary ----------
console.log(`\n${'='.repeat(50)}`)
console.log(`team-identity smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f.label}`)
}
try {
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
} catch (_) {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1)
