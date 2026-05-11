// OZ Browser — Cloud Backup Manager smoke test (Bloque D-1.3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/cloud-backup-manager.smoketest.js
//
// Cubre:
//   - _readState: missing file → initial, corrupt → initial, valid → merged
//   - getStatus: deviceFolder included + initial state
//   - connect: returns authUrl, stores pending OAuth
//   - completeConnect: state mismatch propagates
//   - completeConnect happy path: persists account + ensures folder
//   - disconnect: clears state, calls clearAuth, preserves autoUpload
//   - setAutoUpload: persisted across reload
//   - uploadSnapshot: reads local file, uploads, updates lastUploadAt
//   - uploadSnapshot: not connected → error
//   - uploadSnapshot: missing local file → error
//   - uploadSnapshot: upload fails → lastUploadError set
//   - listRemoteSnapshots: filters by .ozbackup regex, sorts newest-first
//   - listRemoteSnapshots: cross-device (other deviceFolder)
//   - deleteRemoteSnapshot: invokes dropbox.delete with right path
//   - init: auto-upload triggers ONLY if connected + autoUpload + reason!=pre-restore
//   - init: listener exceptions don't crash main flow

const path = require('path')
const fs = require('fs')
const os = require('os')
const { EventEmitter } = require('events')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-cloud-backup-'))

const {
  createCloudBackupManager,
  STATE_FILENAME,
  _initialState,
  _readState,
} = require('../browser/cloud-backup-manager')

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
        if (overrides.completeAuthShouldThrow) throw overrides.completeAuthShouldThrow
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
        if (overrides.uploadShouldThrow) throw overrides.uploadShouldThrow
        return { path: dpath, size: contents.length, rev: 'R', contentHash: 'H' }
      },
      async listFolderAll(folder) {
        calls.listFolder++
        captured.lastList = folder
        const arr =
          typeof overrides.listFolderImpl === 'function'
            ? overrides.listFolderImpl(folder)
            : []
        return {
          entries: Array.isArray(arr) ? arr : arr.entries || [],
          cursor: null,
          hasMore: false,
        }
      },
      async listFolderContinue(cursor) {
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

function writeSnapshotFile(snapshotsDir, id, body) {
  const fp = path.join(snapshotsDir, `${id}.ozbackup`)
  fs.writeFileSync(fp, body || Buffer.from('FAKE BACKUP BODY'))
  return fp
}

// ---------- sync ----------
group('_readState', () => {
  const dir = freshSubdir('readstate')
  const fp = path.join(dir, STATE_FILENAME)
  ok(
    'missing → initial',
    JSON.stringify(_readState(fp)) === JSON.stringify(_initialState()),
  )
  fs.writeFileSync(fp, '{ not json')
  ok(
    'corrupt → initial',
    JSON.stringify(_readState(fp)) === JSON.stringify(_initialState()),
  )
  fs.writeFileSync(
    fp,
    JSON.stringify({ connected: true, autoUpload: true, schemaVersion: 1 }),
  )
  const merged = _readState(fp)
  ok(
    'valid → merges over defaults',
    merged.connected === true && merged.autoUpload === true,
  )
  ok('preserves schema version', merged.schemaVersion === 1)
})

// ---------- async ----------
;(async () => {
  await asyncGroup('initial getStatus', () => {
    const dir = freshSubdir('init-status')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('macbook-a1b2c3d4'),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    const s = m.getStatus()
    ok('not connected', s.connected === false)
    ok('autoUpload off', s.autoUpload === false)
    ok('deviceFolder exposed', s.deviceFolder === 'macbook-a1b2c3d4')
    ok('hasPendingOAuth false', s.hasPendingOAuth === false)
  })

  await asyncGroup('connect + completeConnect happy', async () => {
    const dir = freshSubdir('connect-happy')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient({
      account: { accountId: 'X', email: 'jose@me', name: 'J' },
    })
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('macbook-deadbeef'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    const { authUrl } = m.connect()
    ok('authUrl returned', typeof authUrl === 'string' && authUrl.length > 10)
    ok('hasPendingOAuth true', m.getStatus().hasPendingOAuth === true)
    const r = await m.completeConnect({ code: 'C', state: 'STATE' })
    ok('returns ok', r.ok === true)
    ok('account email captured', r.account.email === 'jose@me')
    const s = m.getStatus()
    ok('state.connected true', s.connected === true)
    ok('state.account persisted', s.account && s.account.email === 'jose@me')
    ok('hasPendingOAuth cleared', s.hasPendingOAuth === false)
    ok('completeAuth called with right args', dbx._captured.completeAuth.code === 'C')
    ok(
      'ensureFolder for device path',
      dbx._captured.lastEnsureFolder === '/macbook-deadbeef/snapshots',
    )
    // Persistence across reload
    const m2 = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('macbook-deadbeef'),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    ok('state persists across factory reload', m2.getStatus().connected === true)
  })

  await asyncGroup('completeConnect without connect throws', async () => {
    const dir = freshSubdir('connect-bad')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    let threw = null
    try {
      await m.completeConnect({ code: 'C', state: 'S' })
    } catch (e) {
      threw = e
    }
    ok('throws without prior connect()', threw && /No pending OAuth/.test(threw.message))
  })

  await asyncGroup('disconnect preserves autoUpload', async () => {
    const dir = freshSubdir('disconnect')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient()
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    m.setAutoUpload(true)
    ok('autoUpload on after set', m.getStatus().autoUpload === true)
    const r = m.disconnect()
    ok('disconnect returns ok', r.ok === true)
    ok('clearAuth called', dbx._calls.clearAuth === 1)
    const s = m.getStatus()
    ok('connected false', s.connected === false)
    ok('account null', s.account === null)
    ok('autoUpload preserved (true)', s.autoUpload === true)
  })

  await asyncGroup('setAutoUpload persists', async () => {
    const dir = freshSubdir('autoupload')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    m.setAutoUpload(true)
    const m2 = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: makeBackupManagerStub(dir),
    })
    ok('autoUpload persisted', m2.getStatus().autoUpload === true)
  })

  await asyncGroup('uploadSnapshot happy', async () => {
    const dir = freshSubdir('upload-happy')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient()
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-abcd1234'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    writeSnapshotFile(
      bm.snapshotsDir,
      '2026-05-10T22-00-00.000Z',
      Buffer.from('A'.repeat(1000)),
    )
    const r = await m.uploadSnapshot('2026-05-10T22-00-00.000Z')
    ok('returns ok', r.ok === true)
    ok(
      'remotePath returned',
      /\/dev-abcd1234\/snapshots\/2026-05-10T22-00-00\.000Z\.ozbackup/.test(r.remotePath),
    )
    ok('sizeBytes matches', r.sizeBytes === 1000)
    ok('upload called once', dbx._calls.upload === 1)
    ok(
      'upload path correct',
      dbx._captured.lastUpload.path.endsWith('/2026-05-10T22-00-00.000Z.ozbackup'),
    )
    ok('state.lastUploadAt set', !!m.getStatus().lastUploadAt)
    ok('state.lastUploadError null', m.getStatus().lastUploadError === null)
  })

  await asyncGroup('uploadSnapshot not connected', async () => {
    const dir = freshSubdir('upload-noconn')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    let threw = null
    try {
      await m.uploadSnapshot('foo')
    } catch (e) {
      threw = e
    }
    ok('throws not connected', threw && /not connected/.test(threw.message))
  })

  await asyncGroup('uploadSnapshot missing local file', async () => {
    const dir = freshSubdir('upload-missing')
    const bm = makeBackupManagerStub(dir)
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: makeDropboxClient(),
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    let threw = null
    try {
      await m.uploadSnapshot('nonexistent')
    } catch (e) {
      threw = e
    }
    ok('throws missing', threw && /local snapshot not found/.test(threw.message))
  })

  await asyncGroup('uploadSnapshot error captured in state', async () => {
    const dir = freshSubdir('upload-error')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient({ uploadShouldThrow: new Error('rate_limited') })
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    writeSnapshotFile(bm.snapshotsDir, '2026-05-10T01-00-00.000Z')
    let threw = null
    try {
      await m.uploadSnapshot('2026-05-10T01-00-00.000Z')
    } catch (e) {
      threw = e
    }
    ok('throws on upload error', threw && /rate_limited/.test(threw.message))
    const s = m.getStatus()
    ok('lastUploadError captured', s.lastUploadError === 'rate_limited')
    ok('lastUploadAt NOT updated', s.lastUploadAt === null)
  })

  await asyncGroup('listRemoteSnapshots filter + sort', async () => {
    const dir = freshSubdir('listsnaps')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient({
      listFolderImpl: (folder) => {
        if (folder === '/dev-abcd1234/snapshots') {
          return [
            {
              name: '2026-05-10T01-00-00.000Z.ozbackup',
              size: 100,
              isFolder: false,
              pathDisplay: '/dev-abcd1234/snapshots/2026-05-10T01-00-00.000Z.ozbackup',
              serverModified: '2026-05-10T01:00:00Z',
            },
            {
              name: '2026-05-09T22-00-00.000Z.ozbackup',
              size: 80,
              isFolder: false,
              pathDisplay: '/dev-abcd1234/snapshots/2026-05-09T22-00-00.000Z.ozbackup',
              serverModified: '2026-05-09T22:00:00Z',
            },
            { name: 'random-garbage.txt', size: 50, isFolder: false },
            { name: 'subfolder', isFolder: true },
          ]
        }
        return []
      },
    })
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-abcd1234'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    const items = await m.listRemoteSnapshots()
    ok('only 2 .ozbackup', items.length === 2)
    ok('newest first', items[0].id === '2026-05-10T01-00-00.000Z')
    ok('id strip extension', items[0].id === '2026-05-10T01-00-00.000Z')
    ok('size preserved', items[0].sizeBytes === 100)
    // Cross-device list
    dbx._captured.lastList = null
    const cross = await m.listRemoteSnapshots('other-dev-deadbeef')
    ok(
      'cross-device uses other folder',
      dbx._captured.lastList === '/other-dev-deadbeef/snapshots',
    )
    ok('cross-device returns empty for unknown', cross.length === 0)
  })

  await asyncGroup('deleteRemoteSnapshot', async () => {
    const dir = freshSubdir('delete')
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
    await m.deleteRemoteSnapshot('2026-05-10T01-00-00.000Z')
    ok('delete called once', dbx._calls.delete === 1)
    ok(
      'delete path correct',
      dbx._captured.lastDelete === '/dev-x/snapshots/2026-05-10T01-00-00.000Z.ozbackup',
    )
    // Cross-device delete
    await m.deleteRemoteSnapshot('SNAP-A', 'other-dev')
    ok(
      'cross-device delete path correct',
      dbx._captured.lastDelete === '/other-dev/snapshots/SNAP-A.ozbackup',
    )
  })

  await asyncGroup('init: auto-upload triggers when enabled', async () => {
    const dir = freshSubdir('autohook-on')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient()
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo('dev-auto'),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.init()
    const emit = (id, reason) =>
      bm.emit('snapshot-created', { id, filePath: '', header: { reason } })
    const tick = () => new Promise((r) => setTimeout(r, 30))
    emit('S0', 'daily-3am')
    await tick()
    ok('no upload while disconnected', dbx._calls.upload === 0)
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    m.setAutoUpload(true)
    writeSnapshotFile(bm.snapshotsDir, 'S1', Buffer.from('body1'))
    emit('S1', 'daily-3am')
    await tick()
    ok('uploaded after emit', dbx._calls.upload === 1)
    writeSnapshotFile(bm.snapshotsDir, 'S2', Buffer.from('body2'))
    emit('S2', 'pre-restore')
    await tick()
    ok('pre-restore skipped', dbx._calls.upload === 1)
    m.setAutoUpload(false)
    writeSnapshotFile(bm.snapshotsDir, 'S3', Buffer.from('body3'))
    emit('S3', 'manual')
    await tick()
    ok('no upload when autoUpload off', dbx._calls.upload === 1)
  })

  // NOTE: download / restoreFromCloud / listDevices tests viven en
  // cloud-backup-restore.smoketest.js (split de D-1.4 por límite 500 LOC).

  await asyncGroup('init: auto-upload error does NOT crash flow', async () => {
    const dir = freshSubdir('autohook-err')
    const bm = makeBackupManagerStub(dir)
    const dbx = makeDropboxClient({ uploadShouldThrow: new Error('boom') })
    const m = createCloudBackupManager({
      userDataDir: dir,
      deviceInfo: makeDeviceInfo(),
      dropboxClient: dbx,
      backupManager: bm,
    })
    m.init()
    m.connect()
    await m.completeConnect({ code: 'C', state: 'STATE' })
    m.setAutoUpload(true)
    writeSnapshotFile(bm.snapshotsDir, 'BAD')
    bm.emit('snapshot-created', { id: 'BAD', filePath: '', header: { reason: 'manual' } })
    // Should NOT throw / crash. Just logs.
    await new Promise((r) => setTimeout(r, 30))
    ok('listener swallowed error', m.getStatus().lastUploadError === 'boom')
  })

  // ---------- summary ----------
  console.log(`\n${'='.repeat(50)}`)
  console.log(`cloud-backup-manager smoke: ${passed} passed, ${failed} failed`)
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
