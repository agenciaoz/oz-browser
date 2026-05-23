// OZ Browser — command-palette-handlers smoke test (alpha.20).
//
// Run:
//   cd oz-browser
//   node tests/command-palette-handlers.smoketest.js
//
// Why this test exists:
//   alpha.19 shipped with `browser/command-palette-handlers.js:36` calling
//   `win.tabs.list()`, but the Tabs class never had a `list()` method (it
//   exposes a `tabList` array property). The Cmd+K palette crashed in
//   production with "win.tabs.list is not a function" and CI never caught
//   it because no test ever instantiated the handler with a real-shape
//   focused window. alpha.20 adds this test so future regressions of the
//   wire-up between the handler and a Window-shaped object are caught.
//
// Scope: pure handler module + stubbed browser. No Electron, no DOM.
//
// Tests:
//   - list() does not throw when given a focused window whose .tabs has a
//     `tabList` array (the real shape Tabs exposes)
//   - list() returns commands with tabs surfaced from tabList
//   - list() tolerates a window with no tabs object (returns commands w/o tabs)
//   - list() tolerates getFocusedWindow returning null (no win)
//   - list() honors explicit focusedWindowId override

const path = require('path')

delete require.cache[require.resolve('../browser/command-palette-handlers.js')]
const { buildCommandPaletteHandlers } = require(
  path.join('..', 'browser', 'command-palette-handlers.js'),
)

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

function fakeTab(id, opts = {}) {
  return {
    id,
    title: opts.title || `Tab ${id}`,
    url: opts.url || `https://example.com/${id}`,
    pinned: !!opts.pinned,
    locked: !!opts.locked,
  }
}

function fakeWindow({
  id = 'win-1',
  workspaceId = 'ws-1',
  tabs = [],
  focusedTab = null,
} = {}) {
  return {
    id,
    workspaceId,
    // Real-shape: Tabs container exposes `tabList` as an array, NOT a
    // .list() method. This is exactly the shape that caused alpha.19's bug.
    tabs: { tabList: tabs },
    getFocusedTab() {
      return focusedTab
    },
  }
}

function fakeBrowser({
  windows = [],
  focusedWindow = null,
  identities = [{ id: 'id-1', name: 'Default' }],
  workspaces = [{ id: 'ws-1', name: 'General', archived: false }],
  activeIdentityId = 'id-1',
} = {}) {
  return {
    windows,
    activeIdentityId,
    getFocusedWindow: () => focusedWindow,
    identityManager: { list: () => identities },
    workspaceManager: { list: () => workspaces },
  }
}

console.log('OZ Browser — command-palette-handlers smoke test')

// ───────────────────────────────────────────────────────────────────────────
section('the alpha.19 regression — win.tabs.tabList shape')
// ───────────────────────────────────────────────────────────────────────────
{
  const tabs = [
    fakeTab('t1', { title: 'Hacker News' }),
    fakeTab('t2', { title: 'Anthropic' }),
  ]
  const focusedTab = tabs[0]
  const win = fakeWindow({ tabs, focusedTab })
  const browser = fakeBrowser({ windows: [win], focusedWindow: win })
  const handler = buildCommandPaletteHandlers(browser)
  let result
  let threw = null
  try {
    result = handler.list()
  } catch (err) {
    threw = err
  }
  ok(
    'handler.list() does not throw with real-shape Tabs (tabList array)',
    !threw,
    threw && threw.message,
  )
  ok('result is an array', Array.isArray(result))
  // The buildCommands output should include tab commands. We check that at
  // least one command's id includes one of our tab ids — defensive against
  // future buildCommands schema tweaks.
  const ids = (result || []).map((c) => c.id || '').join('|')
  ok('tab t1 surfaced in commands', ids.includes('t1'), `commands: ${ids}`)
  ok('tab t2 surfaced in commands', ids.includes('t2'), `commands: ${ids}`)
}

// ───────────────────────────────────────────────────────────────────────────
section('defensive: window with no tabs container')
// ───────────────────────────────────────────────────────────────────────────
{
  const win = { id: 'win-x', workspaceId: 'ws-1', tabs: null, getFocusedTab: () => null }
  const browser = fakeBrowser({ windows: [win], focusedWindow: win })
  const handler = buildCommandPaletteHandlers(browser)
  let threw = null
  let result
  try {
    result = handler.list()
  } catch (err) {
    threw = err
  }
  ok(
    'handler.list() does not throw when win.tabs is null',
    !threw,
    threw && threw.message,
  )
  ok('result still an array', Array.isArray(result))
}

// ───────────────────────────────────────────────────────────────────────────
section('defensive: getFocusedWindow returns null')
// ───────────────────────────────────────────────────────────────────────────
{
  const browser = fakeBrowser({ windows: [], focusedWindow: null })
  const handler = buildCommandPaletteHandlers(browser)
  let threw = null
  let result
  try {
    result = handler.list()
  } catch (err) {
    threw = err
  }
  ok(
    'handler.list() does not throw with no focused window',
    !threw,
    threw && threw.message,
  )
  ok('result still an array', Array.isArray(result))
}

// ───────────────────────────────────────────────────────────────────────────
section('focusedWindowId override resolves explicit window')
// ───────────────────────────────────────────────────────────────────────────
{
  const winA = fakeWindow({ id: 'win-A', tabs: [fakeTab('tA')] })
  const winB = fakeWindow({ id: 'win-B', tabs: [fakeTab('tB')] })
  // focused is winA, but caller asks explicitly for winB.
  const browser = fakeBrowser({ windows: [winA, winB], focusedWindow: winA })
  const handler = buildCommandPaletteHandlers(browser)
  let result
  let threw = null
  try {
    result = handler.list({ focusedWindowId: 'win-B' })
  } catch (err) {
    threw = err
  }
  ok('explicit focusedWindowId did not throw', !threw, threw && threw.message)
  const ids = (result || []).map((c) => c.id || '').join('|')
  ok(
    'used winB tabs (override wins over focused)',
    ids.includes('tB') && !ids.includes('tA'),
    ids,
  )
}

// ───────────────────────────────────────────────────────────────────────────
section('defensive: missing identityManager / workspaceManager')
// ───────────────────────────────────────────────────────────────────────────
{
  const win = fakeWindow({ tabs: [fakeTab('t1')] })
  const browser = {
    windows: [win],
    activeIdentityId: null,
    getFocusedWindow: () => win,
    // identityManager / workspaceManager intentionally absent.
  }
  const handler = buildCommandPaletteHandlers(browser)
  let threw = null
  try {
    handler.list()
  } catch (err) {
    threw = err
  }
  ok(
    'handler.list() does not throw without identity/workspace managers',
    !threw,
    threw && threw.message,
  )
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
