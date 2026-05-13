// OZ Browser — Sync Pull state + error paths smoke test (D-3c-2 CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-pull-state.smoketest.js
//
// Cubre los paths de estado, errores y pause del puller. Split from
// sync-pull.smoketest.js per ADR 0005 (500 LOC rule).
//
//   - cursor persistence across instances
//   - state schema mismatch → start fresh + warn
//   - state corrupt JSON → start fresh + warn
//   - vault locked → 'paused' + status='vault-locked'
//   - dropbox unauthenticated → 'paused' + status='unauthenticated'
//   - listFolder network failure → warn + errors=1
//   - SyncPullError shape

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const { SyncPuller, SyncPullError } = require('../browser/sync-pull')

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

// ---------- Test doubles (mirrors sync-pull.smoketest.js) ------------------

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
  }
}

function makeFakeDropbox({ authenticated = true } = {}) {
  const folders = new Map()
  const state = { authenticated, nextError: null }
  let nextCursor = 1
  return {
    isAuthenticated() {
      return state.authenticated
    },
    async listFolder(p) {
      if (state.nextError) {
        const e = state.nextError
        state.nextError = null
        throw e
      }
      const entries = folders.get(p) || []
      return {
        entries: entries.slice(),
        cursor: `cursor-${nextCursor++}`,
        hasMore: false,
      }
    },
    async listFolderContinue() {
      if (state.nextError) {
        const e = state.nextError
        state.nextError = null
        throw e
      }
      return { entries: [], cursor: `cursor-cont-${nextCursor++}`, hasMore: false }
    },
    async download() {
      throw new Error('unused in this test')
    },
    _setFolderEntries(p, entries) {
      folders.set(p, entries)
    },
    _setNextError(err) {
      state.nextError = err
    },
  }
}

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-pull-state-'))
  return path.join(dir, 'sync-state.json')
}

console.log('OZ Browser — sync-pull state + errors smoke test')

// 1. Cursor persists across instances
section('Cursor persistence across instances')
;(async () => {
  const stateFilePath = tmpStateFile()
  const dropbox = makeFakeDropbox()
  const vault = makeFakeVault()
  const p1 = new SyncPuller({
    dropbox,
    vault,
    deviceFolder: 'mac-aaaa1111',
    stateFilePath,
  }).loadState()
  p1.registerSource({ recordType: 'identity', fetchRecord: () => null })
  dropbox._setFolderEntries('/sync/identitys', [])
  await p1.pullOnce('identity')
  const cursorAfter1 = p1.cursorFor('identitys')
  ok('cursor stored after first pull', !!cursorAfter1)

  // New instance, same state file
  const p2 = new SyncPuller({
    dropbox,
    vault,
    deviceFolder: 'mac-aaaa1111',
    stateFilePath,
  }).loadState()
  ok('second instance loads same cursor', p2.cursorFor('identitys') === cursorAfter1)
})()

// 2. State schema mismatch → start fresh + warn
section('State schema mismatch on load')
{
  const stateFilePath = tmpStateFile()
  fs.writeFileSync(stateFilePath, JSON.stringify({ schemaVersion: 99, cursors: {} }))
  const puller = new SyncPuller({
    dropbox: makeFakeDropbox(),
    vault: makeFakeVault(),
    deviceFolder: 'mac-aaaa1111',
    stateFilePath,
  })
  const warns = []
  puller.on('warn', (w) => warns.push(w))
  puller.loadState()
  ok('cursor not loaded', puller.cursorFor('anything') === null)
  ok(
    'warn with reason=state-schema-mismatch',
    warns.some((w) => w.reason === 'state-schema-mismatch'),
  )
}

// 3. State corrupt JSON → start fresh + warn
section('State corrupt JSON on load')
{
  const stateFilePath = tmpStateFile()
  fs.writeFileSync(stateFilePath, '{not json')
  const puller = new SyncPuller({
    dropbox: makeFakeDropbox(),
    vault: makeFakeVault(),
    deviceFolder: 'mac-aaaa1111',
    stateFilePath,
  })
  const warns = []
  puller.on('warn', (w) => warns.push(w))
  puller.loadState()
  ok('cursor not loaded', puller.cursorFor('anything') === null)
  ok(
    'warn with reason=state-parse-failed',
    warns.some((w) => w.reason === 'state-parse-failed'),
  )
}

// 4. Vault locked → status='vault-locked'
section('Vault locked')
;(async () => {
  const vault = makeFakeVault({ unlocked: false })
  const puller = new SyncPuller({
    dropbox: makeFakeDropbox(),
    vault,
    deviceFolder: 'mac-aaaa1111',
    stateFilePath: tmpStateFile(),
  })
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })
  const pauses = []
  puller.on('paused', (e) => pauses.push(e))
  const r = await puller.pullOnce('identity')
  ok("status === 'vault-locked'", r.status === 'vault-locked')
  ok(
    "paused event fired with reason='vault-locked'",
    pauses.some((p) => p.reason === 'vault-locked'),
  )
})()

// 5. Dropbox unauthenticated → status='unauthenticated'
section('Dropbox unauthenticated')
;(async () => {
  const dropbox = makeFakeDropbox({ authenticated: false })
  const puller = new SyncPuller({
    dropbox,
    vault: makeFakeVault(),
    deviceFolder: 'mac-aaaa1111',
    stateFilePath: tmpStateFile(),
  })
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })
  const r = await puller.pullOnce('identity')
  ok("status === 'unauthenticated'", r.status === 'unauthenticated')
})()

// 6. listFolder network failure → warn + errors=1
section('listFolder network failure')
;(async () => {
  const dropbox = makeFakeDropbox()
  const puller = new SyncPuller({
    dropbox,
    vault: makeFakeVault(),
    deviceFolder: 'mac-aaaa1111',
    stateFilePath: tmpStateFile(),
  })
  puller.registerSource({ recordType: 'identity', fetchRecord: () => null })
  dropbox._setNextError(new Error('network down'))
  const warns = []
  puller.on('warn', (w) => warns.push(w))
  const r = await puller.pullOnce('identity')
  ok('errors === 1', r.errors === 1)
  ok(
    'warn with reason=list-folder-failed',
    warns.some((w) => w.reason === 'list-folder-failed'),
  )
})()

// 7. No source registered → throws NO_SOURCE
section('No source registered → NO_SOURCE')
;(async () => {
  const puller = new SyncPuller({
    dropbox: makeFakeDropbox(),
    vault: makeFakeVault(),
    deviceFolder: 'mac-aaaa1111',
    stateFilePath: tmpStateFile(),
  })
  let caught = null
  try {
    await puller.pullOnce('identity')
  } catch (e) {
    caught = e
  }
  ok('throws with code NO_SOURCE', caught && caught.code === 'NO_SOURCE')
})()

// 8. SyncPullError shape
section('SyncPullError shape')
{
  let caught
  try {
    new SyncPuller({})
  } catch (e) {
    caught = e
  }
  ok('thrown is SyncPullError', caught instanceof SyncPullError)
  ok('has .code', typeof caught.code === 'string')
  ok('name === SyncPullError', caught.name === 'SyncPullError')
}

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
}, 200)
