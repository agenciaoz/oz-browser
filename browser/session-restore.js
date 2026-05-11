// OZ Browser — Session restore (E2-C-2 fase 3).
//
// Qué hace: muestra el dialog "Restore previous session?" cuando crash-detector
// detectó un crash + windows.json existe, y recrea las ventanas con su
// workspaceId + bounds.
//
// Doc: docs/modules/session-restore.md
// ADR: docs/architecture/0024-crash-recovery.md
//
// API:
//   const { promptRestore, restoreFromSnapshot } = require('./session-restore')
//
//   const choice = await promptRestore(snapshot, { dialog })
//     → 'restore' | 'discard'
//
//   const created = restoreFromSnapshot(browser, snapshot)
//     → array de TabbedBrowserWindow recreadas
//
// Flow esperado en main.js:
//   1. CrashDetector.init() → wasCrashed.
//   2. WindowSnapshot.read() → snapshot | null.
//   3. Si wasCrashed && snapshot.windows.length > 0:
//      - choice = await promptRestore(snapshot)
//      - if choice === 'restore' → restoreFromSnapshot + skip createInitialWindow
//      - else → windowSnapshot.clear() + createInitialWindow normal
//   4. Si !wasCrashed o sin snapshot → createInitialWindow normal.
//
// Lock 1-1 enforcement (ADR 0015):
//   - 1 ventana = 1 workspace, 1 workspace = max 1 ventana.
//   - Si el snapshot persistido tiene duplicados (no debería, pero defensive),
//     deduplicamos por workspaceId quedándonos con el primer entry.
//   - Si workspaceId no existe (workspace borrado entre crash y restore),
//     fallback al Default workspace.

const log = require('./logger')

let _dialog = null
function getDialog() {
  if (_dialog) return _dialog
  // Lazy require for tests that inject their own dialog.
  _dialog = require('electron').dialog
  return _dialog
}

/**
 * Prompt the user with a native dialog. Returns 'restore' or 'discard'.
 *
 * @param {object} snapshot — the persisted snapshot (used for window count copy).
 * @param {object} [opts]
 * @param {object} [opts.dialog] — for tests; defaults to electron.dialog.
 */
async function promptRestore(snapshot, opts = {}) {
  const dlg = opts.dialog || getDialog()
  if (!dlg || typeof dlg.showMessageBox !== 'function') {
    log.warn('session-restore', 'no dialog available — defaulting to discard')
    return 'discard'
  }
  const windowCount = snapshot && snapshot.windows ? snapshot.windows.length : 0
  let detail
  if (windowCount === 1) {
    detail = 'Would you like to restore your previous window and tabs?'
  } else {
    detail = `Would you like to restore your ${windowCount} previous windows and their tabs?`
  }
  let result
  try {
    result = await dlg.showMessageBox({
      type: 'question',
      buttons: ['Restore', 'Start Fresh'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restore Previous Session?',
      message: 'OZ Browser ended unexpectedly last time.',
      detail,
      noLink: true,
    })
  } catch (err) {
    log.error('session-restore', 'dialog crashed — defaulting to discard', {
      message: err.message,
    })
    return 'discard'
  }
  const choice = result && result.response === 0 ? 'restore' : 'discard'
  log.info('session-restore', 'user choice', { choice, windowCount })
  return choice
}

/**
 * Recreate windows from a snapshot. Returns the array of TabbedBrowserWindow
 * instances created (may be shorter than snapshot.windows if some entries
 * were rejected by the lock or createWindow threw).
 */
function restoreFromSnapshot(browser, snapshot) {
  if (!browser || typeof browser.createWindow !== 'function') {
    log.error('session-restore', 'browser.createWindow missing — abort')
    return []
  }
  if (!snapshot || !Array.isArray(snapshot.windows)) {
    log.warn('session-restore', 'invalid snapshot — abort')
    return []
  }

  const wm = browser.workspaceManager
  const defaultWorkspaceId = wm && wm.getDefault ? wm.getDefault().id : null
  const created = []
  const usedWorkspaceIds = new Set()

  for (const entry of snapshot.windows) {
    try {
      let workspaceId = entry.workspaceId

      // Validate workspace still exists; fallback to Default if it was
      // deleted while OZ was down.
      if (workspaceId && wm && wm.get && !wm.get(workspaceId)) {
        log.warn('session-restore', 'workspace gone — falling back to Default', {
          missingWorkspaceId: workspaceId,
          defaultWorkspaceId,
        })
        workspaceId = defaultWorkspaceId
      }
      if (!workspaceId) workspaceId = defaultWorkspaceId

      // Lock 1-1: dedupe within the restore loop. If we already restored this
      // workspace into another window, skip (defensive — snapshot shouldn't
      // contain dupes, but be safe).
      if (workspaceId && usedWorkspaceIds.has(workspaceId)) {
        log.warn('session-restore', 'workspace already restored — skip', {
          workspaceId,
        })
        continue
      }

      const opts = { workspaceId }
      if (entry.bounds && typeof entry.bounds === 'object') {
        opts.window = {
          x: entry.bounds.x,
          y: entry.bounds.y,
          width: entry.bounds.width,
          height: entry.bounds.height,
        }
      }

      const win = browser.createWindow(opts)
      if (workspaceId) usedWorkspaceIds.add(workspaceId)

      // Apply post-create state mutations (maximize / fullscreen).
      try {
        if (
          entry.isMaximized &&
          win.window &&
          typeof win.window.maximize === 'function'
        ) {
          win.window.maximize()
        }
      } catch (err) {
        log.warn('session-restore', 'maximize failed', { message: err.message })
      }
      try {
        if (
          entry.isFullScreen &&
          win.window &&
          typeof win.window.setFullScreen === 'function'
        ) {
          win.window.setFullScreen(true)
        }
      } catch (err) {
        log.warn('session-restore', 'setFullScreen failed', { message: err.message })
      }

      created.push(win)
    } catch (err) {
      log.error('session-restore', 'createWindow failed for entry', {
        workspaceId: entry.workspaceId,
        message: err.message,
        stack: err.stack,
      })
      // Continue with the rest — partial restore beats no restore.
    }
  }

  // Always ensure at least one window exists, even if all entries failed.
  if (created.length === 0) {
    log.warn('session-restore', 'no windows created — falling back to Default')
    try {
      const fallback = browser.createWindow({ workspaceId: defaultWorkspaceId })
      created.push(fallback)
    } catch (err) {
      log.error('session-restore', 'fallback createWindow failed', {
        message: err.message,
      })
    }
  }

  log.info('session-restore', 'restore complete', {
    requested: snapshot.windows.length,
    created: created.length,
  })
  return created
}

module.exports = { promptRestore, restoreFromSnapshot }
