// OZ Browser — Cloud Backup IPC handlers smoke test (Bloque D-1.5).
//
// Cómo correr:
//   cd oz-browser
//   node tests/cloud-backup-handlers.smoketest.js
//
// Cubre:
//   - status: pass-through
//   - connect: invokes shell.openExternal + returns authUrl
//   - disconnect: pass-through + broadcast
//   - setAutoUpload: pass-through + broadcast
//   - uploadNow: BAD_ARG / success+broadcast / error mapped
//   - listRemoteSnapshots / listDevices: pass-through + error mapped
//   - downloadAndRestore: LOCKED if vault locked, BAD_ARG without snapshotId
//   - downloadAndRestore happy: creates pre-restore + restores + locks vault
//   - downloadAndRestore: restoreFromCloud fails → returns preRestoreId
//   - deleteRemote: BAD_ARG / success+broadcast
//
// Cargamos cloud-backup-handlers.js con un mock de Electron en require cache
// (igual que account-handlers smoke). El mock provee `shell.openExternal`
// pero no necesita ipcMain (el handler module no lo usa).

const path = require('path')
const Module = require('module')

// Inject a fake electron module into require cache before the SUT loads.
const fakeShell = {
  openExternal: async (url) => {
    fakeShell.lastUrl = url
    return true
  },
}
const fakeElectron = { shell: fakeShell }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return 'electron-fake'
  return origResolve.call(this, req, parent, ...rest)
}
require.cache['electron-fake'] = {
  id: 'electron-fake',
  filename: 'electron-fake',
  loaded: true,
  exports: fakeElectron,
}

const { buildCloudBackupHandlers } = require('../browser/cloud-backup-handlers')

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

function makeBrowser(opts = {}) {
  const broadcasts = []
  const cbMgr = opts.cbMgr || {
    getStatus: () => ({ connected: true, deviceFolder: 'dev-x' }),
    connect: () => ({ authUrl: 'https://example/oauth' }),
    disconnect: () => ({ ok: true }),
    setAutoUpload: (b) => ({ autoUpload: b }),
    uploadSnapshot: async () => ({ ok: true, snapshotId: 'S', remotePath: '/r' }),
    listRemoteSnapshots: async () => [],
    listDevices: async () => [],
    restoreFromCloud: async () => ({ ok: true, restoredCount: 5 }),
    deleteRemoteSnapshot: async () => ({ ok: true }),
  }
  const backupMgr = opts.backupMgr || {
    createSnapshot: () => ({ id: 'PRE-SNAP', filePath: '', header: {} }),
  }
  const vault = opts.vault || { isUnlocked: true, lock: () => {} }
  return {
    cloudBackupManager: cbMgr,
    backupManager: backupMgr,
    accountVault: vault,
    broadcastToWebUI: (...args) => broadcasts.push(args),
    _broadcasts: broadcasts,
  }
}

;(async () => {
  await asyncGroup('status', () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r = h.status()
    ok('returns status', r.connected === true && r.deviceFolder === 'dev-x')
  })

  await asyncGroup('connect opens external', async () => {
    const b = makeBrowser()
    fakeShell.lastUrl = null
    const h = buildCloudBackupHandlers(b)
    const r = await h.connect()
    ok('returns ok', r.ok === true)
    ok('authUrl returned', /example\/oauth/.test(r.authUrl))
    ok('shell.openExternal called', fakeShell.lastUrl === 'https://example/oauth')
  })

  await asyncGroup('disconnect broadcasts', () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r = h.disconnect()
    ok('returns ok', r.ok === true)
    ok(
      'broadcast emitted',
      b._broadcasts.some((args) => args[0] === 'oz:cloud-backup:changed'),
    )
  })

  await asyncGroup('setAutoUpload broadcasts', () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r = h.setAutoUpload(true)
    ok('returns autoUpload', r.autoUpload === true)
    ok(
      'broadcast emitted',
      b._broadcasts.some((args) => args[0] === 'oz:cloud-backup:changed'),
    )
  })

  await asyncGroup('uploadNow validation', async () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r = await h.uploadNow()
    ok('BAD_ARG no snapshotId', r.__error && r.__error.code === 'BAD_ARG')
  })

  await asyncGroup('uploadNow happy', async () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r = await h.uploadNow('SNAP-1')
    ok('ok', r.ok === true)
    ok(
      'broadcast emitted',
      b._broadcasts.some((args) => args[0] === 'oz:cloud-backup:changed'),
    )
  })

  await asyncGroup('uploadNow error mapped', async () => {
    const b = makeBrowser({
      cbMgr: {
        ...makeBrowser().cloudBackupManager,
        uploadSnapshot: async () => {
          const e = new Error('rate_limited')
          e.code = 'API_ERROR'
          throw e
        },
      },
    })
    const h = buildCloudBackupHandlers(b)
    const r = await h.uploadNow('SNAP-1')
    ok('returns __error', !!(r && r.__error))
    ok('error code propagated', r.__error.code === 'API_ERROR')
    ok('error message propagated', r.__error.message === 'rate_limited')
  })

  await asyncGroup('listDevices pass-through', async () => {
    const sample = [{ deviceFolder: 'dev-a', isCurrentDevice: true }]
    const b = makeBrowser({
      cbMgr: {
        ...makeBrowser().cloudBackupManager,
        listDevices: async () => sample,
      },
    })
    const h = buildCloudBackupHandlers(b)
    const r = await h.listDevices()
    ok('passes array through', Array.isArray(r) && r[0].deviceFolder === 'dev-a')
  })

  await asyncGroup('listRemoteSnapshots pass-through', async () => {
    const b = makeBrowser({
      cbMgr: {
        ...makeBrowser().cloudBackupManager,
        listRemoteSnapshots: async (f) => [{ id: 'X', from: f || 'default' }],
      },
    })
    const h = buildCloudBackupHandlers(b)
    const r = await h.listRemoteSnapshots('other-dev')
    ok('cross-device forwarded', r[0].from === 'other-dev')
    const r2 = await h.listRemoteSnapshots()
    ok('default forwarded', r2[0].from === 'default')
  })

  await asyncGroup('downloadAndRestore: LOCKED', async () => {
    const b = makeBrowser({ vault: { isUnlocked: false } })
    const h = buildCloudBackupHandlers(b)
    const r = await h.downloadAndRestore({ snapshotId: 'X' })
    ok('returns LOCKED', r.__error && r.__error.code === 'LOCKED')
  })

  await asyncGroup('downloadAndRestore: BAD_ARG', async () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r = await h.downloadAndRestore({})
    ok('BAD_ARG no snapshotId', r.__error && r.__error.code === 'BAD_ARG')
  })

  await asyncGroup('downloadAndRestore: happy', async () => {
    const lockCalls = []
    const b = makeBrowser({
      vault: {
        isUnlocked: true,
        lock: () => lockCalls.push(1),
      },
    })
    const h = buildCloudBackupHandlers(b)
    const r = await h.downloadAndRestore({ snapshotId: 'SNAP', deviceFolder: 'dev-b' })
    ok('returns ok', r.ok === true)
    ok('preRestoreId set', r.preRestoreId === 'PRE-SNAP')
    ok('deviceFolder echoed', r.deviceFolder === 'dev-b')
    ok('vault locked after restore', lockCalls.length === 1)
    ok(
      'cloud-backup change broadcasted',
      b._broadcasts.some((args) => args[0] === 'oz:cloud-backup:changed'),
    )
    ok(
      'timemachine restore-completed broadcasted',
      b._broadcasts.some((args) => args[0] === 'oz:timemachine:restore-completed'),
    )
    ok('requiresRestart flag', r.requiresRestart === true)
  })

  await asyncGroup('downloadAndRestore: pre-restore failure', async () => {
    const b = makeBrowser({
      backupMgr: {
        createSnapshot: () => {
          throw new Error('vault read fail')
        },
      },
    })
    const h = buildCloudBackupHandlers(b)
    const r = await h.downloadAndRestore({ snapshotId: 'X' })
    ok('returns PRE_RESTORE_FAILED', r.__error && r.__error.code === 'PRE_RESTORE_FAILED')
  })

  await asyncGroup('downloadAndRestore: restore fails returns preRestoreId', async () => {
    const b = makeBrowser({
      cbMgr: {
        ...makeBrowser().cloudBackupManager,
        restoreFromCloud: async () => {
          const e = new Error('decrypt fail')
          e.code = 'AUTH_TAG_MISMATCH'
          throw e
        },
      },
    })
    const h = buildCloudBackupHandlers(b)
    const r = await h.downloadAndRestore({ snapshotId: 'X' })
    ok('returns __error', !!(r && r.__error))
    ok('error code propagated', r.__error.code === 'AUTH_TAG_MISMATCH')
    ok('preRestoreId in error extra', r.__error.preRestoreId === 'PRE-SNAP', {
      actual: r.__error.preRestoreId,
    })
  })

  await asyncGroup('deleteRemote validation + happy', async () => {
    const b = makeBrowser()
    const h = buildCloudBackupHandlers(b)
    const r1 = await h.deleteRemote({})
    ok('BAD_ARG no snapshotId', r1.__error && r1.__error.code === 'BAD_ARG')
    const r2 = await h.deleteRemote({ snapshotId: 'X' })
    ok('ok', r2.ok === true)
    ok(
      'broadcast emitted',
      b._broadcasts.some((args) => args[0] === 'oz:cloud-backup:changed'),
    )
  })

  console.log(`\n${'='.repeat(50)}`)
  console.log(`cloud-backup-handlers smoke: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f.label}`)
  }
  process.exit(failed === 0 ? 0 : 1)
})()
