// OZ Browser — Sync Pull smoke test (D-3c-2 CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-pull.smoketest.js
//
// Cubre:
//   - registerSource validation
//   - cold-start: no cursor → listFolder; subsequent → listFolderContinue
//   - decode + LWW merge: remote newer → 'remote-apply' (upsert)
//   - LWW merge: local newer → 'local-wins'
//   - tombstone (deleted=true) → 'remote-apply' action=delete
//   - skip self-upload (header.deviceFolder === this.deviceFolder)
//   - skip Dropbox-level delete (entry.isDeleted)
//   - decode failure → 'warn' + skip + errors++
//   - recordType mismatch in header → 'warn' + skip
//   - cursor persistence across instances
//   - state schema mismatch → start fresh + warn
//   - state corrupt JSON → start fresh + warn
//   - vault locked → 'paused' + status='vault-locked'
//   - dropbox unauthenticated → 'paused' + status='unauthenticated'

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const { SyncPuller } = require('../browser/sync-pull')
const { encodeRecord } = require('../browser/sync-record-store')

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
    caught
      ? `threw code=${caught.code} message=${caught.message.slice(0, 80)}`
      : 'did not throw',
  )
}

function section(name) {
  console.log(`\n— ${name} —`)
}

// ---------- Test doubles ----------------------------------------------------

const MASTER_KEY = crypto.randomBytes(32)

function makeFakeVault({ unlocked = true } = {}) {
  const state = { unlocked }
  return {
    get isUnlocked() {
      return state.unlocked
    },
    getMasterKey() {
      return state.unlocked ? MASTER_KEY : null
    },
    _setUnlocked(v) {
      state.unlocked = v
    },
  }
}

function makeFakeDropbox({ authenticated = true } = {}) {
  const folders = new Map() // path → entries[] (each entry has pathDisplay, isFolder, isDeleted, etc)
  const records = new Map() // pathDisplay → Buffer
  let nextCursor = 1
  const state = { authenticated, nextError: null }
  const calls = { listFolder: 0, listFolderContinue: 0, download: 0 }

  return {
    isAuthenticated() {
      return state.authenticated
    },
    async listFolder(p) {
      calls.listFolder++
      if (state.nextError) {
        const e = state.nextError
        state.nextError = null
        throw e
      }
      const entries = folders.get(p) || []
      const cursor = `cursor-${p}-${nextCursor++}`
      return { entries: entries.slice(), cursor, hasMore: false }
    },
    async listFolderContinue(c) {
      calls.listFolderContinue++
      if (state.nextError) {
        const e = state.nextError
        state.nextError = null
        throw e
      }
      // For tests, we return a "delta" stored under the cursor key.
      const entries = folders.get(`__delta__:${c}`) || []
      const newCursor = `cursor-continue-${nextCursor++}`
      return { entries: entries.slice(), cursor: newCursor, hasMore: false }
    },
    async download(p) {
      calls.download++
      const b = records.get(p)
      if (!b) {
        const e = new Error('not_found ' + p)
        e.code = 'NOT_FOUND'
        throw e
      }
      return b
    },

    // Test helpers:
    _setFolderEntries(p, entries) {
      folders.set(p, entries)
    },
    _setDeltaForCursor(cursor, entries) {
      folders.set(`__delta__:${cursor}`, entries)
    },
    _setRecord(pathDisplay, buf) {
      records.set(pathDisplay, buf)
    },
    _setNextError(err) {
      state.nextError = err
    },
    _setAuthenticated(v) {
      state.authenticated = v
    },
    _calls: calls,
  }
}

function makeEntry(
  pathDisplay,
  { isFolder = false, isDeleted = false, size = 256 } = {},
) {
  return {
    name: pathDisplay.split('/').pop(),
    pathDisplay,
    pathLower: pathDisplay.toLowerCase(),
    size,
    serverModified: '2026-05-13T20:00:00.000Z',
    isFolder,
    isDeleted,
  }
}

function makeHeader(over = {}) {
  return {
    schemaVersion: 1,
    updatedAt: '2026-05-11T10:00:00.000Z',
    deviceFolder: 'mac-bbbb2222', // remote device by default
    recordType: 'identity',
    recordId: 'rec-1',
    deleted: false,
    ...over,
  }
}

function makeBody(over = {}) {
  return {
    id: 'rec-1',
    name: 'Remote Cliente',
    color: '#5b8def',
    fingerprintSeed: 'remote-seed',
    workspaceId: 'general',
    userAgent: null,
    createdAt: 1715346000000,
    updatedAt: '2026-05-11T10:00:00.000Z',
    ...over,
  }
}

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-pull-'))
  return path.join(dir, 'sync-state.json')
}

function makePuller(overrides = {}) {
  const vault = overrides.vault || makeFakeVault()
  const dropbox = overrides.dropbox || makeFakeDropbox()
  const stateFilePath = overrides.stateFilePath || tmpStateFile()
  const puller = new SyncPuller({
    vault,
    dropbox,
    deviceFolder: overrides.deviceFolder || 'mac-aaaa1111',
    appFolder: 'sync',
    stateFilePath,
  })
  return { puller, vault, dropbox, stateFilePath }
}

console.log('OZ Browser — sync-pull smoke test')

// 1. Constructor + registerSource validation
section('Constructor + registerSource validation')
{
  const dropbox = makeFakeDropbox()
  const vault = makeFakeVault()
  const stateFilePath = tmpStateFile()
  throwsWithCode(
    'missing dropbox → BAD_ARG',
    () => new SyncPuller({ vault, deviceFolder: 'mac-aa', stateFilePath }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing vault → BAD_ARG',
    () => new SyncPuller({ dropbox, deviceFolder: 'mac-aa', stateFilePath }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing deviceFolder → BAD_ARG',
    () => new SyncPuller({ dropbox, vault, stateFilePath }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing stateFilePath → BAD_ARG',
    () => new SyncPuller({ dropbox, vault, deviceFolder: 'mac-aa' }),
    'BAD_ARG',
  )

  const { puller } = makePuller()
  throwsWithCode(
    'registerSource without recordType → BAD_SOURCE',
    () => puller.registerSource({ fetchRecord: () => null }),
    'BAD_SOURCE',
  )
  throwsWithCode(
    'registerSource without fetchRecord → BAD_SOURCE',
    () => puller.registerSource({ recordType: 'identity' }),
    'BAD_SOURCE',
  )
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })
  throwsWithCode(
    'duplicate recordType → SOURCE_DUP',
    () => puller.registerSource({ recordType: 'identity', fetchRecord: () => null }),
    'SOURCE_DUP',
  )
}

// 2. Cold start: no cursor → listFolder
section('Cold start: no cursor → listFolder')
;(async () => {
  const { puller, dropbox } = makePuller()
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })

  const remoteHeader = makeHeader({ recordId: 'rec-cold' })
  const remoteBody = makeBody({ id: 'rec-cold', name: 'From Remote' })
  const buf = encodeRecord(MASTER_KEY, remoteHeader, remoteBody)
  dropbox._setRecord('/sync/identitys/rec-cold.json.enc', buf)
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-cold.json.enc'),
  ])

  const applies = []
  puller.on('remote-apply', (e) => applies.push(e))

  const r = await puller.pullOnce('identity')
  ok("status === 'ok'", r.status === 'ok')
  ok('listFolder called', dropbox._calls.listFolder === 1)
  ok('listFolderContinue not called yet', dropbox._calls.listFolderContinue === 0)
  ok('1 remote-apply emitted', applies.length === 1)
  ok("action === 'upsert'", applies[0].action === 'upsert')
  ok('recordId matches', applies[0].recordId === 'rec-cold')
  ok('body.name matches', applies[0].body.name === 'From Remote')
  ok('header.deleted === false', applies[0].header.deleted === false)
  ok('cursor persisted', typeof r.cursor === 'string' && r.cursor.length > 0)
  ok('stats.applied === 1', r.applied === 1)
})()

// 3. Subsequent pull uses listFolderContinue
section('Subsequent pull: cursor → listFolderContinue')
;(async () => {
  const { puller, dropbox } = makePuller()
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })

  // First pull (cold start, no entries)
  dropbox._setFolderEntries('/sync/identitys', [])
  await puller.pullOnce('identity')
  const firstCursor = puller.cursorFor('identitys')
  ok('first cursor stored', firstCursor && typeof firstCursor === 'string')

  // Setup delta for the stored cursor
  const remoteHeader = makeHeader({ recordId: 'rec-delta' })
  const remoteBody = makeBody({ id: 'rec-delta', name: 'Delta Cliente' })
  const buf = encodeRecord(MASTER_KEY, remoteHeader, remoteBody)
  dropbox._setRecord('/sync/identitys/rec-delta.json.enc', buf)
  dropbox._setDeltaForCursor(firstCursor, [
    makeEntry('/sync/identitys/rec-delta.json.enc'),
  ])

  const applies = []
  puller.on('remote-apply', (e) => applies.push(e))

  const r2 = await puller.pullOnce('identity')
  ok("status === 'ok'", r2.status === 'ok')
  ok('listFolderContinue called', dropbox._calls.listFolderContinue === 1)
  ok('delta produced 1 apply', applies.length === 1)
  ok('cursor advanced', puller.cursorFor('identitys') !== firstCursor)
})()

// 4. LWW: remote newer → take-remote
section('LWW: remote newer → take-remote (upsert)')
;(async () => {
  const localRecord = {
    id: 'rec-conflict',
    name: 'Local Older',
    updatedAt: '2026-05-11T09:00:00.000Z',
  }
  const { puller, dropbox } = makePuller()
  puller.registerSource({
    recordType: 'identity',
    fetchRecord: (id) => (id === 'rec-conflict' ? localRecord : null),
  })

  const remoteHeader = makeHeader({
    recordId: 'rec-conflict',
    updatedAt: '2026-05-11T11:00:00.000Z',
  })
  const remoteBody = makeBody({ id: 'rec-conflict', name: 'Remote Newer' })
  const buf = encodeRecord(MASTER_KEY, remoteHeader, remoteBody)
  dropbox._setRecord('/sync/identitys/rec-conflict.json.enc', buf)
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-conflict.json.enc'),
  ])

  const applies = []
  const localWins = []
  puller.on('remote-apply', (e) => applies.push(e))
  puller.on('local-wins', (e) => localWins.push(e))

  const r = await puller.pullOnce('identity')
  ok('remote-apply emitted (newer remote wins)', applies.length === 1)
  ok('body shows remote version', applies[0].body.name === 'Remote Newer')
  ok('no local-wins event', localWins.length === 0)
  ok('stats.applied === 1', r.applied === 1)
})()

// 5. LWW: local newer → keep-local
section('LWW: local newer → keep-local')
;(async () => {
  const localRecord = {
    id: 'rec-local-wins',
    name: 'Local Newer',
    updatedAt: '2026-05-11T12:00:00.000Z',
  }
  const { puller, dropbox } = makePuller()
  puller.registerSource({
    recordType: 'identity',
    fetchRecord: (id) => (id === 'rec-local-wins' ? localRecord : null),
  })

  const remoteHeader = makeHeader({
    recordId: 'rec-local-wins',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  const remoteBody = makeBody({ id: 'rec-local-wins' })
  const buf = encodeRecord(MASTER_KEY, remoteHeader, remoteBody)
  dropbox._setRecord('/sync/identitys/rec-local-wins.json.enc', buf)
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-local-wins.json.enc'),
  ])

  const applies = []
  const localWins = []
  puller.on('remote-apply', (e) => applies.push(e))
  puller.on('local-wins', (e) => localWins.push(e))

  const r = await puller.pullOnce('identity')
  ok('no remote-apply', applies.length === 0)
  ok('1 local-wins emitted', localWins.length === 1)
  ok("reason === 'local-newer'", localWins[0].reason === 'local-newer')
  ok('stats.localWins === 1', r.localWins === 1)
})()

// 6. Remote tombstone → remote-apply action=delete
section('Remote tombstone → remote-apply action=delete')
;(async () => {
  const localRecord = {
    id: 'rec-tomb',
    name: 'Will Be Deleted',
    updatedAt: '2026-05-11T09:00:00.000Z',
  }
  const { puller, dropbox } = makePuller()
  puller.registerSource({
    recordType: 'identity',
    fetchRecord: (id) => (id === 'rec-tomb' ? localRecord : null),
  })

  const remoteHeader = makeHeader({
    recordId: 'rec-tomb',
    updatedAt: '2026-05-11T11:00:00.000Z',
    deleted: true,
    deletedAt: '2026-05-11T11:00:00.000Z',
  })
  const buf = encodeRecord(MASTER_KEY, remoteHeader, null)
  dropbox._setRecord('/sync/identitys/rec-tomb.json.enc', buf)
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-tomb.json.enc'),
  ])

  const applies = []
  puller.on('remote-apply', (e) => applies.push(e))

  await puller.pullOnce('identity')
  ok('1 remote-apply emitted', applies.length === 1)
  ok("action === 'delete'", applies[0].action === 'delete')
  ok('body === null', applies[0].body === null)
  ok(
    'header.deletedAt preserved',
    applies[0].header.deletedAt === '2026-05-11T11:00:00.000Z',
  )
})()

// 7. Skip self-uploads (deviceFolder match)
section('Skip self-uploads')
;(async () => {
  const { puller, dropbox } = makePuller({ deviceFolder: 'mac-aaaa1111' })
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })

  // Self-upload: deviceFolder matches the puller's deviceFolder
  const selfHeader = makeHeader({
    recordId: 'rec-self',
    deviceFolder: 'mac-aaaa1111',
  })
  const selfBuf = encodeRecord(MASTER_KEY, selfHeader, makeBody({ id: 'rec-self' }))
  dropbox._setRecord('/sync/identitys/rec-self.json.enc', selfBuf)

  // Remote upload from another device
  const remoteHeader = makeHeader({
    recordId: 'rec-other',
    deviceFolder: 'mac-bbbb2222',
  })
  const remoteBuf = encodeRecord(MASTER_KEY, remoteHeader, makeBody({ id: 'rec-other' }))
  dropbox._setRecord('/sync/identitys/rec-other.json.enc', remoteBuf)

  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-self.json.enc'),
    makeEntry('/sync/identitys/rec-other.json.enc'),
  ])

  const applies = []
  puller.on('remote-apply', (e) => applies.push(e))

  const r = await puller.pullOnce('identity')
  ok('only the foreign upload is applied', applies.length === 1)
  ok('foreign upload is the one applied', applies[0].recordId === 'rec-other')
  ok('self-upload counts as skipped', r.skipped >= 1)
})()

// 8. Skip Dropbox-level deletes (isDeleted=true)
section('Skip Dropbox-level deletes')
;(async () => {
  const { puller, dropbox } = makePuller()
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-gone.json.enc', { isDeleted: true }),
  ])
  const applies = []
  puller.on('remote-apply', (e) => applies.push(e))
  const r = await puller.pullOnce('identity')
  ok('no apply emitted for isDeleted entries', applies.length === 0)
  ok('skipped count increments', r.skipped >= 1)
})()

// 9. Decode failure → warn + skip + errors++
section('Decode failure → warn + skip')
;(async () => {
  const { puller, dropbox } = makePuller()
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })

  // Tamper a valid buffer so decode throws
  const goodHeader = makeHeader({ recordId: 'rec-tampered' })
  const goodBuf = encodeRecord(MASTER_KEY, goodHeader, makeBody({ id: 'rec-tampered' }))
  const tampered = Buffer.from(goodBuf)
  tampered[tampered.length - 1] ^= 0x01
  dropbox._setRecord('/sync/identitys/rec-tampered.json.enc', tampered)
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-tampered.json.enc'),
  ])

  const warns = []
  const applies = []
  puller.on('warn', (w) => warns.push(w))
  puller.on('remote-apply', (e) => applies.push(e))

  const r = await puller.pullOnce('identity')
  ok('no apply on decode failure', applies.length === 0)
  ok(
    'warn with reason=decode-failed',
    warns.some((w) => w.reason === 'decode-failed'),
  )
  ok('errors count incremented', r.errors === 1)
})()

// 10. recordType mismatch in header → warn
section('recordType mismatch in header')
;(async () => {
  const { puller, dropbox } = makePuller()
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })
  const badHeader = makeHeader({ recordId: 'rec-wrong', recordType: 'workspace' })
  const buf = encodeRecord(MASTER_KEY, badHeader, makeBody({ id: 'rec-wrong' }))
  dropbox._setRecord('/sync/identitys/rec-wrong.json.enc', buf)
  dropbox._setFolderEntries('/sync/identitys', [
    makeEntry('/sync/identitys/rec-wrong.json.enc'),
  ])
  const warns = []
  puller.on('warn', (w) => warns.push(w))
  const r = await puller.pullOnce('identity')
  ok(
    'warn with reason=record-type-mismatch',
    warns.some((w) => w.reason === 'record-type-mismatch'),
  )
  ok('errors count incremented', r.errors === 1)
})()

// State persistence, pause-by-vault, pause-by-auth, listFolder failures,
// and the SyncPullError shape live in tests/sync-pull-state.smoketest.js
// (split per ADR 0005 LOC rule).

// ---------- Async wait + summary --------------------------------------------
setTimeout(() => {
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures)
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    process.exit(1)
  }
  process.exit(0)
}, 300)
