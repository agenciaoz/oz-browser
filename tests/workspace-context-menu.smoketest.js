// OZ Browser — workspace-context-menu smoke test (K1-extras, v1.4.0).
//
// Cómo correr:
//   cd oz-browser
//   node tests/workspace-context-menu.smoketest.js
//
// Cubre la nueva entry "Open all identities in tabs…" agregada en v1.4.0
// + las entries pre-existentes (Rename, Duplicate, Freeze, Quick Tabs,
// Archive, Delete) — defensive guards via fake managers.

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const orig = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/workspace-context-menu.js')]
const { buildWorkspaceContextMenu } = require('../browser/workspace-context-menu.js')

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

console.log('OZ Browser — workspace-context-menu smoke test')

function fakeBrowser(ws, opts = {}) {
  const broadcasts = []
  return {
    workspaceManager: {
      get: (id) => (ws && ws.id === id ? ws : null),
    },
    handlers: {
      workspaces: {
        duplicate: () => 'dup',
        freeze: () => 'freeze',
        unfreeze: () => 'unfreeze',
        update: () => 'update',
        archive: () => 'archive',
        restore: () => 'restore',
        remove: () => 'remove',
      },
    },
    broadcastToWebUI: (channel, payload) => {
      broadcasts.push({ channel, payload })
    },
    _broadcasts: broadcasts,
  }
}

const wsNormal = {
  id: 'w1',
  name: 'Insta',
  isFrozen: false,
  isArchived: false,
  isDefault: false,
  identityIds: ['i1', 'i2', 'i3'],
}
const wsFrozen = { ...wsNormal, isFrozen: true }
const wsArchived = { ...wsNormal, isArchived: true }
const wsEmpty = { ...wsNormal, identityIds: [] }
const wsDefault = { ...wsNormal, isDefault: true }

// ============================================================================
console.log('\nbasic shape + new "Open all identities" entry')
// ============================================================================

{
  const browser = fakeBrowser(wsNormal)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  ok('returns non-empty template', Array.isArray(tpl) && tpl.length > 0)
  const labels = tpl.map((t) => t.label).filter(Boolean)
  ok(
    'contains Rename + Duplicate + Freeze + Quick Tabs',
    labels.some((l) => l === 'Rename') &&
      labels.some((l) => l === 'Duplicate') &&
      labels.some((l) => /^(Freeze|Unfreeze)$/.test(l)) &&
      labels.some((l) => l === 'Quick Tabs'),
  )

  const openAll = tpl.find(
    (t) => t.label && t.label.startsWith('Open all identities in tabs'),
  )
  ok('K1-extras: "Open all identities…" entry exists', !!openAll)
  ok('entry shows identity count in label', openAll && openAll.label.includes('(3)'))
  ok('entry is enabled (workspace has identities)', openAll && openAll.enabled === true)
}

// ============================================================================
console.log('\nenabled/disabled gates')
// ============================================================================

{
  const browser = fakeBrowser(wsEmpty)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  const openAll = tpl.find(
    (t) => t.label && t.label.startsWith('Open all identities in tabs'),
  )
  ok(
    'empty workspace → disabled with (0) count',
    openAll && openAll.enabled === false && openAll.label.includes('(0)'),
  )
}

{
  const browser = fakeBrowser(wsFrozen)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  const openAll = tpl.find(
    (t) => t.label && t.label.startsWith('Open all identities in tabs'),
  )
  ok('frozen workspace → entry disabled', openAll && openAll.enabled === false)
}

{
  const browser = fakeBrowser(wsArchived)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  const openAll = tpl.find(
    (t) => t.label && t.label.startsWith('Open all identities in tabs'),
  )
  ok('archived workspace → entry disabled', openAll && openAll.enabled === false)
}

// ============================================================================
console.log('\nclick handler broadcasts pre-fill payload')
// ============================================================================

{
  const browser = fakeBrowser(wsNormal)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  const openAll = tpl.find(
    (t) => t.label && t.label.startsWith('Open all identities in tabs'),
  )
  openAll.click()
  const bcast = browser._broadcasts.find((b) => b.channel === 'oz:bulk-open:open')
  ok('broadcast channel = oz:bulk-open:open', !!bcast)
  ok(
    'payload includes mode:existing + workspaceId + identityIds',
    bcast &&
      bcast.payload.mode === 'existing' &&
      bcast.payload.workspaceId === 'w1' &&
      Array.isArray(bcast.payload.identityIds) &&
      bcast.payload.identityIds.length === 3,
  )
}

// ============================================================================
console.log('\nedge cases — missing managers')
// ============================================================================

{
  const browser = { workspaceManager: null }
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  ok('no workspaceManager → empty template', Array.isArray(tpl) && tpl.length === 0)
}

{
  const browser = fakeBrowser(null)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'missing' })
  ok(
    'unknown wsId → single disabled placeholder',
    tpl.length === 1 && tpl[0].enabled === false,
  )
}

// ============================================================================
// default workspace edge: still has Open all entry (it's a normal action)
// ============================================================================
{
  const browser = fakeBrowser(wsDefault)
  const tpl = buildWorkspaceContextMenu({ browser, wsId: 'w1' })
  const openAll = tpl.find(
    (t) => t.label && t.label.startsWith('Open all identities in tabs'),
  )
  ok('default workspace still gets Open all entry', !!openAll)
  // Default workspace lacks Archive/Delete (that's the existing isDefault gate).
  const hasDelete = tpl.some((t) => t.label === 'Delete workspace')
  ok('default workspace has NO Delete entry', !hasDelete)
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
