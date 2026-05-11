// OZ Browser — Cloud Backup cursor cache smoke test (D-2.3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/cloud-backup-cache.smoketest.js
//
// Split de cloud-backup-manager.smoketest.js por ADR 0005 (LOC budget).
// Cubre el cache cursor-based introducido en D-2.3:
//   - cache miss → listFolderAll, cursor stored
//   - cache hit → listFolderContinue, delta applied (add + delete)
//   - upload invalidates cache
//   - delete invalidates cache
//   - CURSOR_RESET → drop cache + re-list fresh

const path = require('path')
const fs = require('fs')
const os = require('os')
const { EventEmitter } = require('events')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-cb-cache-'))
const { createCloudBackupManager } = require('../browser/cloud-backup-manager')

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
async function asyncGroup(name, fn) {
  console.log(`\n[${name}]`)
  await fn()
}
function freshSubdir(name) {
  const dir = path.join(TEST_DIR, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'data', 'snapshots'), { recursive: true })
  return dir
}
function makeDeviceInfo(folder = 'mydev') {
  return {
    getDeviceInfo: () => ({ deviceFolder: folder }),
    getDeviceFolder: () => folder,
    ensureDeviceInfo: () => ({ deviceFolder: folder }),
  }
}
function makeBackupManagerStub(userDataDir) {
  const em = new EventEmitter()
  em.snapshotsDir = path.join(userDataDir, 'data', 'snapshots')
  fs.mkdirSync(em.snapshotsDir, { recursive: true })
  return em
}
function writeSnapshotFile(snapshotsDir, id, body) {
  const fp = path.join(snapshotsDir, `${id}.ozbackup`)
  fs.writeFileSync(fp, body || Buffer.from('FAKE BACKUP BODY'))
  return fp
}
function makeDropboxClient(overrides = {}) {
  return {
    startAuth: () => ({
      authUrl: 'https://x',
      codeVerifier: 'V',
      state: 'STATE',
      redirectUri: 'oz://auth/dropbox/callback',
    }),
    completeAuth: async () => {},
    clearAuth: () => {},
    getAccountInfo: async () => ({ accountId: 'X', email: 'a@b.c', name: 'A' }),
    ensureFolder: async () => ({ ok: true }),
    upload: async ({ path: p, contents }) => ({
      path: p,
      size: contents.length,
      rev: 'R',
    }),
    delete: async () => ({ ok: true }),
    listFolder: async () => ({ entries: [], cursor: null, hasMore: false }),
    listFolderAll: async (folder) => {
      const arr =
        typeof overrides.listFolderImpl === 'function'
          ? overrides.listFolderImpl(folder)
          : overrides.listFolderResult || []
      return {
        entries: Array.isArray(arr) ? arr : arr.entries || [],
        cursor: (overrides.cursorByFolder && overrides.cursorByFolder[folder]) || null,
        hasMore: false,
      }
    },
    listFolderContinue: async (cursor) => {
      const next = (overrides.continueResponses || []).shift()
      if (next instanceof Error) throw next
      return next || { entries: [], cursor, hasMore: false }
    },
  }
}

;(async () => {
  await asyncGroup('cursor cache — hit reuses listFolderContinue', async () => {
    const dir = freshSubdir('cursor-cache-hit')
    const bm = makeBackupManagerStub(dir)
    let listCount = 0
    let continueCount = 0
    const dbx = makeDropboxClient({
      listFolderImpl: () => [
        {
          name: '2026-05-10T01.000Z.ozbackup',
          pathLower: '/dev-cache/snapshots/2026-05-10t01.000z.ozbackup',
          pathDisplay: '/dev-cache/snapshots/2026-05-10T01.000Z.ozbackup',
          size: 100,
          isFolder: false,
          isDeleted: false,
          serverModified: '2026-05-10T01:00:00Z',
        },
      ],
      cursorByFolder: { '/dev-cache/snapshots': 'CUR-1' },
      continueResponses: [
        {
          entries: [
            {
              name: '2026-05-11T02.000Z.ozbackup',
              pathLower: '/dev-cache/snapshots/2026-05-11t02.000z.ozbackup',
              pathDisplay: '/dev-cache/snapshots/2026-05-11T02.000Z.ozbackup',
              size: 200,
              serverModified: '2026-05-11T02:00:00Z',
              isFolder: false,
              isDeleted: false,
            },
            {
              name: '2026-05-10T01.000Z.ozbackup',
              pathLower: '/dev-cache/snapshots/2026-05-10t01.000z.ozbackup',
              isFolder: false,
              isDeleted: true,
            },
          ],
          cursor: 'CUR-2',
          hasMore: false,
        },
      ],
    })
    const origAll = dbx.listFolderAll
    const origCont = dbx.listFolderContinue
    dbx.listFolderAll = async (...args) => {
      listCount++
      return origAll(...args)
    }
    dbx.listFolderContinue = async (...args) => {
      continueCount++
      return origCont(...args)
    }
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-cache'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    const r1 = await m.listRemoteSnapshots()
    ok('first call returns initial entry', r1.length === 1)
    ok('listFolderAll called once', listCount === 1)
    ok('listFolderContinue NOT called yet', continueCount === 0)
    const r2 = await m.listRemoteSnapshots()
    ok('listFolderContinue called once (delta path)', continueCount === 1)
    ok('delta applied: 1 entry (added new, removed old)', r2.length === 1, {
      entries: r2,
    })
    ok('returned entry is the new one', r2[0].id === '2026-05-11T02.000Z')
  })

  await asyncGroup('cursor cache — upload invalidates', async () => {
    const dir = freshSubdir('cache-invalid-upload')
    const bm = makeBackupManagerStub(dir)
    let listCount = 0
    const dbx = makeDropboxClient({
      listFolderImpl: () => [],
      cursorByFolder: { '/dev-up/snapshots': 'CUR-X' },
    })
    const origAll = dbx.listFolderAll
    dbx.listFolderAll = async (...args) => {
      listCount++
      return origAll(...args)
    }
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-up'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    await m.listRemoteSnapshots()
    ok('list call 1', listCount === 1)
    writeSnapshotFile(bm.snapshotsDir, '2026-05-11T03.000Z', Buffer.from('hi'))
    await m.uploadSnapshot('2026-05-11T03.000Z')
    await m.listRemoteSnapshots()
    ok('upload invalidated cache → fresh listFolderAll', listCount === 2)
  })

  await asyncGroup('cursor cache — delete invalidates', async () => {
    const dir = freshSubdir('cache-invalid-delete')
    const bm = makeBackupManagerStub(dir)
    let listCount = 0
    const dbx = makeDropboxClient({
      listFolderImpl: () => [],
      cursorByFolder: { '/dev-del/snapshots': 'CUR-Y' },
    })
    const origAll = dbx.listFolderAll
    dbx.listFolderAll = async (...args) => {
      listCount++
      return origAll(...args)
    }
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-del'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    await m.listRemoteSnapshots()
    ok('list call 1', listCount === 1)
    await m.deleteRemoteSnapshot('SNAP-X')
    await m.listRemoteSnapshots()
    ok('delete invalidated cache', listCount === 2)
  })

  await asyncGroup('cursor cache — CURSOR_RESET re-lists fresh', async () => {
    const dir = freshSubdir('cache-reset')
    const bm = makeBackupManagerStub(dir)
    let listCount = 0
    let continueCount = 0
    const dbx = makeDropboxClient({
      listFolderImpl: () => [],
      cursorByFolder: { '/dev-reset/snapshots': 'CUR-OLD' },
    })
    const origAll = dbx.listFolderAll
    dbx.listFolderAll = async (...args) => {
      listCount++
      return origAll(...args)
    }
    dbx.listFolderContinue = async () => {
      continueCount++
      const e = new Error('cursor reset — caller must re-list from scratch')
      e.code = 'CURSOR_RESET'
      throw e
    }
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-reset'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    await m.listRemoteSnapshots()
    ok('initial list', listCount === 1)
    const r = await m.listRemoteSnapshots()
    ok('continue attempted', continueCount === 1)
    ok('listFolderAll called again after reset', listCount === 2)
    ok('returns array (degraded gracefully)', Array.isArray(r))
  })

  console.log(`\n${'='.repeat(50)}`)
  console.log(`cloud-backup cache smoke: ${passed} passed, ${failed} failed`)
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
})()
