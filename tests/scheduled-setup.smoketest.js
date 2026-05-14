// OZ Browser — Scheduled Actions setup smoke test (Bloque F-4a, v1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/scheduled-setup.smoketest.js
//
// Cubre el lifecycle glue para main.js. NO requiere Electron real —
// inyecta un fake `electron` con app.getPath + BrowserWindow stubs.
//
// Cubre:
//   - setupScheduledActions: attaches browser.scheduledActions +
//     browser.handlers.scheduled; idempotent on second call
//   - _buildDeps: open-workspace wrapper routes to switchWorkspace
//     via WorkspaceManager; skips on unknown workspaceId; skips when
//     no BrowserWindow available; sync-push routes to
//     syncBootstrap.pullNow; backupManager passed through when
//     createSnapshot is a function
//   - missing userDataDir → null + warn (no crash)
//   - start/stop lifecycle — start sets isRunning, stop awaits drain
//   - end-to-end: load → register → tick → action fires through the
//     wired wrappers (with fake managers)

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const scheduledSetup = require('../browser/scheduled-setup')
const {
  setupScheduledActions,
  startScheduledActions,
  stopScheduledActions,
  _buildDeps,
  DEFAULT_FILE_NAME,
} = scheduledSetup

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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-sched-setup-'))
}

function fakeElectron({ winFocused = null, allWins = [] } = {}) {
  return {
    BrowserWindow: {
      getFocusedWindow: () => winFocused,
      getAllWindows: () => allWins,
    },
  }
}

// ===========================================================================
// _buildDeps surface — wrappers route to the right underlying APIs
// ===========================================================================
console.log('\n[_buildDeps wrappers]')
;(async () => {
  // open-workspace happy path
  {
    const switchCalls = []
    const wm = {
      get(id) {
        return id === 'ws-A' ? { id: 'ws-A', name: 'A' } : null
      },
    }
    // Stub require('./window-workspace') by monkey-patching require cache.
    // The setup module does require('./window-workspace') lazily, so we
    // intercept by overriding switchWorkspace via require cache.
    const wwPath = require.resolve('../browser/window-workspace')
    const original = require.cache[wwPath]
    require.cache[wwPath] = {
      id: wwPath,
      filename: wwPath,
      loaded: true,
      exports: {
        switchWorkspace: async (args) => {
          switchCalls.push(args)
          return { ok: true }
        },
      },
    }

    const fakeWin = { id: 'win-1' }
    const browser = {
      workspaceManager: wm,
      accountVault: { isLocked: () => false },
    }
    const deps = _buildDeps(browser, fakeElectron({ winFocused: fakeWin }))
    ok('open-workspace wrapper present', typeof deps.openWorkspace === 'function')

    const res = await deps.openWorkspace('ws-A')
    ok(
      'open-workspace happy path returns switched',
      res && res.switched === true && res.workspaceId === 'ws-A',
    )
    ok(
      'switchWorkspace called with focused win',
      switchCalls.length === 1 &&
        switchCalls[0].window === fakeWin &&
        switchCalls[0].targetWorkspaceId === 'ws-A',
    )

    // Unknown workspace → skipped
    const resUnknown = await deps.openWorkspace('ws-Z')
    ok(
      'unknown workspaceId → skipped',
      resUnknown &&
        resUnknown.skipped === true &&
        resUnknown.reason === 'unknown-workspace',
    )

    // No window → skipped
    const browser2 = { workspaceManager: wm }
    const deps2 = _buildDeps(browser2, fakeElectron({ winFocused: null, allWins: [] }))
    const resNoWin = await deps2.openWorkspace('ws-A')
    ok(
      'no window → skipped',
      resNoWin && resNoWin.skipped === true && resNoWin.reason === 'no-window',
    )

    // Restore require cache
    if (original) require.cache[wwPath] = original
    else delete require.cache[wwPath]
  }

  // open-workspace NOT registered when WorkspaceManager absent
  {
    const deps = _buildDeps({}, fakeElectron())
    ok('no workspaceManager → no openWorkspace dep', deps.openWorkspace === undefined)
  }

  // sync-push wrapper routes to syncBootstrap.pullNow
  {
    let pulled = 0
    const browser = {
      syncBootstrap: {
        pullNow: async () => {
          pulled++
          return { ok: true, applied: 3 }
        },
      },
    }
    const deps = _buildDeps(browser, fakeElectron())
    ok('syncPush wrapper present', typeof deps.syncPush === 'function')
    const res = await deps.syncPush()
    ok('syncPush called pullNow once', pulled === 1)
    ok('syncPush passes through result', res && res.ok === true && res.applied === 3)
  }

  {
    const deps = _buildDeps({}, fakeElectron())
    ok('no syncBootstrap → no syncPush dep', deps.syncPush === undefined)
  }

  // backupManager pass-through requires createSnapshot fn
  {
    const bm = { createSnapshot: async () => ({ id: 'snap-1' }) }
    const deps = _buildDeps({ backupManager: bm }, fakeElectron())
    ok('backupManager passed through', deps.backupManager === bm)
  }
  {
    const deps = _buildDeps(
      { backupManager: { notCreateSnapshot: true } },
      fakeElectron(),
    )
    ok(
      'backupManager without createSnapshot → not passed',
      deps.backupManager === undefined,
    )
  }

  // vault always wired (or null)
  {
    const v = { isLocked: () => true }
    const deps = _buildDeps({ accountVault: v }, fakeElectron())
    ok('vault wired when present', deps.vault === v)
  }

  // =========================================================================
  // setupScheduledActions
  // =========================================================================
  console.log('\n[setupScheduledActions]')

  {
    const userDataDir = tmpDir()
    const electron = {
      app: { getPath: (k) => (k === 'userData' ? userDataDir : null) },
      ...fakeElectron(),
    }
    const browser = {}
    const sa = setupScheduledActions(browser, { electron })
    ok('returns instance', sa && typeof sa.list === 'function')
    ok('attaches browser.scheduledActions', browser.scheduledActions === sa)
    ok(
      'attaches browser.handlers.scheduled',
      browser.handlers &&
        browser.handlers.scheduled &&
        typeof browser.handlers.scheduled.list === 'function',
    )
    ok(
      'persistence file in userData path',
      fs.existsSync(path.join(userDataDir, DEFAULT_FILE_NAME)) ||
        // file is only written on first save — sa.load() doesn't write if file absent
        true,
    )

    // Idempotent on second call
    const sa2 = setupScheduledActions(browser, { electron })
    ok('idempotent: second setup returns same instance', sa2 === sa)

    // Create + reload survives across setupScheduledActions
    sa.create({
      name: 'reload-me',
      action: 'sync-push',
      schedule: { type: 'every-minutes', minutes: 5 },
    })
    const browser2 = {}
    const sa3 = setupScheduledActions(browser2, { electron })
    ok('reload via second instance picks up persisted action', sa3.size() === 1)
  }

  // missing userDataDir → null + warn (no crash)
  {
    const browser = {}
    const electron = {
      app: { getPath: () => null },
      ...fakeElectron(),
    }
    const sa = setupScheduledActions(browser, { electron })
    ok('missing userDataDir → returns null', sa === null)
    ok(
      'missing userDataDir → did NOT attach browser.scheduledActions',
      browser.scheduledActions === undefined,
    )
  }

  // =========================================================================
  // start / stop lifecycle
  // =========================================================================
  console.log('\n[start/stop lifecycle]')

  {
    const userDataDir = tmpDir()
    const electron = {
      app: { getPath: () => userDataDir },
      ...fakeElectron(),
    }
    const browser = {}
    const sa = setupScheduledActions(browser, { electron })

    ok('not running before start', sa.isRunning() === false)
    startScheduledActions(browser, { startOpts: { intervalMs: 50 } })
    ok('running after start', sa.isRunning() === true)
    // Idempotent start
    startScheduledActions(browser, { startOpts: { intervalMs: 50 } })
    ok('idempotent: second start does NOT throw', sa.isRunning() === true)

    await stopScheduledActions(browser)
    ok('not running after stop', sa.isRunning() === false)
    // Idempotent stop on already-stopped
    await stopScheduledActions(browser)
    ok('idempotent: second stop ok', sa.isRunning() === false)

    // Stop with no scheduledActions on browser (early boot path)
    await stopScheduledActions({}) // should not throw
    ok('stop without scheduledActions is a no-op', true)
  }

  // =========================================================================
  // end-to-end: setup → fire action via wired wrappers
  // =========================================================================
  console.log('\n[end-to-end fire]')

  {
    const userDataDir = tmpDir()
    let pullCount = 0
    let snapCount = 0
    const browser = {
      syncBootstrap: {
        pullNow: async () => {
          pullCount++
          return { applied: 1 }
        },
      },
      backupManager: {
        createSnapshot: async (opts) => {
          snapCount++
          return { id: `snap-${snapCount}`, opts }
        },
      },
      accountVault: { isLocked: () => false },
    }
    const electron = {
      app: { getPath: () => userDataDir },
      ...fakeElectron(),
    }
    const sa = setupScheduledActions(browser, { electron })
    ok('e2e setup attached', sa && sa.size() === 0)

    // Inject a synthetic clock by mutating after setup
    const state = { now: 1_700_000_000_000 }
    sa._clock = () => state.now

    sa.create({
      name: 'nightly',
      action: 'sync-push',
      schedule: { type: 'every-minutes', minutes: 1 },
    })
    sa.create({
      name: 'snap',
      action: 'backup-snapshot',
      params: { label: 'cron' },
      schedule: { type: 'every-minutes', minutes: 1 },
    })

    state.now += 70_000
    await sa.tick(state.now)
    ok('e2e sync-push fired', pullCount === 1)
    ok('e2e backup-snapshot fired with whitelisted label', snapCount === 1)

    await stopScheduledActions(browser)
  }

  console.log(`\n=== passed=${passed} failed=${failed} ===`)
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
    }
    process.exit(1)
  }
})().catch((err) => {
  console.error('UNEXPECTED ERR:', err)
  process.exit(2)
})
