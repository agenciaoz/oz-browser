// OZ Browser — StickyRotation smoke test (v2 alpha.30).
//
// Run:
//   cd oz-browser
//   node tests/proxy-sticky-rotation.smoketest.js
//
// Covers (pure module — no Electron / OS):
//   - replaceSessidInUsername helper
//   - isStale window check
//   - getOrRotateSessid: first-activation, sticky reuse, expired rotation
//   - buildRulesForIdentity: no proxy, non-sticky proxy, sticky proxy
//   - applyForIdentity: calls session.setProxy with rotated rules
//   - forget cleans state
//   - proxy without sessid pattern → no rotation, raw username applied

'use strict'

const path = require('path')

delete require.cache[require.resolve('../browser/proxy-sticky-rotation.js')]
const {
  StickyRotation,
  replaceSessidInUsername,
  generateSessid,
  DEFAULT_STICKY_WINDOW_MS,
} = require(path.join('..', 'browser', 'proxy-sticky-rotation.js'))

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
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, a === e ? '' : `got=${a} expected=${e}`)
}

function makeFakeAssignment(map) {
  return {
    resolve({ identityId }) {
      return map[identityId] || null
    },
  }
}

function toProxyRulesString(p) {
  if (!p) return 'direct://'
  return `${p.protocol}://${p.username}:${p.password}@${p.host}:${p.port}`
}

const OXY = {
  id: 'oxy-100',
  protocol: 'https',
  host: 'us-pr.oxylabs.io',
  port: 10001,
  username: 'customer-X-cc-us-city-miami-sessid-000100-sesstime-30',
  password: 'pw',
}
const BRIGHTDATA = {
  id: 'bd-1',
  protocol: 'https',
  host: 'brd.superproxy.io',
  port: 22225,
  username: 'brd-customer-X-zone-residential',
  password: 'pw',
}

console.log('--- replaceSessidInUsername ---')

eq(
  'replaces sessid in Oxylabs username',
  replaceSessidInUsername(OXY.username, 'abc12345'),
  'customer-X-cc-us-city-miami-sessid-abc12345-sesstime-30',
)
eq(
  'no-op when no sessid marker',
  replaceSessidInUsername(BRIGHTDATA.username, 'abc12345'),
  BRIGHTDATA.username,
)
eq('null username → null', replaceSessidInUsername(null, 'x'), null)
eq('empty username → empty', replaceSessidInUsername('', 'x'), '')

console.log('\n--- generateSessid shape ---')

const g1 = generateSessid()
ok('generateSessid returns string', typeof g1 === 'string')
ok('generateSessid is non-empty', g1.length > 0)
ok('generateSessid is ≤8 chars (base36 trim)', g1.length <= 8)

console.log('\n--- DEFAULT_STICKY_WINDOW_MS ---')

eq('default window is 30 min', DEFAULT_STICKY_WINDOW_MS, 30 * 60 * 1000)

console.log('\n--- isStale ---')

{
  let clock = 1000000
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({}),
    toProxyRulesString,
    now: () => clock,
  })
  ok('null generatedAt is stale', sr.isStale(null) === true)
  ok('undefined generatedAt is stale', sr.isStale(undefined) === true)
  ok('just-generated is NOT stale', sr.isStale(clock) === false)
  ok('within window NOT stale (29 min)', sr.isStale(clock - 29 * 60 * 1000) === false)
  ok('at boundary still NOT stale (30 min)', sr.isStale(clock - 30 * 60 * 1000) === false)
  ok('past window IS stale (31 min)', sr.isStale(clock - 31 * 60 * 1000) === true)
}

console.log('\n--- getOrRotateSessid: first-activation ---')

{
  let clock = 5_000_000
  const sessidLog = []
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => {
      const v = `gen${sessidLog.length}`
      sessidLog.push(v)
      return v
    },
  })
  const s = sr.getOrRotateSessid('id1', OXY)
  eq('first activation → generates sessid', s, 'gen0')
  eq('state cache populated', sr._peek('id1'), { sessid: 'gen0', generatedAt: 5_000_000 })
}

console.log('\n--- getOrRotateSessid: sticky reuse within window ---')

{
  let clock = 10_000_000
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => `gen-${clock}-${Math.floor(Math.random() * 1e6)}`,
  })
  const first = sr.getOrRotateSessid('id1', OXY)
  // Advance 15 min — still within sticky window.
  clock += 15 * 60 * 1000
  const second = sr.getOrRotateSessid('id1', OXY)
  eq('reuses sessid within window', second, first)
  // Advance to 29 min total — still within window.
  clock = 10_000_000 + 29 * 60 * 1000
  const third = sr.getOrRotateSessid('id1', OXY)
  eq('reuses sessid at 29 min', third, first)
}

console.log('\n--- getOrRotateSessid: expired rotation ---')

{
  let clock = 20_000_000
  let gen = 0
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => `gen${gen++}`,
  })
  const first = sr.getOrRotateSessid('id1', OXY)
  eq('first sessid', first, 'gen0')
  // Advance >30 min — sticky expired.
  clock += 31 * 60 * 1000
  const second = sr.getOrRotateSessid('id1', OXY)
  ok('rotates to new sessid after window', second !== first)
  eq('new sessid is gen1', second, 'gen1')
  // Re-call without clock advance — should reuse the new sessid (sticky resets).
  const third = sr.getOrRotateSessid('id1', OXY)
  eq('reuses gen1 within new window', third, 'gen1')
}

console.log('\n--- getOrRotateSessid: non-sessid proxy ---')

{
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: BRIGHTDATA }),
    toProxyRulesString,
  })
  const s = sr.getOrRotateSessid('id1', BRIGHTDATA)
  eq('Brightdata proxy → no sessid (null)', s, null)
  ok('non-sessid proxy does NOT populate state', sr._peek('id1') === null)
}

console.log('\n--- buildRulesForIdentity ---')

{
  let clock = 30_000_000
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({
      withProxy: OXY,
      withoutProxy: null,
      brightdata: BRIGHTDATA,
    }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => 'rot1',
  })
  const noProxy = sr.buildRulesForIdentity('withoutProxy')
  eq('no proxy → direct rules', noProxy.rules, 'direct://')
  eq('no proxy → null proxy obj', noProxy.proxy, null)

  const withProxy = sr.buildRulesForIdentity('withProxy')
  eq('sticky proxy → sessid populated', withProxy.sessid, 'rot1')
  ok(
    'sticky proxy rules contain rotated sessid',
    withProxy.rules.includes('sessid-rot1-sesstime-30'),
  )

  const bd = sr.buildRulesForIdentity('brightdata')
  eq('non-sticky proxy → sessid null', bd.sessid, null)
  ok(
    'non-sticky proxy rules are raw',
    bd.rules.includes('brd-customer-X-zone-residential'),
  )
}

console.log('\n--- applyForIdentity ---')

{
  let clock = 40_000_000
  const setProxyCalls = []
  const fakeSession = {
    setProxy(opts) {
      setProxyCalls.push(opts)
      return Promise.resolve()
    },
  }
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => 'applied-x',
  })
  ;(async () => {
    const r = await sr.applyForIdentity('id1', fakeSession)
    eq('applyForIdentity returns proxyId', r.proxyId, OXY.id)
    eq('applyForIdentity returns sessid', r.sessid, 'applied-x')
    eq('setProxy called once', setProxyCalls.length, 1)
    ok(
      'rules contain rotated sessid',
      setProxyCalls[0].proxyRules.includes('sessid-applied-x'),
    )
  })()
}

console.log('\n--- applyForIdentity: session without setProxy ---')

{
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
  })
  ;(async () => {
    const r = await sr.applyForIdentity('id1', null)
    eq('null session → null result', r, { proxyId: null, sessid: null, rules: null })
  })()
}

console.log('\n--- forget cleans state ---')

{
  let clock = 50_000_000
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => 'sX',
  })
  sr.getOrRotateSessid('id1', OXY)
  ok('state populated before forget', sr._peek('id1') !== null)
  sr.forget('id1')
  ok('state cleared after forget', sr._peek('id1') === null)
  // Re-activate after forget → new sessid generated.
  const after = sr.getOrRotateSessid('id1', OXY)
  eq('post-forget reactivation generates fresh sessid', after, 'sX')
}

console.log('\n--- two identities track independent sessids ---')

{
  let clock = 60_000_000
  let i = 0
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ a: OXY, b: OXY }),
    toProxyRulesString,
    now: () => clock,
    sessidGenerator: () => `s${i++}`,
  })
  const aSess = sr.getOrRotateSessid('a', OXY)
  const bSess = sr.getOrRotateSessid('b', OXY)
  ok('two identities → different sessids', aSess !== bSess)
  eq('identity a sessid', aSess, 's0')
  eq('identity b sessid', bSess, 's1')
}

console.log('\n--- constructor validations ---')

{
  let threw = false
  try {
    new StickyRotation({})
  } catch (e) {
    threw = /proxyAssignment required/.test(e.message)
  }
  ok('throws when proxyAssignment missing', threw)

  threw = false
  try {
    new StickyRotation({ proxyAssignment: makeFakeAssignment({}) })
  } catch (e) {
    threw = /toProxyRulesString required/.test(e.message)
  }
  ok('throws when toProxyRulesString missing', threw)
}

console.log('\n--- custom windowMs ---')

{
  let clock = 100_000_000
  const sr = new StickyRotation({
    proxyAssignment: makeFakeAssignment({ id1: OXY }),
    toProxyRulesString,
    now: () => clock,
    windowMs: 5 * 60 * 1000, // 5 min custom window
    sessidGenerator: () => `c${Math.floor(Math.random() * 1000)}`,
  })
  const first = sr.getOrRotateSessid('id1', OXY)
  clock += 4 * 60 * 1000
  const second = sr.getOrRotateSessid('id1', OXY)
  eq('reuses within custom 5min window', second, first)
  clock += 2 * 60 * 1000 // total 6 min
  const third = sr.getOrRotateSessid('id1', OXY)
  ok('rotates after custom 5min window', third !== first)
}

console.log(`\n${passed} passed · ${failed} failed`)
if (failed > 0) {
  console.error('FAILURES:')
  for (const f of failures) {
    console.error(`  - ${f.label}${f.detail ? ': ' + f.detail : ''}`)
  }
  process.exit(1)
}
