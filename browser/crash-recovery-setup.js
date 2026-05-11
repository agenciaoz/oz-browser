// OZ Browser — Crash recovery setup (E2-C-2 fase 4).
//
// Extracts the crash-recovery wiring out of main.js to keep the orchestrator
// under the 500-LOC budget (ADR 0005). This module is purely glue: it
// constructs CrashDetector + WindowSnapshot, runs the restore prompt if
// applicable, and starts the snapshot daemon.
//
// API:
//   await setupCrashRecovery(browser)  → { restored: boolean }
//
// Side effects on the browser:
//   - browser.crashDetector  — instantiated + .init() called
//   - browser.windowSnapshot — instantiated + daemon started
//   - browser.windows        — populated via createWindow if restore succeeded
//
// Caller is responsible for:
//   - flushing windowSnapshot + calling crashDetector.markCleanShutdown()
//     in app.before-quit (LATE, after all other managers flush)
//   - calling browser.createInitialWindow() if !restored

const { app } = require('electron')
const log = require('./logger')
const { CrashDetector } = require('./crash-detector')
const { WindowSnapshot } = require('./window-snapshot')
const { promptRestore, restoreFromSnapshot } = require('./session-restore')

async function setupCrashRecovery(browser) {
  const userDataDir = app.getPath('userData')
  const ozVersion = app.getVersion()

  // 1. CrashDetector — reads + writes the lockfile, classifies crash state.
  browser.crashDetector = new CrashDetector({ userDataDir, ozVersion })
  const detection = browser.crashDetector.init()
  log.info('browser', 'CrashDetector init', {
    wasCrashed: detection.wasCrashed,
    multiInstance: detection.multiInstance,
  })

  // 2. WindowSnapshot — read what was open last time (regardless of crash).
  browser.windowSnapshot = new WindowSnapshot({ userDataDir, browser })
  const lastSnapshot = browser.windowSnapshot.read()
  log.info('browser', 'WindowSnapshot read', {
    found: !!lastSnapshot,
    windowCount: lastSnapshot ? lastSnapshot.windows.length : 0,
  })

  // 3. If we crashed AND there's a snapshot to restore, prompt the user.
  let restored = false
  if (
    detection.wasCrashed &&
    lastSnapshot &&
    Array.isArray(lastSnapshot.windows) &&
    lastSnapshot.windows.length > 0
  ) {
    try {
      const choice = await promptRestore(lastSnapshot)
      if (choice === 'restore') {
        const created = restoreFromSnapshot(browser, lastSnapshot)
        restored = created.length > 0
        log.info('browser', 'session restored from snapshot', {
          requested: lastSnapshot.windows.length,
          created: created.length,
        })
      } else {
        // User chose Start Fresh — clear the snapshot so a hypothetical
        // immediate-second-crash doesn't keep restoring the same old state.
        browser.windowSnapshot.clear()
        log.info('browser', 'user chose Start Fresh — snapshot cleared')
      }
    } catch (err) {
      log.error('browser', 'crash recovery prompt/restore failed', {
        message: err.message,
        stack: err.stack,
      })
    }
  }

  return { restored }
}

module.exports = { setupCrashRecovery }
