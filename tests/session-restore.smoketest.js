// OZ Browser — session-restore smoke test (E2-C-2 fase 3).
//
// Cómo correr:
//   cd oz-browser
//   node tests/session-restore.smoketest.js
//
// Cubre:
//   - promptRestore returns 'restore' on response 0
//   - promptRestore returns 'discard' on response 1
//   - promptRestore returns 'discard' on dialog crash
//   - promptRestore copy uses singular/plural correctly
//   - restoreFromSnapshot creates one window per entry
//   - restoreFromSnapshot dedupes duplicate workspaceIds (lock 1-1)
//   - restoreFromSnapshot falls back to Default for missing workspaceId
//   - restoreFromSnapshot applies bounds → window.options
//   - restoreFromSnapshot applies isMaximized + isFullScreen post-create
//   - restoreFromSnapshot creates fallback window if all entries fail
//   - restoreFromSnapshot survives createWindow throwing (best-effort)

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-srest-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
  getVersion: () => '0.1.0-test',
}

const fakeElectron = { app: fakeApp, dialog: null }

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

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

console.log('OZ Browser — session-restore smoke test')

delete require.cache[require.resolve('../browser/session-restore.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const { promptRestore, restoreFromSnapshot } = require('../browser/session-restore.js')

// Helper: build a fake browser with a controllable createWindow.
function fakeBrowser({
  workspaces = ['general', 'marketing', 'dev'],
  defaultWorkspaceId = 'general',
  throwOnCreate = false,
} = {}) {
  const created = []
  const browser = {
    workspaceManager: {
      get: (id) => (workspaces.includes(id) ? { id } : null),
      getDefault: () => ({ id: defaultWorkspaceId }),
    },
    createWindow: (opts) => {
      if (throwOnCreate) throw new Error('boom')
      const w = {
        opts,
        workspaceId: opts.workspaceId,
        window: {
          maximize: () => {
            w._maximized = true
          },
          setFullScreen: (v) => {
            w._fullscreen = v
          },
        },
      }
      created.push(w)
      return w
    },
    _created: created,
  }
  return browser
}

// ---- 1. exports ------------------------------------------------------------
section('exports')
ok('promptRestore is async fn', typeof promptRestore === 'function')
ok('restoreFromSnapshot is fn', typeof restoreFromSnapshot === 'function')
;(async () => {
  // ---- 2. promptRestore → 'restore' on response 0 -------------------------
  section('promptRestore → restore')
  {
    const fakeDialog = {
      showMessageBox: async () => ({ response: 0 }),
    }
    const choice = await promptRestore({ windows: [{}, {}, {}] }, { dialog: fakeDialog })
    ok('choice === restore', choice === 'restore')
  }

  // ---- 3. promptRestore → 'discard' on response 1 -------------------------
  section('promptRestore → discard')
  {
    const fakeDialog = {
      showMessageBox: async () => ({ response: 1 }),
    }
    const choice = await promptRestore({ windows: [{}] }, { dialog: fakeDialog })
    ok('choice === discard', choice === 'discard')
  }

  // ---- 4. promptRestore → 'discard' on dialog throw -----------------------
  section('promptRestore → discard on crash')
  {
    const fakeDialog = {
      showMessageBox: async () => {
        throw new Error('Electron broken')
      },
    }
    const choice = await promptRestore({ windows: [{}] }, { dialog: fakeDialog })
    ok('choice === discard on dialog crash', choice === 'discard')
  }

  // ---- 5. promptRestore → 'discard' when dialog missing -------------------
  section('promptRestore → discard when no dialog provided')
  {
    // No dialog injected; module's lazy require will hit our fakeElectron.dialog
    // (set to null below to simulate completely missing dialog).
    fakeElectron.dialog = null
    const choice = await promptRestore({ windows: [{}] })
    ok('choice === discard with no dialog', choice === 'discard')
  }

  // ---- 6. promptRestore copy: singular vs plural --------------------------
  section('promptRestore copy singular/plural')
  {
    let detailSeen = null
    const fakeDialog = {
      showMessageBox: async (opts) => {
        detailSeen = opts.detail
        return { response: 1 }
      },
    }
    await promptRestore({ windows: [{}] }, { dialog: fakeDialog })
    ok(
      'singular wording for 1 window',
      typeof detailSeen === 'string' && detailSeen.includes('previous window and tabs'),
    )
    detailSeen = null
    await promptRestore({ windows: [{}, {}, {}] }, { dialog: fakeDialog })
    ok(
      'plural wording for 3 windows',
      typeof detailSeen === 'string' && detailSeen.includes('3 previous windows'),
    )
  }

  // ---- 7. restoreFromSnapshot creates one window per entry ----------------
  section('restoreFromSnapshot creates N windows')
  {
    const browser = fakeBrowser()
    const snap = {
      windows: [
        { workspaceId: 'general', bounds: { x: 0, y: 0, width: 1280, height: 720 } },
        { workspaceId: 'marketing', bounds: { x: 100, y: 100, width: 800, height: 600 } },
      ],
    }
    const created = restoreFromSnapshot(browser, snap)
    ok('created length === 2', created.length === 2)
    ok('first workspaceId === general', created[0].opts.workspaceId === 'general')
    ok('second workspaceId === marketing', created[1].opts.workspaceId === 'marketing')
    ok('first bounds applied', created[0].opts.window.width === 1280)
    ok('second bounds applied', created[1].opts.window.height === 600)
  }

  // ---- 8. dedupe duplicate workspaceIds (lock 1-1) ------------------------
  section('restoreFromSnapshot dedupes lock 1-1')
  {
    const browser = fakeBrowser()
    const snap = {
      windows: [
        { workspaceId: 'general' },
        { workspaceId: 'general' }, // dupe — should be skipped
        { workspaceId: 'marketing' },
      ],
    }
    const created = restoreFromSnapshot(browser, snap)
    ok('created length === 2 (dupe skipped)', created.length === 2)
    const ids = created.map((w) => w.opts.workspaceId)
    ok('contains general once', ids.filter((x) => x === 'general').length === 1)
    ok('contains marketing once', ids.filter((x) => x === 'marketing').length === 1)
  }

  // ---- 9. fallback to Default for unknown workspace -----------------------
  section('restoreFromSnapshot falls back to Default for missing WS')
  {
    const browser = fakeBrowser({ workspaces: ['general'] })
    const snap = {
      windows: [{ workspaceId: 'gone-workspace' }],
    }
    const created = restoreFromSnapshot(browser, snap)
    ok('created length === 1', created.length === 1)
    ok('fallback to Default (general)', created[0].opts.workspaceId === 'general')
  }

  // ---- 10. apply isMaximized + isFullScreen post-create -------------------
  section('restoreFromSnapshot applies maximize/fullscreen')
  {
    const browser = fakeBrowser()
    const snap = {
      windows: [
        { workspaceId: 'general', isMaximized: true },
        { workspaceId: 'marketing', isFullScreen: true },
      ],
    }
    const created = restoreFromSnapshot(browser, snap)
    ok('first maximize called', created[0]._maximized === true)
    ok('second fullscreen called', created[1]._fullscreen === true)
  }

  // ---- 11. fallback createWindow when all entries fail --------------------
  section('restoreFromSnapshot fallback when nothing created')
  {
    let calls = 0
    const browser = {
      workspaceManager: {
        get: () => null, // every workspace lookup fails
        getDefault: () => ({ id: 'general' }),
      },
      createWindow: (opts) => {
        calls++
        // First call: fail (the snapshot loop). Second call: succeed (fallback).
        if (calls === 1) throw new Error('first fail')
        return {
          opts,
          workspaceId: opts.workspaceId,
          window: { maximize: () => {}, setFullScreen: () => {} },
        }
      },
    }
    const snap = { windows: [{ workspaceId: 'gone' }] }
    const created = restoreFromSnapshot(browser, snap)
    ok('fallback ran (calls === 2)', calls === 2)
    ok('created length === 1 (fallback succeeded)', created.length === 1)
    ok('fallback used Default', created[0].opts.workspaceId === 'general')
  }

  // ---- 12. invalid args: defensive --------------------------------------
  section('restoreFromSnapshot defensive')
  {
    const r1 = restoreFromSnapshot(null, { windows: [{}] })
    ok('null browser → empty array', Array.isArray(r1) && r1.length === 0)
    const r2 = restoreFromSnapshot({ createWindow: () => ({}) }, null)
    ok('null snapshot → empty array', Array.isArray(r2) && r2.length === 0)
    const r3 = restoreFromSnapshot(
      { createWindow: () => ({}) },
      { windows: 'not an array' },
    )
    ok('non-array windows → empty', Array.isArray(r3) && r3.length === 0)
  }

  // ---- 13. createWindow throwing inside loop is contained ----------------
  section('restoreFromSnapshot survives createWindow throws (partial)')
  {
    let calls = 0
    const browser = {
      workspaceManager: {
        get: (id) => ({ id }),
        getDefault: () => ({ id: 'general' }),
      },
      createWindow: (opts) => {
        calls++
        if (opts.workspaceId === 'crash-me') throw new Error('boom')
        return {
          opts,
          workspaceId: opts.workspaceId,
          window: { maximize: () => {}, setFullScreen: () => {} },
        }
      },
    }
    const snap = {
      windows: [{ workspaceId: 'a' }, { workspaceId: 'crash-me' }, { workspaceId: 'b' }],
    }
    const created = restoreFromSnapshot(browser, snap)
    ok('all 3 attempts made', calls === 3)
    ok('2 windows survived', created.length === 2)
    const ids = created.map((w) => w.workspaceId)
    ok('a + b survived', ids.includes('a') && ids.includes('b'))
  }

  // ---- summary ---------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  Module._load = originalLoad
  process.exit(0)
})()
