// OZ Browser — Team invite token smoke test (Bloque E-4).
//
// Cómo correr:
//   cd oz-browser
//   node tests/invite-token.smoketest.js
//
// Cubre:
//   - generate → parse roundtrip
//   - URL roundtrip: extractTokenFromUrl + parse
//   - isExpired: future → false, past → true
//   - isValidShape: rejects various malformed inputs
//   - tampered token (modified base64url chars) → BAD_SHAPE or BAD_FORMAT
//   - ttlMs override works
//   - ownerPublicKey accepts Buffer(32) AND base64url string
//   - extractTokenFromUrl: wrong scheme/path/missing token

const crypto = require('crypto')

const {
  generateInviteToken,
  parseInviteToken,
  extractTokenFromUrl,
  isValidShape,
  isExpired,
  InviteTokenError,
  DEFAULT_TTL_MS,
  TOKEN_SCHEMA_VERSION,
  _b64urlEncode,
  _b64urlDecode,
  _isUuid,
} = require('../browser/invite-token')

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

const TEAM_ID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'
const OWNER_ID = 'f0e1d2c3-b4a5-6789-0123-456789abcdef'
const ownerPubBuf = crypto.randomBytes(32)

// ---------- generate happy ----------
group('generate happy path', () => {
  const r = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
  })
  ok('returns token + tokenObj + url', !!(r.token && r.tokenObj && r.url))
  ok('token is base64url-safe', /^[A-Za-z0-9_-]+$/.test(r.token))
  ok(
    'url starts with oz://team/invite?token=',
    r.url.startsWith('oz://team/invite?token='),
  )
  ok('tokenObj.v === 1', r.tokenObj.v === TOKEN_SCHEMA_VERSION)
  ok('tokenObj.teamId preserved', r.tokenObj.teamId === TEAM_ID)
  ok('tokenObj.ownerMemberId preserved', r.tokenObj.ownerMemberId === OWNER_ID)
  ok(
    'ownerPublicKey base64url encoded',
    r.tokenObj.ownerPublicKey === _b64urlEncode(ownerPubBuf),
  )
  ok(
    'nonce present',
    typeof r.tokenObj.nonce === 'string' && r.tokenObj.nonce.length >= 22,
  )
  // expiresAt ~ now + DEFAULT_TTL_MS (within 5s tolerance)
  const exp = Date.parse(r.tokenObj.expiresAt)
  const delta = Math.abs(exp - (Date.now() + DEFAULT_TTL_MS))
  ok(`expiresAt ≈ now + 24h (delta=${delta}ms)`, delta < 5000)
})

// ---------- parse roundtrip ----------
group('generate → parse roundtrip', () => {
  const { token, tokenObj } = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
  })
  const parsed = parseInviteToken(token)
  ok('parsed.v matches', parsed.v === tokenObj.v)
  ok('parsed.teamId matches', parsed.teamId === tokenObj.teamId)
  ok('parsed.ownerMemberId matches', parsed.ownerMemberId === tokenObj.ownerMemberId)
  ok('parsed.ownerPublicKey matches', parsed.ownerPublicKey === tokenObj.ownerPublicKey)
  ok('parsed.expiresAt matches', parsed.expiresAt === tokenObj.expiresAt)
  ok('parsed.nonce matches', parsed.nonce === tokenObj.nonce)
})

// ---------- URL roundtrip ----------
group('URL roundtrip', () => {
  const { url } = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
  })
  const tokenFromUrl = extractTokenFromUrl(url)
  const parsed = parseInviteToken(tokenFromUrl)
  ok('teamId preserved through URL roundtrip', parsed.teamId === TEAM_ID)
  // Wrong scheme
  let threw = null
  try {
    extractTokenFromUrl('https://example.com?token=xxx')
  } catch (e) {
    threw = e
  }
  ok('rejects non-oz:// scheme', threw && threw.code === 'BAD_SCHEME')
  // Wrong path
  threw = null
  try {
    extractTokenFromUrl('oz://auth/dropbox/callback?code=xxx')
  } catch (e) {
    threw = e
  }
  ok('rejects wrong path', threw && threw.code === 'BAD_PATH')
  // Missing token
  threw = null
  try {
    extractTokenFromUrl('oz://team/invite')
  } catch (e) {
    threw = e
  }
  ok('rejects missing token query', threw && threw.code === 'MISSING_TOKEN')
})

// ---------- expiry ----------
group('expiry', () => {
  // Fresh token: not expired
  const now = Date.now()
  const fresh = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
    now,
  })
  ok('fresh token NOT expired', !isExpired(fresh.tokenObj, { now: now + 1000 }))
  ok(
    'fresh token EXPIRED if now > expiresAt',
    isExpired(fresh.tokenObj, { now: now + DEFAULT_TTL_MS + 1 }),
  )
  // Short TTL
  const shortToken = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
    ttlMs: 1000,
    now,
  })
  ok(
    'short-ttl token expired after 2s',
    isExpired(shortToken.tokenObj, { now: now + 2000 }),
  )
})

// ---------- ownerPublicKey input variants ----------
group('ownerPublicKey accepts Buffer or base64url string', () => {
  const fromBuf = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
  })
  const fromStr = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: _b64urlEncode(ownerPubBuf),
  })
  ok(
    'both forms produce same encoded ownerPublicKey',
    fromBuf.tokenObj.ownerPublicKey === fromStr.tokenObj.ownerPublicKey,
  )
})

// ---------- isValidShape ----------
group('isValidShape', () => {
  ok('rejects null', !isValidShape(null))
  ok('rejects empty', !isValidShape({}))
  ok(
    'rejects wrong v',
    !isValidShape({
      v: 99,
      teamId: TEAM_ID,
      ownerMemberId: OWNER_ID,
      ownerPublicKey: 'a'.repeat(43),
      expiresAt: '2026-05-12T00:00:00Z',
      nonce: 'a'.repeat(22),
    }),
  )
  ok(
    'rejects missing teamId',
    !isValidShape({
      v: 1,
      ownerMemberId: OWNER_ID,
      ownerPublicKey: 'a'.repeat(43),
      expiresAt: '2026-05-12T00:00:00Z',
      nonce: 'a'.repeat(22),
    }),
  )
  ok(
    'rejects bad uuid',
    !isValidShape({
      v: 1,
      teamId: 'not-uuid',
      ownerMemberId: OWNER_ID,
      ownerPublicKey: 'a'.repeat(43),
      expiresAt: '2026-05-12T00:00:00Z',
      nonce: 'a'.repeat(22),
    }),
  )
})

// ---------- tampering ----------
group('tampered token detection', () => {
  const { token } = generateInviteToken({
    teamId: TEAM_ID,
    ownerMemberId: OWNER_ID,
    ownerPublicKey: ownerPubBuf,
  })
  // Flip a middle char — likely breaks base64 OR JSON
  const tampered = token.slice(0, 10) + (token[10] === 'A' ? 'B' : 'A') + token.slice(11)
  let threw = null
  try {
    parseInviteToken(tampered)
  } catch (e) {
    threw = e
  }
  ok(
    'tampered token throws (BAD_FORMAT or BAD_SHAPE)',
    threw && (threw.code === 'BAD_FORMAT' || threw.code === 'BAD_SHAPE'),
  )
  // Empty string
  threw = null
  try {
    parseInviteToken('')
  } catch (e) {
    threw = e
  }
  ok('empty token throws BAD_ARG', threw && threw.code === 'BAD_ARG')
})

// ---------- generateInviteToken validation ----------
group('generate validation', () => {
  let threw = null
  try {
    generateInviteToken({})
  } catch (e) {
    threw = e
  }
  ok('missing teamId throws BAD_ARG', threw && threw.code === 'BAD_ARG')
  threw = null
  try {
    generateInviteToken({
      teamId: 'not-uuid',
      ownerMemberId: OWNER_ID,
      ownerPublicKey: ownerPubBuf,
    })
  } catch (e) {
    threw = e
  }
  ok('invalid teamId throws', threw && threw.code === 'BAD_ARG')
  threw = null
  try {
    generateInviteToken({
      teamId: TEAM_ID,
      ownerMemberId: OWNER_ID,
      ownerPublicKey: Buffer.alloc(16),
    })
  } catch (e) {
    threw = e
  }
  ok('short ownerPublicKey Buffer throws', threw && threw.code === 'BAD_ARG')
  threw = null
  try {
    generateInviteToken({
      teamId: TEAM_ID,
      ownerMemberId: OWNER_ID,
      ownerPublicKey: 'short',
    })
  } catch (e) {
    threw = e
  }
  ok('short ownerPublicKey string throws', threw && threw.code === 'BAD_ARG')
})

// ---------- summary ----------
console.log(`\n${'='.repeat(50)}`)
console.log(`invite-token smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f.label}`)
}
process.exit(failed === 0 ? 0 : 1)
