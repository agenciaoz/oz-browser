// OZ Browser — Backup Manager smoke test (1.6a CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/backup-manager.smoketest.js
//
// Cubre:
//   - flatpack/flatunpack round-trip
//   - encryptBytes/decryptBytes round-trip + tampering detection
//   - createSnapshot escribe .ozbackup válido (header + body)
//   - listSnapshots lee headers sin descifrar
//   - restoreSnapshot recrea estructura idéntica al userData original
//   - createSnapshot LOCKED si vault locked
//   - retention policy: keep daily 30d + weekly forever
//   - Walks Partitions/ recursivo correctamente
//   - filename convention safe (no `:` en filesystem)

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-backup-'))

const {
  BackupManager,
  BackupError,
  _flatpack,
  _flatunpack,
  _encryptBytes,
  _decryptBytes,
  isoWeek,
} = require('../browser/backup-manager')

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

function section(name) {
  console.log(`\n— ${name} —`)
}

function makeFakeVault({ unlocked = true } = {}) {
  const key = crypto.randomBytes(32)
  return {
    isUnlocked: unlocked,
    getMasterKey() {
      return unlocked ? key : null
    },
    _key: key, // for tests that want to inspect
  }
}

function makeUserDataDir() {
  const root = fs.mkdtempSync(path.join(TEST_DIR, 'userdata-'))
  fs.writeFileSync(path.join(root, 'identities.json'), JSON.stringify([{ id: 'a' }]))
  fs.writeFileSync(path.join(root, 'workspaces.json'), JSON.stringify([{ id: 'g' }]))
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'vault.enc'), Buffer.from('encrypted-blob'))
  // Partitions/ with a couple of files (simulates Cookies SQLite + LocalStorage)
  const partA = path.join(root, 'Partitions', 'persist:identity-A')
  fs.mkdirSync(partA, { recursive: true })
  fs.writeFileSync(path.join(partA, 'Cookies'), Buffer.from('SQLite cookies bytes'))
  fs.writeFileSync(path.join(partA, 'Local Storage'), Buffer.from('lstorage bytes'))
  const partB = path.join(root, 'Partitions', 'persist:identity-B', 'IndexedDB')
  fs.mkdirSync(partB, { recursive: true })
  fs.writeFileSync(path.join(partB, '0001.log'), Buffer.from('idb bytes'))
  return root
}

function dirSnapshot(root) {
  // Returns { relPath -> sha256 hex } for stable comparison.
  const out = {}
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile()) {
        const rel = path.relative(root, full).replace(/\\/g, '/')
        // Skip the snapshots dir itself when comparing — backup writes there
        if (rel.startsWith('data/snapshots/')) continue
        out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      }
    }
  }
  walk(root)
  return out
}

async function main() {
  console.log('OZ Browser — BackupManager smoke test')
  console.log(`Test dir: ${TEST_DIR}`)

  // 1. Flatpack round-trip
  section('Flatpack format round-trip')
  {
    const root = fs.mkdtempSync(path.join(TEST_DIR, 'flat-'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'AAA')
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 3]))
    const flat = _flatpack(root, ['a.txt', 'sub/b.bin'])
    ok('flatpack returns Buffer', Buffer.isBuffer(flat))
    const files = _flatunpack(flat)
    ok('flatunpack returns 2 files', files.length === 2)
    ok('first file relPath OK', files[0].relPath === 'a.txt')
    ok('first file content OK', files[0].content.toString() === 'AAA')
    ok('second file relPath posix', files[1].relPath === 'sub/b.bin')
    ok(
      'second file content bytes preserved',
      files[1].content.equals(Buffer.from([0, 1, 2, 3])),
    )
  }

  // 2. Encrypt/Decrypt bytes round-trip
  section('AES-GCM bytes round-trip')
  {
    const key = crypto.randomBytes(32)
    const plaintext = Buffer.from('hello world ' + '🐈'.repeat(100))
    const enc = _encryptBytes(key, plaintext)
    ok('iv 12 bytes', enc.iv.length === 12)
    ok('authTag 16 bytes', enc.authTag.length === 16)
    const dec = _decryptBytes(key, enc.iv, enc.authTag, enc.ciphertext)
    ok('round-trip equal', dec.equals(plaintext))
    // Tamper test
    let threw = null
    try {
      const tampered = Buffer.from(enc.ciphertext)
      tampered[0] = tampered[0] ^ 0xff
      _decryptBytes(key, enc.iv, enc.authTag, tampered)
    } catch (e) {
      threw = e
    }
    ok('tampered ciphertext rejected', threw !== null)
  }

  // 3. createSnapshot LOCKED if vault locked
  section('createSnapshot LOCKED if vault locked')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault({ unlocked: false })
    const bm = new BackupManager({ userDataDir: userData, vault, appVersion: '0.1.0' })
    let threw = null
    try {
      bm.createSnapshot({ reason: 'manual' })
    } catch (e) {
      threw = e
    }
    ok('throws BackupError', threw instanceof BackupError)
    ok('code === LOCKED', threw && threw.code === 'LOCKED')
  }

  // 4. createSnapshot writes .ozbackup
  section('createSnapshot writes valid .ozbackup file')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault()
    const bm = new BackupManager({ userDataDir: userData, vault, appVersion: '0.1.0' })
    const snap = bm.createSnapshot({ reason: 'manual', label: 'first one' })
    ok('returned id matches filename pattern', /^[0-9TZ.-]+$/.test(snap.id))
    ok('file exists on disk', fs.existsSync(snap.filePath))
    ok('file size > 100 bytes (header + payload)', fs.statSync(snap.filePath).size > 100)
    ok('header.format === ozbackup', snap.header.format === 'ozbackup')
    ok('header.reason === manual', snap.header.reason === 'manual')
    ok(
      'header.fileCount >= 5 (configs + vault + 3 partition files)',
      snap.header.fileCount >= 5,
    )
    ok('header.appVersion === 0.1.0', snap.header.appVersion === '0.1.0')
  }

  // 5. listSnapshots reads headers
  section('listSnapshots returns metadata sorted newest-first')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault()
    const bm = new BackupManager({ userDataDir: userData, vault, appVersion: '0.1.0' })
    bm.createSnapshot({ reason: 'manual', label: 'first' })
    // Sleep briefly to ensure different timestamps in filename
    await new Promise((r) => setTimeout(r, 10))
    bm.createSnapshot({ reason: 'pre-quit', label: 'second' })
    await new Promise((r) => setTimeout(r, 10))
    bm.createSnapshot({ reason: 'manual', label: 'third' })

    const list = bm.listSnapshots()
    ok('lists 3 snapshots', list.length === 3)
    ok('newest first by createdAt', list[0].label === 'third')
    ok(
      'all have id',
      list.every((s) => typeof s.id === 'string' && s.id.length > 0),
    )
    ok(
      'all have sizeBytes',
      list.every((s) => typeof s.sizeBytes === 'number' && s.sizeBytes > 0),
    )
    ok(
      'all have reason',
      list.every((s) => typeof s.reason === 'string'),
    )
  }

  // 6. restoreSnapshot recreates identical structure
  section('restoreSnapshot recreates identical userData')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault()
    const bm = new BackupManager({ userDataDir: userData, vault, appVersion: '0.1.0' })
    const before = dirSnapshot(userData)
    const snap = bm.createSnapshot({ reason: 'manual' })

    // Simulate mutation: change identities.json + delete a partition file
    fs.writeFileSync(path.join(userData, 'identities.json'), '[{"mutated":true}]')
    fs.unlinkSync(path.join(userData, 'Partitions', 'persist:identity-A', 'Cookies'))

    const result = bm.restoreSnapshot(snap.id)
    ok('result.ok === true', result.ok === true)
    ok('restored 5+ files', result.restoredCount >= 5)

    const after = dirSnapshot(userData)
    // Compare: every file in `before` should match `after`
    let mismatches = 0
    for (const [rel, hash] of Object.entries(before)) {
      if (after[rel] !== hash) {
        mismatches++
        console.log(
          `      mismatch: ${rel} before=${hash.slice(0, 8)} after=${after[rel] && after[rel].slice(0, 8)}`,
        )
      }
    }
    ok('all original files restored bit-perfect', mismatches === 0)
  }

  // 7. restoreSnapshot LOCKED if vault locked
  section('restoreSnapshot LOCKED + NOT_FOUND')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault()
    const bm = new BackupManager({ userDataDir: userData, vault, appVersion: '0.1.0' })
    const snap = bm.createSnapshot({ reason: 'manual' })

    // Lock and try
    vault.isUnlocked = false
    vault.getMasterKey = () => null
    let threw = null
    try {
      bm.restoreSnapshot(snap.id)
    } catch (e) {
      threw = e
    }
    ok('LOCKED throws', threw && threw.code === 'LOCKED')

    // Re-unlock and try non-existent
    vault.isUnlocked = true
    vault.getMasterKey = () => vault._key
    threw = null
    try {
      bm.restoreSnapshot('does-not-exist')
    } catch (e) {
      threw = e
    }
    ok('NOT_FOUND throws', threw && threw.code === 'NOT_FOUND')
  }

  // 8. deleteSnapshot
  section('deleteSnapshot removes file')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault()
    const bm = new BackupManager({ userDataDir: userData, vault })
    const snap = bm.createSnapshot({ reason: 'manual' })
    ok('exists pre-delete', fs.existsSync(snap.filePath))
    const removed = bm.deleteSnapshot(snap.id)
    ok('returned true', removed === true)
    ok('file gone', !fs.existsSync(snap.filePath))
    ok('deleting again returns false', bm.deleteSnapshot(snap.id) === false)
  }

  // 9. Retention policy: weekly forever for older
  section('Retention policy: keep daily Nd + 1 weekly forever')
  {
    const userData = makeUserDataDir()
    const vault = makeFakeVault()
    const bm = new BackupManager({ userDataDir: userData, vault })

    // Create 4 snapshots, then manually back-date them by editing the file
    // headers (cheaper than mocking Date globally).
    //
    // Bug fix 2026-05-13: previously old1/old2 used offsets -50d/-52d, which
    // ASSUMED two days apart was always the same ISO week — false when the
    // Mon→Sun boundary falls between them. We now pin both to Tue + Thu of
    // the SAME ISO week ~7 weeks back, deterministic regardless of "today".
    const dayMs = 86400000
    const sevenWeeksBack = Date.now() - 50 * dayMs
    const baseDate = new Date(sevenWeeksBack)
    // ISO week starts Monday. getUTCDay returns 0=Sun..6=Sat.
    const isoWeekday = (baseDate.getUTCDay() + 6) % 7 // 0=Mon..6=Sun
    const mondayMs = sevenWeeksBack - isoWeekday * dayMs
    const sameWeekTueMs = mondayMs + 1 * dayMs
    const sameWeekThuMs = mondayMs + 3 * dayMs

    const stamps = [
      { reason: 'manual', label: 'recent', createdAtMs: Date.now() - dayMs },
      { reason: 'daily-3am', label: 'old1', createdAtMs: sameWeekTueMs },
      { reason: 'daily-3am', label: 'old2', createdAtMs: sameWeekThuMs },
      { reason: 'daily-3am', label: 'older', createdAtMs: Date.now() - 120 * dayMs },
    ]
    const created = []
    for (const s of stamps) {
      const snap = bm.createSnapshot({ reason: s.reason, label: s.label })
      // Rewrite header createdAt
      const raw = fs.readFileSync(snap.filePath)
      const headerLen = raw.readUInt32LE(0)
      const headerJson = raw.subarray(4, 4 + headerLen).toString('utf-8')
      const header = JSON.parse(headerJson)
      const fakeDate = new Date(s.createdAtMs)
      header.createdAt = fakeDate.toISOString()
      const newHeaderBuf = Buffer.from(JSON.stringify(header), 'utf-8')
      // Pad/truncate so the offset of body doesn't change (lazy: rewrite headerLen too)
      const newLen = Buffer.alloc(4)
      newLen.writeUInt32LE(newHeaderBuf.length, 0)
      const body = raw.subarray(4 + headerLen)
      fs.writeFileSync(snap.filePath, Buffer.concat([newLen, newHeaderBuf, body]))
      created.push({ id: snap.id, label: s.label })
      // small delay so filename ids differ
      await new Promise((r) => setTimeout(r, 5))
    }

    const before = bm.listSnapshots()
    ok('4 snapshots before retention', before.length === 4)

    const result = bm.applyRetention({ keepDailyDays: 30 })
    ok('deletedCount === 1 (the duplicate week)', result.deletedCount === 1)

    const after = bm.listSnapshots()
    ok(
      'remaining 3: recent + 1 of week-old + older',
      after.length === 3,
      `actual labels: ${after.map((s) => s.label).join(', ')}`,
    )
    ok(
      'recent kept',
      after.some((s) => s.label === 'recent'),
    )
    ok(
      'older kept (different week)',
      after.some((s) => s.label === 'older'),
    )
  }

  // 10. isoWeek consistency
  section('isoWeek helper')
  {
    // Two dates 2 days apart in same ISO week → same string
    const a = new Date('2026-01-12T00:00:00Z') // Monday W3 of 2026
    const b = new Date('2026-01-14T00:00:00Z') // Wednesday same week
    ok('same ISO week → same key', isoWeek(a) === isoWeek(b))
    const c = new Date('2026-01-19T00:00:00Z') // Next Monday → different week
    ok('next week → different key', isoWeek(a) !== isoWeek(c))
  }
}

main()
  .catch((err) => {
    console.error('UNEXPECTED ERROR:', err)
    failed++
    failures.push({ label: 'runner crash', detail: err.message })
  })
  .finally(() => {
    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures) {
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      }
      process.exit(1)
    }
    process.exit(0)
  })
