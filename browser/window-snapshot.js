// OZ Browser — Window snapshot for crash recovery (E2-C-2 fase 2).
//
// Qué hace: persiste la lista de ventanas abiertas (cuántas, qué workspace
// tiene cada una, bounds + display state) en `userData/windows.json` para que
// session-restore.js pueda recrearlas tras un crash detectado por
// crash-detector.js.
//
// Doc: docs/modules/window-snapshot.md
// ADR: docs/architecture/0024-crash-recovery.md
//
// Por qué necesitamos windows.json y no usamos workspaces.json:
//   - workspaces.json (1.4a) persiste tabs por workspace.
//   - PERO no sabemos qué windows estaban abiertas ni qué workspace tenía
//     cada una. Si el user tenía 3 ventanas (ej: cliente A en general,
//     cliente B en marketing, scratchpad en dev), workspaces.json solo
//     guarda el contenido de cada workspace pero no la topología de ventanas.
//   - windows.json captura esa topología.
//
// Estrategia de persistencia (intencionalmente simple):
//   - Daemon con setInterval cada N segundos (default 2s) llama capture() y
//     escribe a disco SI el snapshot cambió.
//   - flush() sync para before-quit.
//   - No hookea events de Electron — el polling cubre todos los casos
//     (open window, close window, switch workspace, move/resize) sin
//     acoplarse a la API de cada uno.
//   - Trade-off: hasta N segundos de pérdida si crashea entre ticks. Pero
//     para el caso de crash-recovery eso es aceptable: el WS contenido de
//     tabs ya está persistido, y "qué windows estaban abiertas" no cambia
//     tan rápido como para perder valor con 2s de delay.
//
// Payload schema v1:
//   {
//     version: 1,
//     capturedAt: ISO,
//     windows: [
//       {
//         workspaceId: 'general',
//         bounds: { x, y, width, height },
//         isMaximized: false,
//         isFullScreen: false,
//       }
//     ]
//   }

const fs = require('fs')
const path = require('path')
const log = require('./logger')

const SNAPSHOT_FILE = 'windows.json'
const DEFAULT_INTERVAL_MS = 2000
const SCHEMA_VERSION = 1

class WindowSnapshot {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir
   * @param {object} opts.browser — Browser instance (read-only access to .windows)
   * @param {number} [opts.intervalMs=2000]
   * @param {()=>number} [opts.clock=Date.now]
   */
  constructor({ userDataDir, browser, intervalMs, clock } = {}) {
    if (!userDataDir) throw new Error('WindowSnapshot: userDataDir required')
    if (!browser) throw new Error('WindowSnapshot: browser required')
    this.userDataDir = userDataDir
    this.snapshotPath = path.join(userDataDir, SNAPSHOT_FILE)
    this.browser = browser
    this.intervalMs = intervalMs || DEFAULT_INTERVAL_MS
    this.clock = clock || (() => Date.now())
    this._timer = null
    this._lastWritten = null // serialized payload to dedupe writes
  }

  /**
   * Build a snapshot payload from the current browser.windows state.
   * Skips zombies (window.window destroyed).
   */
  capture() {
    const windows = []
    for (const w of this.browser.windows || []) {
      if (!w || !w.window) continue
      // Skip destroyed BrowserWindows (HX2 zombies before splice).
      try {
        if (w.window.isDestroyed && w.window.isDestroyed()) continue
      } catch (_e) {
        continue
      }
      const entry = { workspaceId: w.workspaceId || null }
      try {
        if (typeof w.window.getBounds === 'function') {
          entry.bounds = w.window.getBounds()
        }
      } catch (_e) {
        // best effort
      }
      try {
        if (typeof w.window.isMaximized === 'function') {
          entry.isMaximized = !!w.window.isMaximized()
        }
      } catch (_e) {
        entry.isMaximized = false
      }
      try {
        if (typeof w.window.isFullScreen === 'function') {
          entry.isFullScreen = !!w.window.isFullScreen()
        }
      } catch (_e) {
        entry.isFullScreen = false
      }
      windows.push(entry)
    }
    return {
      version: SCHEMA_VERSION,
      capturedAt: new Date(this.clock()).toISOString(),
      windows,
    }
  }

  /**
   * Read the persisted snapshot from disk. Returns null on missing,
   * parse error, or schema mismatch (future-incompatible).
   */
  read() {
    let raw
    try {
      raw = fs.readFileSync(this.snapshotPath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('window-snapshot', 'read failed', { message: err.message })
      }
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      log.warn('window-snapshot', 'snapshot JSON corrupt — ignoring', {
        message: err.message,
      })
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.version !== SCHEMA_VERSION) {
      log.info('window-snapshot', 'snapshot schema mismatch — ignoring', {
        on_disk: parsed.version,
        expected: SCHEMA_VERSION,
      })
      return null
    }
    if (!Array.isArray(parsed.windows)) return null
    return parsed
  }

  /**
   * Capture + write to disk if changed. Returns the snapshot written, or
   * null if nothing changed (dedupe by serialized JSON minus capturedAt).
   */
  flush() {
    let snap
    try {
      snap = this.capture()
    } catch (err) {
      log.warn('window-snapshot', 'capture failed', { message: err.message })
      return null
    }
    // Compare excluding capturedAt so timestamp churn doesn't trigger writes.
    const dedup = JSON.stringify({
      version: snap.version,
      windows: snap.windows,
    })
    if (dedup === this._lastWritten) return null
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true })
      fs.writeFileSync(this.snapshotPath, JSON.stringify(snap, null, 2))
      this._lastWritten = dedup
      log.debug('window-snapshot', 'snapshot written', {
        windowCount: snap.windows.length,
      })
      return snap
    } catch (err) {
      log.error('window-snapshot', 'write failed', {
        message: err.message,
        path: this.snapshotPath,
      })
      return null
    }
  }

  /**
   * Start the polling daemon. Idempotent — calling twice keeps a single
   * timer.
   */
  startDaemon() {
    if (this._timer) return
    this._timer = setInterval(() => {
      try {
        this.flush()
      } catch (err) {
        log.error('window-snapshot', 'daemon tick crashed', {
          message: err.message,
        })
      }
    }, this.intervalMs)
    log.info('window-snapshot', 'daemon started', { intervalMs: this.intervalMs })
  }

  /** Stop the polling daemon. Idempotent. */
  stopDaemon() {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
    log.info('window-snapshot', 'daemon stopped')
  }

  /**
   * Delete the snapshot from disk. Used after a successful restore (or after
   * the user dismisses the restore prompt) so a future clean session doesn't
   * keep restoring the old state.
   */
  clear() {
    try {
      fs.unlinkSync(this.snapshotPath)
      this._lastWritten = null
      log.info('window-snapshot', 'snapshot cleared')
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return true
      log.warn('window-snapshot', 'clear failed', { message: err.message })
      return false
    }
  }
}

module.exports = { WindowSnapshot, SNAPSHOT_FILE, SCHEMA_VERSION }
