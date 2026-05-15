// OZ Browser — proxy-diagnostics smoketest (H-2e, v1.1.3).
//
// Coverage:
//   - 4 trigger types fire correctly (proxy-disabled, identity-unassigned,
//     proxy-stale, latency-spike)
//   - Dedup window respects severity (urgent 6h, warning 24h)
//   - Dismiss removes from getAlerts AND resets dedup
//   - Latency-spike requires 2 consecutive >2s readings
//   - Defensive: no proxyManager/identityManager → no throw
//   - alertManager.add() forwarded with correct payload
//   - notify() callback dispatched with title/body/severity

const assert = require('assert')

const {
  buildProxyDiagnostics,
  DEFAULT_DEDUP_URGENT_MS,
  DEFAULT_DEDUP_WARNING_MS,
  STALE_THRESHOLD_MS,
  LATENCY_SPIKE_MS,
} = require('../browser/proxy-diagnostics')

let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    console.log('  ✓', name)
    passed += 1
  } catch (err) {
    console.error('  ✗', name)
    console.error('     ', err.message)
    failed += 1
  }
}

// ---------------- fakes ----------------
function fakeProxyManager(proxies) {
  return { list: () => proxies.slice() }
}
function fakeIdentityManager(idents) {
  return { list: () => idents.slice() }
}
function fakeProxyAssignment(resolveMap) {
  return {
    resolve: ({ identityId }) => {
      const v = resolveMap[identityId]
      if (v === undefined) return null
      return v
    },
  }
}
function fakeAlertManager() {
  const log = []
  return {
    log,
    add: (a) => {
      log.push(a)
    },
  }
}
function fakeClock(start) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
    set: (v) => {
      t = v
    },
  }
}

console.log('proxy-diagnostics smoketest')

// ---------------- 1: proxy-disabled trigger ----------------
console.log('\n1. proxy-disabled trigger')

it('fires alert when proxy.isDisabled=true', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'Ox-US-1', host: '1.2.3.4', port: 8080, isDisabled: true },
  ])
  const am = fakeAlertManager()
  const diag = buildProxyDiagnostics({ proxyManager: pm, alertManager: am })
  diag.scan()
  const alerts = diag.getAlerts()
  assert.strictEqual(alerts.length, 1)
  assert.strictEqual(alerts[0].kind, 'proxy-disabled')
  assert.strictEqual(alerts[0].targetId, 'p1')
  assert.strictEqual(alerts[0].severity, 'urgent')
  assert.ok(alerts[0].title.includes('Ox-US-1'))
  assert.strictEqual(am.log.length, 1)
  assert.strictEqual(am.log[0].type, 'proxy-disabled')
})

it('does NOT fire proxy-disabled for enabled proxies', () => {
  const clock = fakeClock(1_000_000_000_000)
  const pm = fakeProxyManager([
    {
      id: 'p1',
      name: 'A',
      host: 'a',
      port: 1,
      isDisabled: false,
      lastTestedAt: clock.now() - 1000,
    },
    {
      id: 'p2',
      name: 'B',
      host: 'b',
      port: 2,
      lastTestedAt: clock.now() - 5000,
    },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  const disabledAlerts = diag.getAlerts().filter((a) => a.kind === 'proxy-disabled')
  assert.strictEqual(disabledAlerts.length, 0)
})

// ---------------- 2: identity-unassigned trigger ----------------
console.log('\n2. identity-unassigned trigger')

it('fires for non-default identity with no resolved proxy', () => {
  const idents = [
    { id: 'i-default', name: 'Default', isDefault: true, workspaceId: 'general' },
    { id: 'i-contexto', name: 'Contexto IG', isDefault: false, workspaceId: 'ws1' },
  ]
  const pm = fakeProxyManager([])
  const pa = fakeProxyAssignment({}) // resolve returns null for all
  const im = fakeIdentityManager(idents)
  const am = fakeAlertManager()
  const diag = buildProxyDiagnostics({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
    alertManager: am,
  })
  diag.scan()
  const alerts = diag.getAlerts().filter((a) => a.kind === 'identity-unassigned')
  assert.strictEqual(alerts.length, 1)
  assert.strictEqual(alerts[0].targetId, 'i-contexto')
  assert.strictEqual(alerts[0].severity, 'urgent')
  assert.ok(alerts[0].title.includes('Contexto IG'))
  // AlertManager action should be open-dashboard for this kind
  const amAlert = am.log.find((x) => x.type === 'identity-unassigned')
  assert.deepStrictEqual(amAlert.action, { kind: 'open-dashboard' })
})

it('does NOT fire for default identity even if unassigned', () => {
  const idents = [{ id: 'i-default', name: 'Default', isDefault: true }]
  const pm = fakeProxyManager([])
  const pa = fakeProxyAssignment({})
  const im = fakeIdentityManager(idents)
  const diag = buildProxyDiagnostics({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
  })
  diag.scan()
  assert.strictEqual(diag.getAlerts().length, 0)
})

it('does NOT fire when identity HAS a resolved proxy', () => {
  const idents = [{ id: 'i1', name: 'IG-1', isDefault: false, workspaceId: 'ws1' }]
  const pm = fakeProxyManager([])
  const pa = fakeProxyAssignment({ i1: { id: 'p1', name: 'Ox-US' } })
  const im = fakeIdentityManager(idents)
  const diag = buildProxyDiagnostics({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
  })
  diag.scan()
  assert.strictEqual(diag.getAlerts().length, 0)
})

it('survives proxyAssignment.resolve throwing', () => {
  const idents = [{ id: 'i1', name: 'Foo', isDefault: false, workspaceId: 'ws1' }]
  const pa = {
    resolve: () => {
      throw new Error('boom')
    },
  }
  const diag = buildProxyDiagnostics({
    proxyManager: fakeProxyManager([]),
    proxyAssignment: pa,
    identityManager: fakeIdentityManager(idents),
  })
  diag.scan()
  // Falls back to null → fires unassigned alert
  const alerts = diag.getAlerts().filter((a) => a.kind === 'identity-unassigned')
  assert.strictEqual(alerts.length, 1)
})

// ---------------- 3: proxy-stale trigger ----------------
console.log('\n3. proxy-stale trigger')

it('fires for proxy with lastTestedAt > 24h ago', () => {
  const clock = fakeClock(1_000_000_000_000)
  const oldTs = clock.now() - STALE_THRESHOLD_MS - 1000
  const pm = fakeProxyManager([
    { id: 'p1', name: 'Old', host: 'o', port: 1, lastTestedAt: oldTs },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  const stale = diag.getAlerts().filter((a) => a.kind === 'proxy-stale')
  assert.strictEqual(stale.length, 1)
  assert.strictEqual(stale[0].severity, 'warning')
})

it('fires for never-tested proxy (lastTestedAt null)', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'Never', host: 'n', port: 1, lastTestedAt: null },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm })
  diag.scan()
  const stale = diag.getAlerts().filter((a) => a.kind === 'proxy-stale')
  assert.strictEqual(stale.length, 1)
  assert.ok(stale[0].title.includes('never tested') || stale[0].title.includes('Never'))
})

it('does NOT fire for proxy tested recently', () => {
  const clock = fakeClock(1_000_000_000_000)
  const pm = fakeProxyManager([
    { id: 'p1', name: 'Fresh', host: 'f', port: 1, lastTestedAt: clock.now() - 1000 },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  const stale = diag.getAlerts().filter((a) => a.kind === 'proxy-stale')
  assert.strictEqual(stale.length, 0)
})

it('does NOT double-fire stale for already-disabled proxy', () => {
  const clock = fakeClock(1_000_000_000_000)
  const oldTs = clock.now() - STALE_THRESHOLD_MS - 1000
  const pm = fakeProxyManager([
    {
      id: 'p1',
      name: 'Dead',
      host: 'd',
      port: 1,
      lastTestedAt: oldTs,
      isDisabled: true,
    },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  // Only proxy-disabled should fire; stale skipped because already covered
  const kinds = diag.getAlerts().map((a) => a.kind)
  assert.deepStrictEqual(kinds.sort(), ['proxy-disabled'])
})

// ---------------- 4: latency-spike trigger ----------------
console.log('\n4. latency-spike trigger')

it('fires when 2 consecutive readings >2s', () => {
  const clock = fakeClock(1_000_000_000_000)
  const proxies = [
    {
      id: 'p1',
      name: 'Slow',
      host: 's',
      port: 1,
      lastLatencyMs: 3000,
      lastTestedAt: 100,
    },
  ]
  const pm = fakeProxyManager(proxies)
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  // Update with a 2nd reading (different testedAt)
  proxies[0].lastLatencyMs = 2500
  proxies[0].lastTestedAt = 200
  diag.scan()
  const spikes = diag.getAlerts().filter((a) => a.kind === 'latency-spike')
  assert.strictEqual(spikes.length, 1)
  assert.ok(spikes[0].latencies)
  assert.strictEqual(spikes[0].latencies.length, 2)
})

it('does NOT fire on single spike (only 1 reading >2s)', () => {
  const proxies = [
    {
      id: 'p1',
      name: 'OneOff',
      host: 'o',
      port: 1,
      lastLatencyMs: LATENCY_SPIKE_MS + 500,
      lastTestedAt: 100,
    },
  ]
  const diag = buildProxyDiagnostics({ proxyManager: fakeProxyManager(proxies) })
  diag.scan()
  // Update with a fast reading
  proxies[0].lastLatencyMs = 300
  proxies[0].lastTestedAt = 200
  diag.scan()
  const spikes = diag.getAlerts().filter((a) => a.kind === 'latency-spike')
  assert.strictEqual(spikes.length, 0)
})

it('does NOT fire when both readings are below threshold', () => {
  const proxies = [
    { id: 'p1', name: 'OK', host: 'o', port: 1, lastLatencyMs: 500, lastTestedAt: 100 },
  ]
  const diag = buildProxyDiagnostics({ proxyManager: fakeProxyManager(proxies) })
  diag.scan()
  proxies[0].lastLatencyMs = 800
  proxies[0].lastTestedAt = 200
  diag.scan()
  assert.strictEqual(diag.getAlerts().filter((a) => a.kind === 'latency-spike').length, 0)
})

it('ignores latency for disabled proxy', () => {
  const proxies = [
    {
      id: 'p1',
      name: 'Dead',
      host: 'd',
      port: 1,
      lastLatencyMs: 5000,
      lastTestedAt: 100,
      isDisabled: true,
    },
  ]
  const diag = buildProxyDiagnostics({ proxyManager: fakeProxyManager(proxies) })
  diag.scan()
  proxies[0].lastLatencyMs = 6000
  proxies[0].lastTestedAt = 200
  diag.scan()
  assert.strictEqual(diag.getAlerts().filter((a) => a.kind === 'latency-spike').length, 0)
})

// ---------------- 5: dedup logic ----------------
console.log('\n5. dedup logic')

it('dedup: re-scan within 6h does not duplicate urgent alert', () => {
  const clock = fakeClock(1_000_000_000_000)
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  diag.scan()
  diag.scan()
  assert.strictEqual(
    diag.getAlerts().filter((a) => a.kind === 'proxy-disabled').length,
    1,
  )
})

it('dedup: re-fires after dedup window expires', () => {
  const clock = fakeClock(1_000_000_000_000)
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  const a1 = diag.getAlerts()[0]
  // Dismiss the existing alert so a re-fire creates a new entry
  diag.dismissAlert(a1.id)
  // Advance past dedup window
  clock.advance(DEFAULT_DEDUP_URGENT_MS + 60_000)
  diag.scan()
  const after = diag.getAlerts().filter((a) => a.kind === 'proxy-disabled')
  assert.strictEqual(after.length, 1, 'second alert fires after dedup expiration')
  assert.notStrictEqual(after[0].id, a1.id)
})

it('warning kinds use longer (24h) dedup window', () => {
  const clock = fakeClock(1_000_000_000_000)
  const pm = fakeProxyManager([
    { id: 'p1', name: 'Stale', host: 's', port: 1, lastTestedAt: null },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag.scan()
  assert.strictEqual(diag.getAlerts().filter((a) => a.kind === 'proxy-stale').length, 1)
  const a1 = diag.getAlerts()[0]
  diag.dismissAlert(a1.id)
  // Advance 6h+ (urgent window) but less than 24h (warning window)
  clock.advance(DEFAULT_DEDUP_URGENT_MS + 60_000)
  diag.scan()
  // dismissAlert resets dedup, so re-fire would still happen — let's instead
  // test the *non-dismissed* path: re-scan within 24h should NOT add new alert
  // (use a fresh instance for this check)
  const diag2 = buildProxyDiagnostics({ proxyManager: pm, now: clock.now })
  diag2.scan()
  const before = diag2.getAlerts().filter((a) => a.kind === 'proxy-stale')[0]
  clock.advance(DEFAULT_DEDUP_WARNING_MS - 60_000)
  diag2.scan()
  const after = diag2.getAlerts().filter((a) => a.kind === 'proxy-stale')
  // Same single alert object preserved (no duplicate)
  assert.strictEqual(after.length, 1)
  assert.strictEqual(after[0].id, before.id)
})

// ---------------- 6: dismiss + dismissAll ----------------
console.log('\n6. dismiss')

it('dismissAlert removes alert from getAlerts', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm })
  diag.scan()
  const a = diag.getAlerts()[0]
  const r = diag.dismissAlert(a.id)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(diag.getAlerts().length, 0)
})

it('dismissAlert returns NOT_FOUND for unknown id', () => {
  const diag = buildProxyDiagnostics({ proxyManager: fakeProxyManager([]) })
  const r = diag.dismissAlert('does-not-exist')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'NOT_FOUND')
})

it('dismissAlert with no id returns NO_ID', () => {
  const diag = buildProxyDiagnostics({ proxyManager: fakeProxyManager([]) })
  const r = diag.dismissAlert()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'NO_ID')
})

it('dismissAll dismisses every active alert', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'A', host: 'a', port: 1, isDisabled: true },
    { id: 'p2', name: 'B', host: 'b', port: 2, isDisabled: true },
    { id: 'p3', name: 'C', host: 'c', port: 3, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm })
  diag.scan()
  assert.strictEqual(diag.getAlerts().length, 3)
  const r = diag.dismissAll()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.dismissed, 3)
  assert.strictEqual(diag.getAlerts().length, 0)
})

// ---------------- 7: defensive (missing managers) ----------------
console.log('\n7. defensive')

it('no proxyManager → scan returns ok with 0 alerts, no throw', () => {
  const diag = buildProxyDiagnostics({})
  const r = diag.scan()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.count, 0)
})

it('no identityManager → unassigned check skipped, no throw', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm })
  const r = diag.scan()
  assert.strictEqual(r.ok, true)
  // proxy-disabled still fires
  assert.strictEqual(diag.getAlerts().length, 1)
})

it('no alertManager → still creates internal alerts, no throw', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm }) // no alertManager
  diag.scan()
  assert.strictEqual(diag.getAlerts().length, 1)
})

it('alertManager.add throwing does not break scan', () => {
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const am = {
    add: () => {
      throw new Error('alertManager broken')
    },
  }
  const diag = buildProxyDiagnostics({ proxyManager: pm, alertManager: am })
  const r = diag.scan()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(diag.getAlerts().length, 1)
})

// ---------------- 8: notify callback ----------------
console.log('\n8. notify callback dispatch')

it('notify fn called with title/body/severity for each new alert', () => {
  const dispatched = []
  const notify = (title, body, severity) => dispatched.push({ title, body, severity })
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, notify })
  diag.scan()
  assert.strictEqual(dispatched.length, 1)
  assert.strictEqual(dispatched[0].severity, 'urgent')
  assert.ok(dispatched[0].title.includes('X'))
})

it('notify NOT called on dedup re-scan (same condition)', () => {
  const dispatched = []
  const notify = (t, b, s) => dispatched.push({ t, b, s })
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, notify })
  diag.scan()
  diag.scan()
  diag.scan()
  assert.strictEqual(dispatched.length, 1)
})

it('notify throwing does not break scan', () => {
  const notify = () => {
    throw new Error('notify broken')
  }
  const pm = fakeProxyManager([
    { id: 'p1', name: 'X', host: 'x', port: 1, isDisabled: true },
  ])
  const diag = buildProxyDiagnostics({ proxyManager: pm, notify })
  const r = diag.scan()
  assert.strictEqual(r.ok, true)
})

// ---------------- summary ----------------
console.log(`\nproxy-diagnostics smoketest: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
