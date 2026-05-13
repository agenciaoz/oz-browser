// OZ Browser — Sync Merge smoke test (D-3a CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-merge.smoketest.js
//
// Cubre:
//   - mergeRecords: local-newer / remote-newer / equal-lex / equal-same-device
//   - mergeRecords: local null / remote null / both null
//   - mergeRecords: tombstone semantics (deleted vs alive, edit-after-delete)
//   - compareTimestamps invalid inputs throw
//   - mergeRecords equal updatedAt without deviceFolder throws
//   - isTombstoneGcEligible: 0d / 29d / 30d / 31d, missing deletedAt
//   - assertValidHeader: each invariant

'use strict'

const {
  mergeRecords,
  compareTimestamps,
  isTombstoneGcEligible,
  assertValidHeader,
  TOMBSTONE_GC_MS,
  TOMBSTONE_GC_DAYS,
} = require('../browser/sync-merge')

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

function throws(label, fn, fragment) {
  let caught = null
  try {
    fn()
  } catch (e) {
    caught = e
  }
  ok(
    label,
    !!caught && (!fragment || caught.message.includes(fragment)),
    caught ? `threw: ${caught.message}` : 'did not throw',
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
    recordId: 'rec-1',
    deleted: false,
    ...over,
  }
}

console.log('OZ Browser — sync-merge smoke test')

// 1. Basic LWW
section('mergeRecords — LWW (timestamps)')
{
  const local = makeHeader({ updatedAt: '2026-05-11T11:00:00.000Z' })
  const remote = makeHeader({ updatedAt: '2026-05-11T10:00:00.000Z' })
  const r = mergeRecords(local, remote)
  ok('local newer → keep-local', r.action === 'keep-local')
  ok('reason === local-newer', r.reason === 'local-newer')
}
{
  const local = makeHeader({ updatedAt: '2026-05-11T09:00:00.000Z' })
  const remote = makeHeader({ updatedAt: '2026-05-11T10:00:00.000Z' })
  const r = mergeRecords(local, remote)
  ok('remote newer → take-remote', r.action === 'take-remote')
  ok('reason === remote-newer', r.reason === 'remote-newer')
}

// 2. Tied lex
section('mergeRecords — equal updatedAt, deviceFolder lex desempate')
{
  const local = makeHeader({ deviceFolder: 'mac-aaaa1111' })
  const remote = makeHeader({ deviceFolder: 'mac-bbbb2222' })
  ok(
    'local lex < remote → keep-local',
    mergeRecords(local, remote).action === 'keep-local',
  )
}
{
  const local = makeHeader({ deviceFolder: 'mac-zzzz9999' })
  const remote = makeHeader({ deviceFolder: 'mac-aaaa1111' })
  ok(
    'local lex > remote → take-remote',
    mergeRecords(local, remote).action === 'take-remote',
  )
}
{
  const local = makeHeader({ deviceFolder: 'mac-aaaa1111' })
  const remote = makeHeader({ deviceFolder: 'mac-aaaa1111' })
  const r = mergeRecords(local, remote)
  ok('same device, same ts → noop (idempotente)', r.action === 'noop')
  ok('reason === identical-provenance', r.reason === 'identical-provenance')
}
{
  // Idempotency check: running mergeRecords on (A,B) and (B,A) yields
  // opposite winners but the WINNER is the same record in absolute terms.
  const a = makeHeader({ deviceFolder: 'mac-aaaa' })
  const b = makeHeader({ deviceFolder: 'mac-bbbb' })
  const r1 = mergeRecords(a, b)
  const r2 = mergeRecords(b, a)
  ok(
    'lex desempate es simétrico (mismo deviceFolder gana en absolute terms)',
    r1.action === 'keep-local' && r2.action === 'take-remote',
  )
}

// 3. Missing sides
section('mergeRecords — null sides')
ok(
  'local null + remote → take-remote',
  mergeRecords(null, makeHeader()).action === 'take-remote',
)
ok(
  'remote null + local → keep-local',
  mergeRecords(makeHeader(), null).action === 'keep-local',
)
ok('both null → noop', mergeRecords(null, null).action === 'noop')

// 4. Tombstone semantics
section('mergeRecords — tombstones')
{
  // local deleted (newer), remote alive — delete propagates
  const local = makeHeader({
    updatedAt: '2026-05-11T11:00:00.000Z',
    deleted: true,
    deletedAt: '2026-05-11T11:00:00.000Z',
  })
  const remote = makeHeader({ updatedAt: '2026-05-11T10:00:00.000Z' })
  ok(
    'local-deleted newer → keep-local (propagate delete)',
    mergeRecords(local, remote).action === 'keep-local',
  )
}
{
  // local alive (edit), remote deleted but older — edit resurrects.
  const local = makeHeader({ updatedAt: '2026-05-11T12:00:00.000Z' })
  const remote = makeHeader({
    updatedAt: '2026-05-11T11:00:00.000Z',
    deleted: true,
    deletedAt: '2026-05-11T11:00:00.000Z',
  })
  ok(
    'edit-after-delete → record resurrects',
    mergeRecords(local, remote).action === 'keep-local',
  )
}
{
  // Both deleted, same ts, same device → noop
  const local = makeHeader({
    deleted: true,
    deletedAt: '2026-05-11T10:00:00.000Z',
  })
  const remote = makeHeader({
    deleted: true,
    deletedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('both deleted identical → noop', mergeRecords(local, remote).action === 'noop')
}
{
  // Both deleted, different ts → newer wins
  const local = makeHeader({
    updatedAt: '2026-05-11T11:00:00.000Z',
    deleted: true,
    deletedAt: '2026-05-11T11:00:00.000Z',
  })
  const remote = makeHeader({
    updatedAt: '2026-05-11T10:00:00.000Z',
    deleted: true,
    deletedAt: '2026-05-11T10:00:00.000Z',
  })
  ok(
    'both deleted, local newer → keep-local',
    mergeRecords(local, remote).action === 'keep-local',
  )
}

// 5. Validation errors
section('mergeRecords / compareTimestamps — validation errors')
throws(
  'equal updatedAt without deviceFolder throws',
  () =>
    mergeRecords(
      makeHeader({ deviceFolder: undefined }),
      makeHeader({ deviceFolder: undefined }),
    ),
  'requires both sides to declare deviceFolder',
)

throws(
  'invalid updatedAt (left) throws',
  () => compareTimestamps('not-a-date', '2026-05-11T10:00:00.000Z'),
  'invalid updatedAt',
)
throws(
  'invalid updatedAt (right) throws',
  () => compareTimestamps('2026-05-11T10:00:00.000Z', 'not-a-date'),
  'invalid updatedAt',
)

// 6. Tombstone GC eligibility
section('isTombstoneGcEligible')
{
  const now = Date.parse('2026-05-11T10:00:00.000Z')
  const fresh = { deleted: true, deletedAt: '2026-05-11T10:00:00.000Z' }
  const old29 = {
    deleted: true,
    deletedAt: new Date(now - 29 * 86400000).toISOString(),
  }
  const old30 = {
    deleted: true,
    deletedAt: new Date(now - 30 * 86400000).toISOString(),
  }
  const old31 = {
    deleted: true,
    deletedAt: new Date(now - 31 * 86400000).toISOString(),
  }

  ok('0 days → not eligible', isTombstoneGcEligible(fresh, now) === false)
  ok('29 days → not eligible', isTombstoneGcEligible(old29, now) === false)
  ok('30 days → eligible', isTombstoneGcEligible(old30, now) === true)
  ok('31 days → eligible', isTombstoneGcEligible(old31, now) === true)
  ok(
    'non-tombstone (deleted=false) → not eligible',
    isTombstoneGcEligible({ deleted: false }, now) === false,
  )
  ok(
    'tombstone without deletedAt → not eligible',
    isTombstoneGcEligible({ deleted: true }, now) === false,
  )
  ok(
    'tombstone with malformed deletedAt → not eligible',
    isTombstoneGcEligible({ deleted: true, deletedAt: 'not-iso' }, now) === false,
  )
  ok('null header → not eligible', isTombstoneGcEligible(null, now) === false)
  ok('TOMBSTONE_GC_DAYS === 30', TOMBSTONE_GC_DAYS === 30)
  ok('TOMBSTONE_GC_MS === 30 * 86400000', TOMBSTONE_GC_MS === 30 * 86400000)
}

// 7. assertValidHeader
section('assertValidHeader')
ok('valid header → true', assertValidHeader(makeHeader()) === true)
throws('null header throws', () => assertValidHeader(null), 'object')
throws('non-object throws', () => assertValidHeader('a-string'), 'object')
throws(
  'missing schemaVersion throws',
  () => assertValidHeader(makeHeader({ schemaVersion: undefined })),
  'schemaVersion',
)
throws(
  'non-integer schemaVersion throws',
  () => assertValidHeader(makeHeader({ schemaVersion: 1.5 })),
  'schemaVersion',
)
throws(
  'bad updatedAt throws',
  () => assertValidHeader(makeHeader({ updatedAt: 'not-iso' })),
  'updatedAt',
)
throws(
  'empty deviceFolder throws',
  () => assertValidHeader(makeHeader({ deviceFolder: 'a' })),
  'deviceFolder',
)
throws(
  'missing recordType throws',
  () => assertValidHeader(makeHeader({ recordType: '' })),
  'recordType',
)
throws(
  'missing recordId throws',
  () => assertValidHeader(makeHeader({ recordId: '' })),
  'recordId',
)
throws(
  'non-boolean deleted throws',
  () => assertValidHeader(makeHeader({ deleted: 'yes' })),
  'deleted',
)
throws(
  'tombstone with bad deletedAt throws',
  () => assertValidHeader(makeHeader({ deleted: true, deletedAt: 'not-iso' })),
  'deletedAt',
)

// ---------- Summary ---------------------------------------------------------
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
