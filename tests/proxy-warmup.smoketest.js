// OZ Browser — proxy-warmup smoke test (alpha.109).
//
//   node tests/proxy-warmup.smoketest.js

const { planWarmup, safeOrigin, runWarmup } = require('../browser/proxy-warmup')

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

console.log('OZ Browser — proxy-warmup smoke test')

// safeOrigin
ok('safeOrigin http', safeOrigin('https://x.com/a/b') === 'https://x.com')
ok('safeOrigin about:blank → null', safeOrigin('about:blank') === null)
ok('safeOrigin garbage → null', safeOrigin('not a url') === null)
ok('safeOrigin empty → null', safeOrigin('') === null)

// planWarmup: dedupe por identity, prefiere tab más reciente con origin
{
  const tabs = [
    {
      identityId: 'a',
      url: 'https://insta.com/1',
      workspaceId: 'ws1',
      lastSelectedAt: 10,
    },
    {
      identityId: 'a',
      url: 'https://insta.com/2',
      workspaceId: 'ws1',
      lastSelectedAt: 30,
    },
    { identityId: 'b', url: 'about:blank', workspaceId: 'ws1', lastSelectedAt: 5 },
    { identityId: 'c', url: 'https://x.com', workspaceId: 'ws2', lastSelectedAt: 5 },
  ]
  const plan = planWarmup({ tabs, workspaceId: 'ws1' })
  const byId = Object.fromEntries(plan.map((p) => [p.identityId, p.origin]))
  ok('solo identities del ws1 (a, b)', plan.length === 2)
  ok('a → origin de la tab más reciente', byId.a === 'https://insta.com')
  ok('b → origin null (about:blank)', byId.b === null)
  ok('c excluida (otro workspace)', !('c' in byId))
}

// planWarmup sin workspaceId → todas
{
  const tabs = [
    { identityId: 'a', url: 'https://a.com', workspaceId: 'ws1' },
    { identityId: 'b', url: 'https://b.com', workspaceId: 'ws2' },
  ]
  const plan = planWarmup({ tabs })
  ok('sin workspaceId → todas las identities', plan.length === 2)
}

// planWarmup defensivo
ok('planWarmup sin args → []', planWarmup().length === 0)
ok('planWarmup tabs vacío → []', planWarmup({ tabs: [] }).length === 0)

// runWarmup: llama getSession + preconnect por identity con origin
{
  const calls = { getSession: [], preconnect: [] }
  const fakeSession = (id) => ({
    preconnect(opts) {
      calls.preconnect.push({ id, url: opts.url, sockets: opts.numSockets })
    },
  })
  const browser = {
    identityManager: {
      getSession(id) {
        calls.getSession.push(id)
        return fakeSession(id)
      },
      get: (id) => ({ id, workspaceId: 'ws1' }),
    },
    windows: [
      {
        workspaceId: 'ws1',
        tabs: {
          tabList: [
            { identityId: 'a', pendingUrl: 'https://a.com', lastSelectedAt: 2 },
            { identityId: 'b', pendingUrl: '', webContents: null, lastSelectedAt: 1 },
          ],
        },
      },
    ],
  }
  const res = runWarmup(browser, 'ws1')
  ok('runWarmup warmed = 2 (ambas sesiones aseguradas)', res.warmed === 2)
  ok('runWarmup preconnected = 1 (solo a tiene origin)', res.preconnected === 1)
  ok(
    'preconnect fue a a.com con 2 sockets',
    calls.preconnect[0] &&
      calls.preconnect[0].url === 'https://a.com' &&
      calls.preconnect[0].sockets === 2,
  )
  ok(
    'getSession llamado para a y b',
    calls.getSession.includes('a') && calls.getSession.includes('b'),
  )
}

// runWarmup defensivo: sin identityManager → no-op
ok(
  'runWarmup sin im → {0,0}',
  (() => {
    const r = runWarmup({}, 'ws1')
    return r.warmed === 0 && r.preconnected === 0
  })(),
)

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
