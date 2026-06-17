// OZ Browser — sidebar-view helpers smoke test (alpha.32).
//
// Run:
//   cd oz-browser
//   node tests/sidebar-view.smoketest.js
//
// Covers (pure module — no Electron / DOM):
//   - visibleWorkspaces: archived filter + createdAt sort
//   - identitiesForWorkspace: workspaceId scoping
//   - scopeTabsToWorkspace: cross-workspace tab isolation (the bug fix)

'use strict'

const assert = require('assert')
const path = require('path')

delete require.cache[require.resolve('../browser/ui/sidebar-view.js')]
const V = require(path.join('..', 'browser', 'ui', 'sidebar-view.js'))

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const workspaces = [
  { id: 'general', name: 'General', createdAt: 1 },
  { id: 'wsB', name: 'Client B', createdAt: 3 },
  { id: 'wsA', name: 'Client A', createdAt: 2 },
  { id: 'wsOld', name: 'Archived', createdAt: 0, isArchived: true },
]

const identities = [
  { id: 'i1', name: 'Pedro', workspaceId: 'general' },
  { id: 'i2', name: 'Contexto', workspaceId: 'wsA' },
  { id: 'i3', name: 'Informe', workspaceId: 'wsA' },
  { id: 'i4', name: 'Other', workspaceId: 'wsB' },
]

// Live tabs aggregated across ALL windows (general + wsA + wsB open).
const tabs = [
  { id: 't1', identityId: 'i1' }, // general
  { id: 't2', identityId: 'i2' }, // wsA
  { id: 't3', identityId: 'i3' }, // wsA
  { id: 't4', identityId: 'i4' }, // wsB
]

console.log('sidebar-view smoke test')

ok('visibleWorkspaces hides archived + sorts by createdAt', () => {
  const r = V.visibleWorkspaces(workspaces, false)
  assert.deepStrictEqual(
    r.map((w) => w.id),
    ['general', 'wsA', 'wsB'],
  )
})

ok('visibleWorkspaces shows archived when toggled', () => {
  const r = V.visibleWorkspaces(workspaces, true)
  assert.strictEqual(r.length, 4)
  assert.strictEqual(r[0].id, 'wsOld') // createdAt 0 sorts first
})

ok('identitiesForWorkspace scopes by workspaceId', () => {
  assert.deepStrictEqual(
    V.identitiesForWorkspace(identities, 'wsA').map((i) => i.id),
    ['i2', 'i3'],
  )
  assert.deepStrictEqual(V.identitiesForWorkspace(identities, null), [])
})

ok('scopeTabsToWorkspace keeps only the active workspace tabs', () => {
  // Active = wsA → only its identities' tabs, NOT general/wsB tabs.
  assert.deepStrictEqual(
    V.scopeTabsToWorkspace(tabs, identities, 'wsA').map((t) => t.id),
    ['t2', 't3'],
  )
  // Active = general → only t1.
  assert.deepStrictEqual(
    V.scopeTabsToWorkspace(tabs, identities, 'general').map((t) => t.id),
    ['t1'],
  )
})

ok('scopeTabsToWorkspace is empty for unknown / null workspace', () => {
  assert.deepStrictEqual(V.scopeTabsToWorkspace(tabs, identities, 'nope'), [])
  assert.deepStrictEqual(V.scopeTabsToWorkspace(tabs, identities, null), [])
})

ok('tolerates empty / undefined inputs', () => {
  assert.deepStrictEqual(V.visibleWorkspaces(undefined, false), [])
  assert.deepStrictEqual(V.identitiesForWorkspace(undefined, 'wsA'), [])
  assert.deepStrictEqual(V.scopeTabsToWorkspace(undefined, undefined, 'wsA'), [])
})

ok('filterIdentities matches name case-insensitively', () => {
  assert.deepStrictEqual(
    V.filterIdentities(identities, 'cont').map((i) => i.id),
    ['i2'], // "Contexto"
  )
  // case-insensitive
  assert.deepStrictEqual(
    V.filterIdentities(identities, 'PEDR').map((i) => i.id),
    ['i1'], // "Pedro"
  )
  // empty query → all (new array)
  assert.strictEqual(V.filterIdentities(identities, '   ').length, 4)
})

ok('sortIdentities: alpha / created / frequency', () => {
  const ids = [
    { id: 'a', name: 'Zeta', createdAt: 1 },
    { id: 'b', name: 'alpha', createdAt: 3 },
    { id: 'c', name: 'Mike', createdAt: 2 },
  ]
  assert.deepStrictEqual(
    V.sortIdentities(ids, 'alpha').map((i) => i.id),
    ['b', 'c', 'a'], // alpha, Mike, Zeta (case-insensitive)
  )
  assert.deepStrictEqual(
    V.sortIdentities(ids, 'created').map((i) => i.id),
    ['a', 'c', 'b'], // createdAt 1,2,3
  )
  assert.deepStrictEqual(
    V.sortIdentities(ids, 'frequency', { c: 5, a: 2, b: 0 }).map((i) => i.id),
    ['c', 'a', 'b'], // by use count desc
  )
})

ok('filterIdentities also matches tags (alpha.40)', () => {
  const ids = [
    { id: 'a', name: 'Pedro', tags: ['cliente', 'ventas'] },
    { id: 'b', name: 'Ana', tags: ['soporte'] },
    { id: 'c', name: 'Luis', tags: [] },
  ]
  assert.deepStrictEqual(
    V.filterIdentities(ids, 'vent').map((i) => i.id),
    ['a'], // matches tag "ventas"
  )
  assert.deepStrictEqual(
    V.filterIdentities(ids, 'SOPORTE').map((i) => i.id),
    ['b'], // case-insensitive tag match
  )
  // name still matches
  assert.deepStrictEqual(
    V.filterIdentities(ids, 'luis').map((i) => i.id),
    ['c'],
  )
})

ok('sortIdentities does not mutate input', () => {
  const ids = [
    { id: 'a', name: 'B', createdAt: 1 },
    { id: 'b', name: 'A', createdAt: 2 },
  ]
  const before = ids.map((i) => i.id).join(',')
  V.sortIdentities(ids, 'alpha')
  assert.strictEqual(ids.map((i) => i.id).join(','), before)
})

console.log(`\nsidebar-view: ${passed} checks passed ✓`)
