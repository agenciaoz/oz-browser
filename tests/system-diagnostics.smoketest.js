// OZ Browser — system-diagnostics smoke test (alpha.112).
//
//   node tests/system-diagnostics.smoketest.js
//
// Cubre buildDiagnostics (con browser fake), parseLogTail, summarizeProxies y
// selfCheck. Puro — sin Electron (el screenshot vive en diagnostics-handlers y
// requiere Electron, se valida en smoke vivo).

'use strict'

const assert = require('assert')

const {
  buildDiagnostics,
  summarizeProxies,
  parseLogTail,
  selfCheck,
} = require('../browser/system-diagnostics.js')

let passed = 0
function ok(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' :: ' + detail : ''}`)
  passed++
  console.log('  ✓ ' + name)
}

console.log('system-diagnostics smoke test')

// ---- summarizeProxies ----
{
  const s = summarizeProxies([
    { id: 'p1', name: 'A', isActive: true, failureCount: 0, lastLatencyMs: 100 },
    { id: 'p2', name: 'B', isActive: true, failureCount: 3, lastLatencyMs: 300 },
    { id: 'p3', name: 'C', isDisabled: true, failureCount: 9 },
  ])
  ok('total 3', s.total === 3)
  ok('active 2', s.active === 2)
  ok('disabled 1', s.disabled === 1)
  ok('failing 2 (p2,p3)', s.failing === 2)
  ok('avgLatency = (100+300)/2 = 200', s.avgLatencyMs === 200)
  ok('worst = p3 (9 fails)', s.worst && s.worst.id === 'p3')
  const empty = summarizeProxies([])
  ok('empty → total 0, avg null', empty.total === 0 && empty.avgLatencyMs === null)
  ok('non-array defensivo', summarizeProxies(null).total === 0)
}

// ---- parseLogTail ----
{
  const text = [
    '[2026-07-16T00:00:00.000Z] INFO  [boot] started',
    '[2026-07-16T00:00:01.000Z] DEBUG [x] noise',
    '[2026-07-16T00:00:02.000Z] WARN  [proxy] slow',
    '[2026-07-16T00:00:03.000Z] ERROR [proxy] 407 loop',
    'a line with no level marker',
  ].join('\n')
  const r = parseLogTail(text, { level: 'WARN', limit: 10 })
  ok(
    'counts todos los niveles',
    r.counts.INFO === 1 &&
      r.counts.DEBUG === 1 &&
      r.counts.WARN === 1 &&
      r.counts.ERROR === 1,
  )
  ok('filtra >= WARN (2 líneas)', r.lines.length === 2)
  ok(
    'incluye el ERROR',
    r.lines.some((l) => l.includes('407 loop')),
  )
  ok('excluye el INFO', !r.lines.some((l) => l.includes('started')))
  const rErr = parseLogTail(text, { level: 'ERROR' })
  ok('level ERROR → solo 1', rErr.lines.length === 1)
  const rLim = parseLogTail(text, { level: 'DEBUG', limit: 2 })
  ok('limit corta al final (2)', rLim.lines.length === 2)
  ok('parseLogTail texto vacío → 0', parseLogTail('').lines.length === 0)
}

// ---- selfCheck ----
{
  const good = {
    identityManager: { list: () => [] },
    proxyManager: { list: () => [] },
    proxyAssignment: { resolveRouting: () => ({}) },
    workspaceManager: { list: () => [] },
    settingsManager: { getAll: () => ({}) },
    windows: [],
    handlers: { sync: { getStatus: () => ({}) }, diag: { snapshot: () => ({}) } },
  }
  const sc = selfCheck(good)
  ok('selfCheck ok con todo presente', sc.ok === true && sc.failed === 0)
  const bad = selfCheck({})
  ok('selfCheck detecta faltantes', bad.ok === false && bad.failed > 0)
  ok('selfCheck sin browser no tira', selfCheck(null).ok === false)
}

// ---- buildDiagnostics con browser fake ----
{
  const fakeBrowser = {
    enforceProxy: true,
    identityManager: {
      list: () => [
        { id: 'default', name: 'Default', isDefault: true, workspaceId: 'general' },
        { id: 'i2', name: 'IG', workspaceId: 'ws1', locked: true },
      ],
      sessionCache: new Map([['default', {}]]),
    },
    proxyManager: {
      list: () => [
        { id: 'p1', name: 'Miami', isActive: true, failureCount: 0, lastLatencyMs: 400 },
      ],
    },
    workspaceManager: { list: () => [{ id: 'general' }, { id: 'ws1' }] },
    settingsManager: {
      getAll: () => ({
        performance: { warmProxiesOnWorkspace: true },
        privacy: { autoMatchGeo: true },
        sync: { enabled: false },
      }),
    },
    windows: [
      {
        id: 'w1',
        workspaceId: 'ws1',
        tabs: {
          tabList: [
            { materialized: true, identityId: 'i2' },
            { materialized: false, identityId: 'i2' },
          ],
        },
      },
    ],
    handlers: { sync: { getStatus: () => ({ enabled: false, lastSyncAt: null }) } },
    _lastScrapeReport: {
      jobId: 'j1',
      wallMs: 1234,
      cost: { pages: 5, ok: 4, failed: 1 },
    },
  }

  const d = buildDiagnostics(fakeBrowser, { includeLog: false })
  ok('runtime.ozVersion presente', typeof d.runtime.ozVersion === 'string')
  ok('enforceProxy true', d.enforceProxy === true)
  ok('identities.count 2', d.identities.count === 2)
  ok(
    'identities.list mapeado',
    d.identities.list[1].name === 'IG' && d.identities.list[1].locked === true,
  )
  ok('proxies.total 1', d.proxies.total === 1)
  ok('proxies.avgLatency 400', d.proxies.avgLatencyMs === 400)
  ok('sessionsCached 1', d.sessionsCached === 1)
  ok(
    'tabs total 2 (1 mat, 1 lazy)',
    d.tabs.total === 2 && d.tabs.materialized === 1 && d.tabs.lazy === 1,
  )
  ok('tabs.windows desglose', d.tabs.windows[0].workspaceId === 'ws1')
  ok('workspaces 2', d.workspaces === 2)
  ok('sync status', d.sync && d.sync.enabled === false)
  ok('settings.performance', d.settings.performance.warmProxiesOnWorkspace === true)
  ok('lastScrape resumido', d.lastScrape.jobId === 'j1' && d.lastScrape.cost.pages === 5)
  ok('selfCheck embebido ok', d.selfCheck && typeof d.selfCheck.ok === 'boolean')
  ok('sin log block cuando includeLog=false', d.log === undefined)
}

// ---- buildDiagnostics defensivo: browser vacío no tira ----
{
  const d = buildDiagnostics({}, { includeLog: false })
  ok('browser vacío → identities.count 0', d.identities.count === 0)
  ok('browser vacío → proxies.total 0', d.proxies.total === 0)
  ok('browser vacío → no crashea', typeof d.generatedAt === 'string')
}

console.log(`\n=== ${passed} passed · 0 failed ===`)
process.exit(0)
