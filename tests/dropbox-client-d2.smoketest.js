// OZ Browser — Dropbox Client D-2 smoke test (chunked upload + cursor-based listings).
//
// Cómo correr:
//   cd oz-browser
//   node tests/dropbox-client-d2.smoketest.js
//
// Split de dropbox-client.smoketest.js (D-1.2) por ADR 0005 (500 LOC).
// Cubre:
//   - chunked upload: >140MB routes to filesUploadSessionStart/AppendV2/Finish
//   - chunked upload: tiny tail edge case
//   - chunked upload: missing session_id error → BAD_RESPONSE
//   - chunked upload: small file still uses single-PUT
//   - listFolderContinue: delta with deletes, BAD_ARG, CURSOR_RESET
//   - listFolderAll: paginates until hasMore=false

const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-dbx-d2-'))

const {
  createDropboxClient,
  DropboxError,
  DROPBOX_PROVIDER,
  SIMPLE_UPLOAD_MAX_BYTES,
  CHUNK_SIZE,
  injectDropboxSdk,
} = require('../browser/dropbox-client')

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

function makeFakeOauth(initial = {}) {
  const store = new Map()
  if (initial.tokens) store.set(DROPBOX_PROVIDER, initial.tokens)
  return {
    startOAuthFlow: () => ({
      authUrl: 'https://x',
      codeVerifier: 'V',
      state: 'S',
      redirectUri: 'oz://auth/dropbox/callback',
    }),
    exchangeCodeForToken: async () => ({ accessToken: 'AT', refreshToken: 'RT' }),
    refreshAccessToken: async () => ({ accessToken: 'AT-NEW', refreshToken: 'RT' }),
    saveTokens: (p, t) => store.set(p, t),
    loadTokens: (p) => store.get(p) || null,
    clearTokens: (p) => store.delete(p),
  }
}

function makeFakeSdk(scripted = {}) {
  const log = []
  class FakeDropbox {
    constructor(opts) {
      this.opts = opts
      log.push({ kind: 'ctor', accessToken: opts.accessToken })
    }
    async filesUpload(arg) {
      log.push({ kind: 'filesUpload', path: arg.path, size: arg.contents.length })
      const next = (scripted.filesUpload || []).shift()
      if (next instanceof Error) throw next
      return (
        next || {
          result: {
            path_display: arg.path,
            path_lower: arg.path.toLowerCase(),
            size: arg.contents.length,
            rev: 'REV-1',
            content_hash: 'CHASH',
          },
        }
      )
    }
    async filesUploadSessionStart(arg) {
      log.push({
        kind: 'filesUploadSessionStart',
        size: arg.contents.length,
        close: arg.close,
      })
      const next = (scripted.filesUploadSessionStart || []).shift()
      if (next instanceof Error) throw next
      return next || { result: { session_id: 'SESS-1' } }
    }
    async filesUploadSessionAppendV2(arg) {
      log.push({
        kind: 'filesUploadSessionAppendV2',
        size: arg.contents.length,
        offset: arg.cursor.offset,
        sessionId: arg.cursor.session_id,
      })
      return {}
    }
    async filesUploadSessionFinish(arg) {
      log.push({
        kind: 'filesUploadSessionFinish',
        size: arg.contents.length,
        offset: arg.cursor.offset,
        sessionId: arg.cursor.session_id,
        commitPath: arg.commit.path,
      })
      const totalSize = arg.cursor.offset + arg.contents.length
      return {
        result: {
          path_display: arg.commit.path,
          path_lower: arg.commit.path.toLowerCase(),
          size: totalSize,
          rev: 'REV-FIN',
          content_hash: 'CFIN',
        },
      }
    }
    async filesListFolder(arg) {
      const next = (scripted.filesListFolder || []).shift()
      if (next instanceof Error) throw next
      return next || { result: { entries: [], cursor: null, has_more: false } }
    }
    async filesListFolderContinue(arg) {
      // Overridden per-test via .prototype to handle BAD_ARG / CURSOR_RESET.
      return { result: { entries: [], cursor: null, has_more: false } }
    }
  }
  return { Dropbox: FakeDropbox, _log: log }
}

;(async () => {
  await asyncGroup('chunked upload — >140MB routes to session APIs', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT', refreshToken: 'RT' } })
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const TOTAL = SIMPLE_UPLOAD_MAX_BYTES + 30 * 1024 * 1024 // 170MB
    const big = Buffer.alloc(TOTAL, 0)
    for (let i = 0; i < TOTAL; i += CHUNK_SIZE) big[i] = (i / CHUNK_SIZE) % 251
    const r = await c.upload({ path: '/big.ozbackup', contents: big })
    const starts = sdk._log.filter((x) => x.kind === 'filesUploadSessionStart')
    const appends = sdk._log.filter((x) => x.kind === 'filesUploadSessionAppendV2')
    const finishes = sdk._log.filter((x) => x.kind === 'filesUploadSessionFinish')
    ok('exactly 1 sessionStart', starts.length === 1)
    ok('exactly 1 sessionFinish', finishes.length === 1)
    const expectedChunks = Math.ceil(TOTAL / CHUNK_SIZE)
    ok(
      'append count = total chunks - 2 (start+finish)',
      appends.length === expectedChunks - 2,
    )
    ok(
      'all appends use SESS-1',
      appends.every((a) => a.sessionId === 'SESS-1'),
    )
    ok('finish uses SESS-1', finishes[0].sessionId === 'SESS-1')
    ok('finish commitPath normalized', finishes[0].commitPath === '/big.ozbackup')
    ok('result size = total', r.size === TOTAL)
    ok('result rev present', r.rev === 'REV-FIN')
    ok(
      'NO filesUpload single-PUT call',
      sdk._log.every((x) => x.kind !== 'filesUpload'),
    )
  })

  await asyncGroup('chunked upload — tiny tail in final commit', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const total = SIMPLE_UPLOAD_MAX_BYTES + 1024
    const buf = Buffer.alloc(total, 7)
    const r = await c.upload({ path: '/tinyTail.ozbackup', contents: buf })
    const finishes = sdk._log.filter((x) => x.kind === 'filesUploadSessionFinish')
    ok('exactly 1 finish', finishes.length === 1)
    const expectedAppends = Math.floor((total - CHUNK_SIZE) / CHUNK_SIZE)
    const appends = sdk._log.filter((x) => x.kind === 'filesUploadSessionAppendV2')
    ok('append count matches', appends.length === expectedAppends)
    ok(
      'final chunk size is the tail',
      finishes[0].size === total - (1 + expectedAppends) * CHUNK_SIZE,
    )
    ok('result size matches total', r.size === total)
  })

  await asyncGroup('chunked upload — start missing session_id', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    const sdk = makeFakeSdk({
      filesUploadSessionStart: [{ result: {} }],
    })
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const big = Buffer.alloc(SIMPLE_UPLOAD_MAX_BYTES + 1024, 0)
    let threw = null
    try {
      await c.upload({ path: '/x.ozbackup', contents: big })
    } catch (e) {
      threw = e
    }
    ok('throws BAD_RESPONSE', threw && threw.code === 'BAD_RESPONSE')
    ok('error mentions session_id', threw && /session_id/.test(threw.message))
  })

  await asyncGroup('chunked upload — small file still uses single-PUT', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    const sdk = makeFakeSdk()
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const small = Buffer.alloc(1024 * 100, 0)
    await c.upload({ path: '/small.bin', contents: small })
    const starts = sdk._log.filter((x) => x.kind === 'filesUploadSessionStart')
    const puts = sdk._log.filter((x) => x.kind === 'filesUpload')
    ok('zero sessionStart for small file', starts.length === 0)
    ok('exactly 1 filesUpload', puts.length === 1)
  })

  await asyncGroup('listFolderContinue — delta with deletes', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    const sdk = makeFakeSdk()
    sdk.Dropbox.prototype.filesListFolderContinue = async function (arg) {
      if (arg.cursor === 'STALE-CURSOR') {
        const e = new Error('cursor reset required')
        e.error = { error_summary: 'reset/.' }
        throw e
      }
      return {
        result: {
          entries: [
            {
              name: 'new.ozbackup',
              path_lower: '/dev/snapshots/new.ozbackup',
              path_display: '/dev/snapshots/new.ozbackup',
              size: 500,
              server_modified: '2026-05-11T01:00:00Z',
              '.tag': 'file',
            },
            {
              name: 'old.ozbackup',
              path_lower: '/dev/snapshots/old.ozbackup',
              '.tag': 'deleted',
            },
          ],
          cursor: 'CURSOR-2',
          has_more: false,
        },
      }
    }
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const delta = await c.listFolderContinue('CURSOR-1')
    ok('delta entries returned', delta.entries.length === 2)
    ok(
      'new file detected',
      delta.entries[0].isFolder === false && delta.entries[0].isDeleted === false,
    )
    ok('deleted file flagged', delta.entries[1].isDeleted === true)
    ok('cursor updated', delta.cursor === 'CURSOR-2')
    let threw = null
    try {
      await c.listFolderContinue('')
    } catch (e) {
      threw = e
    }
    ok('rejects empty cursor', threw && threw.code === 'BAD_ARG')
    threw = null
    try {
      await c.listFolderContinue('STALE-CURSOR')
    } catch (e) {
      threw = e
    }
    ok('CURSOR_RESET on stale cursor', threw && threw.code === 'CURSOR_RESET')
  })

  await asyncGroup('listFolderAll — paginates until !hasMore', async () => {
    const oauth = makeFakeOauth({ tokens: { accessToken: 'AT' } })
    const sdk = makeFakeSdk({
      filesListFolder: [
        {
          result: {
            entries: [
              { name: 'a', path_lower: '/a', '.tag': 'file', size: 1 },
              { name: 'b', path_lower: '/b', '.tag': 'file', size: 2 },
            ],
            cursor: 'PAGE-2',
            has_more: true,
          },
        },
      ],
    })
    let continueCalls = 0
    sdk.Dropbox.prototype.filesListFolderContinue = async function () {
      continueCalls++
      if (continueCalls === 1) {
        return {
          result: {
            entries: [{ name: 'c', path_lower: '/c', '.tag': 'file', size: 3 }],
            cursor: 'PAGE-3',
            has_more: true,
          },
        }
      }
      return {
        result: {
          entries: [{ name: 'd', path_lower: '/d', '.tag': 'file', size: 4 }],
          cursor: 'PAGE-FINAL',
          has_more: false,
        },
      }
    }
    injectDropboxSdk(sdk)
    const c = createDropboxClient({ clientId: 'APPKEY', oauth })
    const all = await c.listFolderAll('/')
    ok('paginated all 4 entries', all.entries.length === 4)
    ok('final cursor returned', all.cursor === 'PAGE-FINAL')
    ok('hasMore false at end', all.hasMore === false)
    ok('continue called twice', continueCalls === 2)
    ok('names in order', all.entries.map((e) => e.name).join('') === 'abcd')
  })

  console.log(`\n${'='.repeat(50)}`)
  console.log(`dropbox-client D-2 smoke: ${passed} passed, ${failed} failed`)
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
