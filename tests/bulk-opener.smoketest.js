// OZ Browser — bulk-opener smoke test (C-4).
//
// Run:
//   cd oz-browser
//   node tests/bulk-opener.smoketest.js
//
// Covers (pure module — FakeManagers injected, no Electron):
//   - resolveUrlPattern / resolveNamePattern with {n} (1-indexed) and {i} (0-indexed)
//   - validateInput: bad mode / empty selection / out-of-range count
//   - resolveTargetWorkspace: current valid, current archived, new auto-named
//   - bulkOpenFromExisting: happy path opens N tabs in N identities
//   - bulkOpenFromExisting: moves identity to target workspace when needed
//   - bulkOpenFromExisting: skips locked identity with errors[] entry
//   - bulkOpenFromExisting: skips missing identity
//   - bulkOpenFromExisting: same workspace → no move call
//   - bulkCreateNew: creates N identities with naming pattern + opens tabs
//   - bulkCreateNew: URL pattern resolution per-identity
//   - bulkCreateNew: workspace auto-create
//   - validateInput edge cases: count=0, count=201, missing namePattern

const path = require('path')

delete require.cache[require.resolve('../browser/bulk-opener.js')]
const m = require(path.join('..', 'browser', 'bulk-opener.js'))

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

// FakeManagers — minimal in-memory stubs that mirror the real managers'
// signatures for what bulk-opener calls.
function makeFakes() {
  let nextIdentityId = 1
  let nextWorkspaceId = 1
  let nextTabId = 1
  const identities = []
  const workspaces = []
  const moveCalls = []
  const openCalls = []
  const wsCreated = []

  const identityManager = {
    list: () => identities.slice(),
    get: (id) => identities.find((i) => i.id === id),
    create({ name, color, workspaceId }) {
      const id = `id-${nextIdentityId++}`
      const ident = { id, name, color: color || '#888', workspaceId, locked: false }
      identities.push(ident)
      return ident
    },
    moveToWorkspace(id, targetWorkspaceId) {
      moveCalls.push({ id, targetWorkspaceId })
      const ident = identities.find((i) => i.id === id)
      if (!ident) return { ok: false, reason: 'identity-not-found' }
      if (ident.locked) return { ok: false, reason: 'identity-locked' }
      ident.workspaceId = targetWorkspaceId
      return { ok: true }
    },
  }

  const workspaceManager = {
    get: (id) => workspaces.find((w) => w.id === id),
    create({ name, color }) {
      const id = `ws-${nextWorkspaceId++}`
      const ws = { id, name, color, isArchived: false }
      workspaces.push(ws)
      wsCreated.push(ws)
      return ws
    },
  }

  const tabsHandlers = {
    openInIdentity(identityId, url) {
      openCalls.push({ identityId, url })
      return { id: nextTabId++, identityId, url }
    },
  }

  const log = { info() {}, warn() {} }

  return {
    deps: { identityManager, workspaceManager, tabsHandlers, log },
    seed: {
      addIdentity(props = {}) {
        const ident = {
          id: props.id || `seed-${nextIdentityId++}`,
          name: props.name || 'X',
          color: props.color || '#000',
          workspaceId: props.workspaceId || null,
          locked: !!props.locked,
        }
        identities.push(ident)
        return ident
      },
      addWorkspace(props = {}) {
        const ws = {
          id: props.id || `ws-${nextWorkspaceId++}`,
          name: props.name || 'W',
          color: props.color || '#0a0',
          isArchived: !!props.isArchived,
        }
        workspaces.push(ws)
        return ws
      },
    },
    inspect: { identities, workspaces, moveCalls, openCalls, wsCreated },
  }
}

console.log('OZ Browser — bulk-opener smoke test')

// ───────────────────────────────────────────────────────────────────────────
section('Template resolution')
// ───────────────────────────────────────────────────────────────────────────
ok(
  'resolveUrlPattern {n} 1-indexed',
  m.resolveUrlPattern('https://x.com/p{n}', 5) === 'https://x.com/p5',
)
ok('resolveNamePattern {n} 1-indexed', m.resolveNamePattern('IG {n}', 7) === 'IG 7')
ok(
  'resolveUrlPattern {i} 0-indexed',
  m.resolveUrlPattern('https://x.com/p{i}', 5) === 'https://x.com/p4',
)
ok(
  'no token → string unchanged',
  m.resolveUrlPattern('https://x.com', 99) === 'https://x.com',
)
ok('{n} and {i} mixed both resolved', m.resolveUrlPattern('a{n}-b{i}', 3) === 'a3-b2')

// ───────────────────────────────────────────────────────────────────────────
section('validateInput')
// ───────────────────────────────────────────────────────────────────────────
{
  const v = m.validateInput({ mode: 'unknown' })
  ok('invalid mode rejected', v.ok === false && v.reason === 'invalid-mode')
}
{
  const v = m.validateInput({ mode: 'fromExisting', identityIds: [] })
  ok(
    'fromExisting empty selection rejected',
    !v.ok && v.reason === 'no-identities-selected',
  )
}
{
  const v = m.validateInput({ mode: 'fromExisting', identityIds: ['a', 'b'] })
  ok('fromExisting non-empty accepted', v.ok)
}
{
  const v = m.validateInput({ mode: 'createNew', count: 0 })
  ok('createNew count=0 rejected', !v.ok && v.reason === 'invalid-count')
}
{
  const v = m.validateInput({ mode: 'createNew', count: 201, namePattern: 'X {n}' })
  ok('createNew count>200 rejected', !v.ok && v.reason === 'invalid-count')
}
{
  const v = m.validateInput({ mode: 'createNew', count: 5 })
  ok(
    'createNew missing namePattern rejected',
    !v.ok && v.reason === 'name-pattern-required',
  )
}
{
  const v = m.validateInput({ mode: 'createNew', count: 5, namePattern: 'IG {n}' })
  ok('createNew valid accepted', v.ok)
}

// ───────────────────────────────────────────────────────────────────────────
section('resolveTargetWorkspace')
// ───────────────────────────────────────────────────────────────────────────
{
  const { deps, seed } = makeFakes()
  const ws = seed.addWorkspace({ id: 'general', name: 'General' })
  const r = m.resolveTargetWorkspace({ kind: 'current', workspaceId: ws.id }, deps)
  ok('current valid', r.ok && r.workspaceId === 'general' && r.created === false)
}
{
  const { deps, seed } = makeFakes()
  seed.addWorkspace({ id: 'gone', isArchived: true })
  const r = m.resolveTargetWorkspace({ kind: 'current', workspaceId: 'gone' }, deps)
  ok('current archived rejected', !r.ok && r.reason === 'workspace-archived')
}
{
  const { deps, inspect } = makeFakes()
  const r = m.resolveTargetWorkspace({ kind: 'new', name: 'Bulk' }, deps)
  ok('new auto-created', r.ok && r.created === true)
  ok('new ws name passed through', inspect.wsCreated[0].name === 'Bulk')
}
{
  const { deps } = makeFakes()
  const r = m.resolveTargetWorkspace({ kind: 'new' }, deps)
  ok('new without name auto-generates', r.ok && r.created === true)
}

// ───────────────────────────────────────────────────────────────────────────
section('bulkOpenFromExisting')
// ───────────────────────────────────────────────────────────────────────────
{
  const { deps, seed, inspect } = makeFakes()
  const ws = seed.addWorkspace({ id: 'general' })
  const a = seed.addIdentity({ id: 'a', workspaceId: ws.id })
  const b = seed.addIdentity({ id: 'b', workspaceId: ws.id })
  const r = m.bulkOpenFromExisting(
    {
      identityIds: [a.id, b.id],
      urlPattern: 'https://x.com/{n}',
      target: { kind: 'current', workspaceId: ws.id },
    },
    deps,
  )
  ok('happy path ok=true', r.ok)
  ok('opened 2 tabs', r.opened.length === 2)
  ok('no errors', r.errors.length === 0)
  ok(
    'urls resolved per-counter',
    inspect.openCalls[0].url === 'https://x.com/1' &&
      inspect.openCalls[1].url === 'https://x.com/2',
  )
  ok('no move calls (already in target)', inspect.moveCalls.length === 0)
}
{
  const { deps, seed, inspect } = makeFakes()
  const source = seed.addWorkspace({ id: 'src' })
  const target = seed.addWorkspace({ id: 'tgt' })
  seed.addIdentity({ id: 'a', workspaceId: source.id })
  m.bulkOpenFromExisting(
    {
      identityIds: ['a'],
      target: { kind: 'current', workspaceId: target.id },
    },
    deps,
  )
  ok('move call issued when ws differs', inspect.moveCalls.length === 1)
  ok(
    'move target = requested target',
    inspect.moveCalls[0].targetWorkspaceId === target.id,
  )
}
{
  const { deps, seed } = makeFakes()
  const ws = seed.addWorkspace({ id: 'general' })
  seed.addIdentity({ id: 'free', workspaceId: 'other' })
  seed.addIdentity({ id: 'locked', workspaceId: 'other', locked: true })
  const r = m.bulkOpenFromExisting(
    {
      identityIds: ['free', 'locked'],
      target: { kind: 'current', workspaceId: ws.id },
    },
    deps,
  )
  ok('locked identity skipped, opens 1', r.opened.length === 1)
  ok(
    'error reported for locked',
    r.errors.find((e) => e.identityId === 'locked' && e.reason === 'identity-locked'),
  )
}
{
  const { deps, seed } = makeFakes()
  const ws = seed.addWorkspace({ id: 'general' })
  const r = m.bulkOpenFromExisting(
    {
      identityIds: ['ghost'],
      target: { kind: 'current', workspaceId: ws.id },
    },
    deps,
  )
  ok(
    'missing identity returns identity-not-found',
    r.errors[0].reason === 'identity-not-found',
  )
}
{
  const { deps, seed, inspect } = makeFakes()
  seed.addIdentity({ id: 'a', workspaceId: 'old' })
  const r = m.bulkOpenFromExisting(
    {
      identityIds: ['a'],
      urlPattern: 'about:blank',
      target: { kind: 'new', name: 'Bulk IG' },
    },
    deps,
  )
  ok('new ws target works end-to-end', r.ok && r.workspaceCreated)
  ok('exactly 1 ws created', inspect.wsCreated.length === 1)
  ok('tab opened', inspect.openCalls.length === 1)
}
{
  const { deps, seed } = makeFakes()
  const ws = seed.addWorkspace({ id: 'general' })
  const r = m.bulkOpenFromExisting(
    {
      identityIds: [],
      target: { kind: 'current', workspaceId: ws.id },
    },
    deps,
  )
  ok(
    'empty identities → validation error',
    !r.ok && r.reason === 'no-identities-selected',
  )
}

// ───────────────────────────────────────────────────────────────────────────
section('bulkCreateNew')
// ───────────────────────────────────────────────────────────────────────────
{
  const { deps, seed, inspect } = makeFakes()
  seed.addWorkspace({ id: 'general' })
  const r = m.bulkCreateNew(
    {
      count: 3,
      namePattern: 'IG {n}',
      urlPattern: 'https://instagram.com/{n}',
      target: { kind: 'current', workspaceId: 'general' },
    },
    deps,
  )
  ok('createNew ok', r.ok)
  ok('created 3', r.created.length === 3)
  ok(
    'naming applied 1-indexed',
    r.created[0].name === 'IG 1' &&
      r.created[1].name === 'IG 2' &&
      r.created[2].name === 'IG 3',
  )
  ok(
    'urls resolved',
    inspect.openCalls[0].url === 'https://instagram.com/1' &&
      inspect.openCalls[2].url === 'https://instagram.com/3',
  )
  ok('3 identities pushed to identityManager.list()', inspect.identities.length === 3)
}
{
  const { deps, inspect } = makeFakes()
  const r = m.bulkCreateNew(
    {
      count: 2,
      namePattern: 'X {n}',
      color: '#a00',
      target: { kind: 'new', name: 'Batch' },
    },
    deps,
  )
  ok('createNew with new ws target', r.ok && r.workspaceCreated === true)
  ok('color propagated', inspect.identities[0].color === '#a00')
  ok(
    'all in same new ws',
    inspect.identities.every((i) => i.workspaceId === inspect.wsCreated[0].id),
  )
}
{
  const { deps } = makeFakes()
  const r = m.bulkCreateNew(
    {
      count: 0,
      namePattern: 'X {n}',
      target: { kind: 'new' },
    },
    deps,
  )
  ok('count=0 rejected', !r.ok && r.reason === 'invalid-count')
}

// ───────────────────────────────────────────────────────────────────────────
section('Done')
console.log(`\nPassed: ${passed}   Failed: ${failed}`)
if (failed > 0) {
  console.error('\nFailures:')
  failures.forEach((f) => console.error('  - ' + f.label))
  process.exit(1)
}
process.exit(0)
