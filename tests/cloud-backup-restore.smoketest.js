// OZ Browser — Cloud Backup Manager smoke test (Bloque D-1.4 — restore + cross-device).
//
// Cómo correr:
//   cd oz-browser
//   node tests/cloud-backup-restore.smoketest.js
//
// Cubre:
//   - downloadSnapshot: writes local file, current + cross-device paths
//   - downloadSnapshot: not connected → error
//   - downloadSnapshot: empty snapshotId → error
//   - restoreFromCloud: downloads + invokes backupManager.restoreSnapshot
//   - listDevices: current device first + counts + alphabetical others
//   - listDevices: not connected → error
//
// Split de cloud-backup-manager.smoketest.js (D-1.3) para respetar 500 LOC
// (ADR 0005). Mismos helpers duplicados — el set es chico y la duplicación
// es preferible a un módulo helper compartido (sería el primero del repo).

const path = require('path')
const fs = require('fs')
const os = require('os')
const { EventEmitter } = require('events')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-cloud-restore-'))

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

function makeDeviceInfo(folder = 'mydev-abc12345') {
  return {
    getDeviceInfo: () => ({ deviceFolder: folder }),
    getDeviceFolder: () => folder,
    ensureDeviceInfo: () => ({ deviceFolder: folder }),
  }
}

function makeDropboxClient(overrides = {}) {
  const calls = {
    startAuth: 0,
    completeAuth: 0,
    clearAuth: 0,
    getAccountInfo: 0,
    ensureFolder: 0,
    upload: 0,
    download: 0,
    listFolder: 0,
    delete: 0,
  }
  const captured = {}
  return Object.assign(
    {
      _calls: calls,
      _captured: captured,
      startAuth() {
        calls.startAuth++
        return {
          authUrl: 'https://example/oauth',
          codeVerifier: 'VERIFIER',
          state: 'STATE',
          redirectUri: 'oz://auth/dropbox/callback',
        }
      },
      async completeAuth(args) {
        calls.completeAuth++
        captured.completeAuth = args
      },
      clearAuth() {
        calls.clearAuth++
      },
      async getAccountInfo() {
        calls.getAccountInfo++
        return overrides.account || { accountId: 'dbid:A', email: 'a@b.c', name: 'A' }
      },
      async ensureFolder(p) {
        calls.ensureFolder++
        captured.lastEnsureFolder = p
        return { ok: true }
      },
      async upload({ path: dpath, contents }) {
        calls.upload++
        captured.lastUpload = { path: dpath, size: contents.length }
        return { path: dpath, size: contents.length, rev: 'R', contentHash: 'H' }
      },
      async download(p) {
        calls.download++
        captured.lastDownload = p
        if (typeof overrides.downloadImpl === 'function') return overrides.downloadImpl(p)
        return (
          overrides.downloadResp || {
            contents: Buffer.from('CLOUD BODY'),
            path: p,
            size: 10,
            rev: 'R',
            contentHash: 'CH',
          }
        )
      },
      async listFolder(folder) {
        calls.listFolder++
        captured.lastList = folder
        if (typeof overrides.listFolderImpl === 'function')
          return overrides.listFolderImpl(folder)
        return overrides.listFolderResult || []
      },
      async listFolderAll(folder) {
        calls.listFolder++
        captured.lastList = folder
        const arr =
          typeof overrides.listFolderImpl === 'function'
            ? overrides.listFolderImpl(folder)
            : overrides.listFolderResult || []
        return {
          entries: Array.isArray(arr) ? arr : arr.entries || [],
          cursor: null,
          hasMore: false,
        }
      },
      async listFolderContinue(cursor) {
        captured.lastContinueCursor = cursor
        return { entries: [], cursor, hasMore: false }
      },
      async delete(p) {
        calls.delete++
        captured.lastDelete = p
        return { ok: true }
      },
    },
    overrides.extra || {},
  )
}

function makeBackupManagerStub(userDataDir) {
  const em = new EventEmitter()
  em.snapshotsDir = path.join(userDataDir, 'data', 'snapshots')
  fs.mkdirSync(em.snapshotsDir, { recursive: true })
  return em
}

;(async () => {
  await asyncGroup('downloadSnapshot', async () => {
    const dir = freshSubdir('download')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient()
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-x'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    const r = await m.downloadSnapshot('SNAP-1')
    ok('returns localPath', typeof r.localPath === 'string')
    ok('sizeBytes returned', r.sizeBytes === 10)
    ok('contentHash returned', r.contentHash === 'CH')
    ok('file written locally', fs.existsSync(r.localPath))
    ok('local content matches', fs.readFileSync(r.localPath).toString() === 'CLOUD BODY')
    ok(
      'download invoked with current-device path',
      dbx._captured.lastDownload === '/dev-x/snapshots/SNAP-1.ozbackup',
    )
    // Cross-device download
    await m.downloadSnapshot('SNAP-2', 'other-dev-1111ffff')
    ok(
      'cross-device download path correct',
      dbx._captured.lastDownload === '/other-dev-1111ffff/snapshots/SNAP-2.ozbackup',
    )
    // Validation
    let threw = null
    try {
      await m.downloadSnapshot('')
    } catch (e) {
      threw = e
    }
    ok('rejects empty snapshotId', threw && /snapshotId required/.test(threw.message))
  })

  await asyncGroup('downloadSnapshot not connected', async () => {
    const dir = freshSubdir('download-noconn')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    let threw = null
    try {
      await m.downloadSnapshot('X')
    } catch (e) {
      threw = e
    }
    ok('throws not connected', threw && /not connected/.test(threw.message))
  })

  await asyncGroup('restoreFromCloud calls backupManager.restoreSnapshot', async () => {
    const dir = freshSubdir('restore-from-cloud')
    const bm = makeBackupManagerStub(dir)
    let restoreCalledWith = null
    bm.restoreSnapshot = (id) => {
      restoreCalledWith = id
      return { ok: true, restoredCount: 42 }
    }
    const dbx = makeDropboxClient()
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-r'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    const r = await m.restoreFromCloud('SNAP-99', 'other-dev-aaaa1111')
    ok('restoreSnapshot called', restoreCalledWith === 'SNAP-99')
    ok(
      'downloaded from cross-device folder',
      dbx._captured.lastDownload === '/other-dev-aaaa1111/snapshots/SNAP-99.ozbackup',
    )
    ok('restore result propagated', r.ok === true && r.restoredCount === 42)
    ok(
      'local file persisted before restore',
      fs.existsSync(path.join(bm.snapshotsDir, 'SNAP-99.ozbackup')),
    )
  })

  await asyncGroup('listDevices: current-first + counts', async () => {
    const dir = freshSubdir('list-devices')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient({
      listFolderImpl: (folder) => {
        if (folder === '') {
          return [
            { name: 'macbook-a1b2c3d4', isFolder: true },
            { name: 'mini-deadbeef', isFolder: true },
            { name: 'stray-file.txt', isFolder: false },
            { name: 'other-mac-7777ffff', isFolder: true },
          ]
        }
        if (folder === '/macbook-a1b2c3d4/snapshots') {
          return [
            {
              name: '2026-05-10T22-00-00.000Z.ozbackup',
              size: 100,
              isFolder: false,
              pathDisplay:
                '/macbook-a1b2c3d4/snapshots/2026-05-10T22-00-00.000Z.ozbackup',
              serverModified: '2026-05-10T22:00:00Z',
            },
            {
              name: '2026-05-09T22-00-00.000Z.ozbackup',
              size: 90,
              isFolder: false,
              pathDisplay:
                '/macbook-a1b2c3d4/snapshots/2026-05-09T22-00-00.000Z.ozbackup',
              serverModified: '2026-05-09T22:00:00Z',
            },
          ]
        }
        if (folder === '/mini-deadbeef/snapshots') {
          return [
            {
              name: '2026-04-01T12-00-00.000Z.ozbackup',
              size: 200,
              isFolder: false,
              pathDisplay: '/mini-deadbeef/snapshots/2026-04-01T12-00-00.000Z.ozbackup',
              serverModified: '2026-04-01T12:00:00Z',
            },
          ]
        }
        return []
      },
    })
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('mini-deadbeef'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    const devices = await m.listDevices()
    ok('3 folder devices (stray-file skipped)', devices.length === 3)
    ok('current device first', devices[0].deviceFolder === 'mini-deadbeef')
    ok('isCurrentDevice true on first', devices[0].isCurrentDevice === true)
    ok('current snapshotCount', devices[0].snapshotCount === 1)
    ok('current totalSizeBytes', devices[0].totalSizeBytes === 200)
    ok(
      'current latest id captured',
      devices[0].latestSnapshotId === '2026-04-01T12-00-00.000Z',
    )
    ok('second device = macbook', devices[1].deviceFolder === 'macbook-a1b2c3d4')
    ok('macbook NOT current', devices[1].isCurrentDevice === false)
    ok('macbook snapshotCount', devices[1].snapshotCount === 2)
    ok('macbook totalSize 190', devices[1].totalSizeBytes === 190)
    ok('third device = other-mac', devices[2].deviceFolder === 'other-mac-7777ffff')
    ok('other-mac empty', devices[2].snapshotCount === 0)
    ok('other-mac latestSnapshotAt null', devices[2].latestSnapshotAt === null)
  })

  await asyncGroup('listDevices not connected', async () => {
    const dir = freshSubdir('list-devices-noconn')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    let threw = null
    try {
      await m.listDevices()
    } catch (e) {
      threw = e
    }
    ok('throws not connected', threw && /not connected/.test(threw.message))
  })

  console.log(`\n${'='.repeat(50)}`)
  console.log(`cloud-backup-restore smoke: ${passed} passed, ${failed} failed`)
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
