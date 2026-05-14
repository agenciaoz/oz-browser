// OZ Browser — Scheduled Action handlers smoke test (Bloque F-2, v1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/scheduled-action-handlers.smoketest.js
//
// Cubre:
//   - createOpenWorkspaceHandler: params validation, locked-vault skip,
//     success path with return-value capture, error propagation, BAD_DEP
//   - createSyncPushHandler: locked-vault skip, success, error propagation
//   - createBackupSnapshotHandler: locked-vault skip, opts whitelist
//     sanitization, missing-id error, success shape
//   - registerScheduledActionHandlers: end-to-end via real ScheduledActions
//     — handlers fire via tick() with synthetic clock, lastResult.value
//     preserves handler return; partial deps register subset; bad deps
//     reject early.

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const { ScheduledActions } = require('../browser/scheduled-actions')
const {
  createOpenWorkspaceHandler,
  createSyncPushHandler,
  createBackupSnapshotHandler,
  registerScheduledActionHandlers,
  ACTION_TYPES,
  ACTION_OPEN_WORKSPACE,
  ACTION_SYNC_PUSH,
  ACTION_BACKUP_SNAPSHOT,
} = require('../browser/scheduled-action-handlers')

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
    caught ? `caught code=${caught.code} message=${caught.message}` : 'did not throw',
  )
}

async function rejectsWithCode(label, promiseFn, code) {
  let caught = null
  try {
    await promiseFn()
  } catch (e) {
    caught = e
  }
  ok(
    label,
    !!caught && caught.code === code,
    caught ? `caught code=${caught.code} message=${caught.message}` : 'did not reject',
  )
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-handlers-'))
  return path.join(dir, name)
}

function makeClock(start) {
  const state = { now: start }
  const fn = () => state.now
  fn.advance = (ms) => {
    state.now += ms
  }
  return fn
}

function makeVault(locked) {
  return { isLocked: () => locked }
}

// ===========================================================================
// constants
// ===========================================================================
console.log('\n[constants]')

ok(
  'ACTION_TYPES has the v1 three',
  ACTION_TYPES.length === 3 &&
    ACTION_TYPES.includes(ACTION_OPEN_WORKSPACE) &&
    ACTION_TYPES.includes(ACTION_SYNC_PUSH) &&
    ACTION_TYPES.includes(ACTION_BACKUP_SNAPSHOT),
)
ok('ACTION_TYPES is frozen', Object.isFrozen(ACTION_TYPES))

// ===========================================================================
// createOpenWorkspaceHandler
// ===========================================================================
;(async () => {
  console.log('\n[open-workspace]')

  throwsWithCode(
    'factory rejects missing openWorkspace dep',
    () => createOpenWorkspaceHandler({}),
    'BAD_DEP',
  )

  // No vault dep — should still work (vault is optional).
  const calls = []
  const handler = createOpenWorkspaceHandler({
    openWorkspace: async (id) => {
      calls.push(id)
      return { focused: true }
    },
  })

  await rejectsWithCode(
    'rejects missing params.workspaceId',
    () => handler({}),
    'BAD_PARAMS',
  )
  await rejectsWithCode(
    'rejects empty workspaceId',
    () => handler({ workspaceId: '' }),
    'BAD_PARAMS',
  )
  await rejectsWithCode(
    'rejects non-string workspaceId',
    () => handler({ workspaceId: 123 }),
    'BAD_PARAMS',
  )

  const result = await handler({ workspaceId: 'ws-A' })
  ok(
    'success returns ok + workspaceId',
    result &&
      result.ok === true &&
      result.workspaceId === 'ws-A' &&
      result.opened &&
      result.opened.focused === true,
  )
  ok('underlying fn called with id', calls.length === 1 && calls[0] === 'ws-A')

  // Vault locked → skip without calling fn
  const calls2 = []
  const handlerLocked = createOpenWorkspaceHandler({
    openWorkspace: async (id) => {
      calls2.push(id)
      return 'should-not-happen'
    },
    vault: makeVault(true),
  })
  const skipResult = await handlerLocked({ workspaceId: 'ws-A' })
  ok(
    'vault locked → returns skipped+reason',
    skipResult && skipResult.skipped === true && skipResult.reason === 'vault-locked',
  )
  ok('vault locked → underlying fn NOT called', calls2.length === 0)

  // Error propagation
  const handlerErr = createOpenWorkspaceHandler({
    openWorkspace: async () => {
      const e = new Error('workspace gone')
      e.code = 'GONE'
      throw e
    },
  })
  await rejectsWithCode(
    'errors propagate from openWorkspace',
    () => handlerErr({ workspaceId: 'ws-Z' }),
    'GONE',
  )

  // ====================
  console.log('\n[sync-push]')

  throwsWithCode(
    'factory rejects missing syncPush dep',
    () => createSyncPushHandler({}),
    'BAD_DEP',
  )

  let pushCount = 0
  const pushHandler = createSyncPushHandler({
    syncPush: async () => {
      pushCount++
      return { pending: 0 }
    },
  })
  const pushOk = await pushHandler({})
  ok(
    'sync-push success shape',
    pushOk &&
      pushOk.ok === true &&
      pushOk.pushed &&
      pushOk.pushed.pending === 0 &&
      pushCount === 1,
  )

  const pushHandlerLocked = createSyncPushHandler({
    syncPush: async () => {
      pushCount++
      return 'never'
    },
    vault: makeVault(true),
  })
  const pushSkip = await pushHandlerLocked({})
  ok(
    'sync-push vault locked → skipped',
    pushSkip && pushSkip.skipped === true && pushSkip.reason === 'vault-locked',
  )
  ok('sync-push locked → did NOT call fn', pushCount === 1)

  const pushHandlerErr = createSyncPushHandler({
    syncPush: async () => {
      const e = new Error('dropbox 502')
      e.code = 'NET'
      throw e
    },
  })
  await rejectsWithCode('sync-push errors propagate', () => pushHandlerErr({}), 'NET')

  // ====================
  console.log('\n[backup-snapshot]')

  throwsWithCode(
    'factory rejects missing backupManager',
    () => createBackupSnapshotHandler({}),
    'BAD_DEP',
  )
  throwsWithCode(
    'factory rejects backupManager without createSnapshot',
    () => createBackupSnapshotHandler({ backupManager: {} }),
    'BAD_DEP',
  )

  const snapCalls = []
  const okBackup = {
    createSnapshot: async (opts) => {
      snapCalls.push(opts)
      return { id: 'snap-1', createdAt: 1700 }
    },
  }
  const snapHandler = createBackupSnapshotHandler({ backupManager: okBackup })
  const snapResult = await snapHandler({
    label: 'nightly',
    // Junk fields that should be silently dropped:
    secret: 'haha',
    onlyKeep: 999,
    reason: 'cron',
  })
  ok(
    'backup-snapshot success shape',
    snapResult &&
      snapResult.ok === true &&
      snapResult.snapshotId === 'snap-1' &&
      snapResult.createdAt === 1700,
  )
  ok(
    'backup-snapshot params whitelisted (label+reason kept)',
    snapCalls.length === 1 &&
      snapCalls[0].label === 'nightly' &&
      snapCalls[0].reason === 'cron' &&
      !('secret' in snapCalls[0]) &&
      !('onlyKeep' in snapCalls[0]),
  )

  // Long label is dropped, not truncated weirdly
  const snapHandler2 = createBackupSnapshotHandler({ backupManager: okBackup })
  await snapHandler2({ label: 'x'.repeat(200) })
  ok(
    'backup-snapshot label >80 chars is dropped',
    snapCalls[1] && !('label' in snapCalls[1]),
  )

  // Locked vault skip
  const snapLockedHandler = createBackupSnapshotHandler({
    backupManager: okBackup,
    vault: makeVault(true),
  })
  const snapSkip = await snapLockedHandler({})
  ok(
    'backup-snapshot vault locked → skipped',
    snapSkip && snapSkip.skipped === true && snapSkip.reason === 'vault-locked',
  )
  ok(
    'backup-snapshot locked → underlying createSnapshot NOT called',
    snapCalls.length === 2, // still only the two from above
  )

  // Missing-id error
  const badBackup = {
    createSnapshot: async () => ({ noId: true }),
  }
  const snapBadHandler = createBackupSnapshotHandler({ backupManager: badBackup })
  await rejectsWithCode(
    'backup-snapshot rejects missing id from createSnapshot',
    () => snapBadHandler({}),
    'BAD_RESULT',
  )

  // ====================
  console.log('\n[registerScheduledActionHandlers — end-to-end]')

  throwsWithCode(
    'register rejects bad ScheduledActions arg',
    () => registerScheduledActionHandlers({}, { syncPush: async () => null }),
    'BAD_ARG',
  )

  // Partial deps: only sync-push wired
  {
    const fp = tmpFile('sa.json')
    const clock = makeClock(1_700_000_000_000)
    const s = new ScheduledActions({ filePath: fp, clock })
    s.load()
    const regd = registerScheduledActionHandlers(s, {
      syncPush: async () => 'pushed',
    })
    ok(
      'partial deps only registers what was provided',
      regd.length === 1 && regd[0] === ACTION_SYNC_PUSH,
    )
    ok('open-workspace NOT registered', !s.hasHandler(ACTION_OPEN_WORKSPACE))
    ok('sync-push IS registered', s.hasHandler(ACTION_SYNC_PUSH))
    ok('backup-snapshot NOT registered', !s.hasHandler(ACTION_BACKUP_SNAPSHOT))
  }

  // Full wire-up via tick() — exercise real runner integration
  {
    const fp = tmpFile('sa.json')
    const clock = makeClock(1_700_000_000_000)
    const log = []
    const wsCalls = []
    const pushHits = []
    const snapHits = []
    const fakeBackup = {
      createSnapshot: async (opts) => {
        snapHits.push(opts)
        return { id: `snap-${snapHits.length}`, createdAt: clock() }
      },
    }

    const s = new ScheduledActions({ filePath: fp, clock })
    s.load()
    const regd = registerScheduledActionHandlers(s, {
      openWorkspace: async (id) => {
        wsCalls.push(id)
        return { opened: id }
      },
      syncPush: async () => {
        pushHits.push(clock())
        return { pending: 0 }
      },
      backupManager: fakeBackup,
      vault: { isLocked: () => false },
    })
    ok(
      'register returns all 3 types',
      regd.length === 3 && ACTION_TYPES.every((t) => regd.includes(t)),
    )

    // Three actions, one of each, fire at 1min cadence
    const aWs = s.create({
      name: 'morning-ws',
      action: ACTION_OPEN_WORKSPACE,
      params: { workspaceId: 'ws-A' },
      schedule: { type: 'every-minutes', minutes: 1 },
    })
    const aPush = s.create({
      name: 'nightly-push',
      action: ACTION_SYNC_PUSH,
      schedule: { type: 'every-minutes', minutes: 1 },
    })
    const aSnap = s.create({
      name: 'nightly-snap',
      action: ACTION_BACKUP_SNAPSHOT,
      params: { label: 'cron' },
      schedule: { type: 'every-minutes', minutes: 1 },
    })

    clock.advance(70_000) // > 1 minute
    await s.tick(clock())

    ok('open-workspace fired once', wsCalls.length === 1 && wsCalls[0] === 'ws-A')
    ok('sync-push fired once', pushHits.length === 1)
    ok(
      'backup-snapshot fired once with whitelisted label',
      snapHits.length === 1 && snapHits[0].label === 'cron',
    )
    ok(
      'open-workspace lastResult.value preserved',
      s.get(aWs.id).lastResult.value.workspaceId === 'ws-A' &&
        s.get(aWs.id).lastResult.value.opened &&
        s.get(aWs.id).lastResult.value.opened.opened === 'ws-A',
    )
    ok(
      'sync-push lastResult.value preserved',
      s.get(aPush.id).lastResult.value.pushed &&
        s.get(aPush.id).lastResult.value.pushed.pending === 0,
    )
    ok(
      'backup-snapshot lastResult.value carries snapshotId',
      s.get(aSnap.id).lastResult.value.snapshotId === 'snap-1',
    )

    void log // reserved for future enrichment
  }

  // Locked vault path via tick()
  {
    const fp = tmpFile('sa.json')
    const clock = makeClock(1_700_000_000_000)
    let isLocked = true
    const pushHits = []
    const s = new ScheduledActions({ filePath: fp, clock })
    s.load()
    registerScheduledActionHandlers(s, {
      syncPush: async () => {
        pushHits.push(clock())
        return 'pushed'
      },
      vault: { isLocked: () => isLocked },
    })
    const a = s.create({
      name: 'push-while-locked',
      action: ACTION_SYNC_PUSH,
      schedule: { type: 'every-minutes', minutes: 1 },
    })

    clock.advance(70_000)
    await s.tick(clock())
    ok('locked → underlying syncPush NOT called', pushHits.length === 0)
    ok(
      'locked tick still marks lastResult.ok=true (it was a benign skip)',
      s.get(a.id).lastResult &&
        s.get(a.id).lastResult.ok === true &&
        s.get(a.id).lastResult.value &&
        s.get(a.id).lastResult.value.skipped === true,
    )

    // Now unlock and tick again → next tick should fire normally
    isLocked = false
    clock.advance(70_000)
    await s.tick(clock())
    ok('after unlock → syncPush fires', pushHits.length === 1)
  }

  // Final report
  console.log(`\n=== passed=${passed} failed=${failed} ===`)
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
    }
    process.exit(1)
  }
})().catch((err) => {
  console.error('UNEXPECTED ERR:', err)
  process.exit(2)
})
