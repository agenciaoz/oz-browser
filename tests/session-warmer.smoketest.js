// OZ Browser — session-warmer handler smoke test (K1-extras, v1.4.1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/session-warmer.smoketest.js
//
// Pure test — inyecta fakes para identityManager / workspaceManager /
// accountVault / sessionFactory / netRequest. NO toca Electron real.

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const orig = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/scheduled-action-handlers.js')]
const {
  createSessionWarmerHandler,
  ACTION_SESSION_WARMER,
  ACTION_TYPES,
  WARMER_THROTTLE_MS,
} = require('../browser/scheduled-action-handlers.js')

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

console.log('OZ Browser — session-warmer smoke test')

// Fake net.request that resolves with a programmable status per URL.
function makeFakeNet(statusByUrl = {}, defaultStatus = 200) {
  const calls = []
  function fakeReq(opts) {
    const handlers = {}
    return {
      on(ev, cb) {
        handlers[ev] = cb
        return this
      },
      end() {
        calls.push({ url: opts.url })
        const status = opts.url in statusByUrl ? statusByUrl[opts.url] : defaultStatus
        // Simulate response asynchronously.
        process.nextTick(() => {
          if (handlers.response) {
            const resHandlers = {}
            const res = {
              statusCode: status,
              on(ev, cb) {
                resHandlers[ev] = cb
                return this
              },
              removeAllListeners() {
                /* noop */
              },
            }
            handlers.response(res)
            // Fire data (small) then end.
            process.nextTick(() => {
              if (resHandlers.data) resHandlers.data(Buffer.from('ok'))
              if (resHandlers.end) resHandlers.end()
            })
          }
        })
      },
    }
  }
  fakeReq.calls = calls
  return fakeReq
}

const fakeIdentityManager = {
  list: () => [
    { id: 'i1', name: 'IG-1' },
    { id: 'i2', name: 'IG-2' },
  ],
}
const fakeWorkspaceManager = {
  get: (id) => (id === 'w1' ? { id: 'w1', identityIds: ['i1', 'i2'] } : null),
}
const fakeAccountVault = {
  isUnlocked: true,
  getAccounts: () => [
    { id: 'a1', identityId: 'i1', site: 'instagram.com' },
    { id: 'a2', identityId: 'i2', site: 'x.com' },
  ],
}
const fakeSessionFactory = (partition) => ({ partition })

// ============================================================================
console.log('\nfactory guards')
// ============================================================================

ok(
  'throws without identityManager',
  (() => {
    try {
      createSessionWarmerHandler({})
      return false
    } catch (e) {
      return /identityManager\.list required/.test(e.message)
    }
  })(),
)

ok(
  'ACTION_TYPES includes session-warmer',
  Array.isArray(ACTION_TYPES) && ACTION_TYPES.includes(ACTION_SESSION_WARMER),
)
ok(
  'ACTION_SESSION_WARMER constant = "session-warmer"',
  ACTION_SESSION_WARMER === 'session-warmer',
)

// ============================================================================
console.log('\nlocked vault → skip')
// ============================================================================
;(async () => {
  const handler = createSessionWarmerHandler({
    identityManager: fakeIdentityManager,
    vault: { isLocked: () => true },
  })
  const r = await handler({ workspaceId: 'w1' })
  ok(
    'locked vault → {skipped:true, reason:vault-locked}',
    r && r.skipped === true && r.reason === 'vault-locked',
  )

  // ============================================================================
  console.log('\nidentityIds resolution from workspaceId')
  // ============================================================================

  const fakeNet = makeFakeNet({}, 200)
  const handler2 = createSessionWarmerHandler({
    identityManager: fakeIdentityManager,
    workspaceManager: fakeWorkspaceManager,
    accountVault: fakeAccountVault,
    sessionFactory: fakeSessionFactory,
    netRequest: fakeNet,
  })
  const t0 = Date.now()
  const r2 = await handler2({ workspaceId: 'w1' })
  const elapsed = Date.now() - t0
  ok('warmed array has 2 entries', Array.isArray(r2.warmed) && r2.warmed.length === 2)
  ok(
    'warmed[0] = {identityId:i1, url:https://instagram.com/, status:200}',
    r2.warmed[0].identityId === 'i1' &&
      r2.warmed[0].url === 'https://instagram.com/' &&
      r2.warmed[0].status === 200,
  )
  ok(
    'warmed[1] = {identityId:i2, url:https://x.com/, status:200}',
    r2.warmed[1].identityId === 'i2' &&
      r2.warmed[1].url === 'https://x.com/' &&
      r2.warmed[1].status === 200,
  )
  ok('totalRequested = 2', r2.totalRequested === 2)
  ok('errors empty', Array.isArray(r2.errors) && r2.errors.length === 0)
  ok('skipped empty', Array.isArray(r2.skipped) && r2.skipped.length === 0)
  ok(
    `throttle applied (≥ ${WARMER_THROTTLE_MS}ms × 2)`,
    elapsed >= WARMER_THROTTLE_MS * 2 - 50,
  )
  ok('fakeNet was called twice', fakeNet.calls.length === 2)

  // ============================================================================
  console.log('\nexplicit identityIds + urlsBySite')
  // ============================================================================

  const fakeNet3 = makeFakeNet({}, 200)
  const handler3 = createSessionWarmerHandler({
    identityManager: fakeIdentityManager,
    accountVault: fakeAccountVault,
    sessionFactory: fakeSessionFactory,
    netRequest: fakeNet3,
  })
  const r3 = await handler3({
    identityIds: ['i1'],
    urlsBySite: { 'instagram.com': 'https://www.instagram.com/explore/' },
  })
  ok(
    'urlsBySite overrides homepage derivation',
    r3.warmed[0].url === 'https://www.instagram.com/explore/',
  )

  // ============================================================================
  console.log('\nno URL resolution → skipped no-url')
  // ============================================================================

  const handler4 = createSessionWarmerHandler({
    identityManager: fakeIdentityManager,
    accountVault: { isUnlocked: true, getAccounts: () => [] }, // no accounts
    sessionFactory: fakeSessionFactory,
    netRequest: makeFakeNet(),
  })
  const r4 = await handler4({ identityIds: ['i1'] })
  ok(
    'identity without accounts → skipped no-url',
    r4.skipped.length === 1 && r4.skipped[0].reason === 'no-url',
  )

  // ============================================================================
  console.log('\nfallbackUrl when no accounts')
  // ============================================================================

  const fakeNet5 = makeFakeNet({}, 204)
  const handler5 = createSessionWarmerHandler({
    identityManager: fakeIdentityManager,
    accountVault: { isUnlocked: true, getAccounts: () => [] },
    sessionFactory: fakeSessionFactory,
    netRequest: fakeNet5,
  })
  const r5 = await handler5({
    identityIds: ['i1'],
    fallbackUrl: 'https://example.com/health',
  })
  ok(
    'fallbackUrl used when no account.site',
    r5.warmed.length === 1 &&
      r5.warmed[0].url === 'https://example.com/health' &&
      r5.warmed[0].status === 204,
  )

  // ============================================================================
  console.log('\nBAD_PARAMS: no workspaceId nor identityIds')
  // ============================================================================

  ok(
    'BAD_PARAMS thrown when neither workspaceId nor identityIds provided',
    await (async () => {
      try {
        await handler2({})
        return false
      } catch (e) {
        return e.code === 'BAD_PARAMS'
      }
    })(),
  )

  // ============================================================================
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  process.exit(0)
})()
