// OZ Browser — Tab Discard Daemon (1.10d).
//
// Qué hace: Apple Silicon perf pass — auto-discard tabs materializadas que
// llevan >N min sin ser seleccionadas. La tab se queda en la sidebar
// (lazy state recreado), su WebContentsView se destruye → libera RAM
// significativa. Re-seleccionar la tab la re-materializa desde pendingUrl.
//
// Doc: docs/modules/tab-discard-daemon.md
// ADR: docs/architecture/0020-perf-pass-apple-silicon.md
//
// Trigger:
//   - settings.performance.autoTabDiscard === true (toggle desde UI Settings)
//   - settings.performance.discardIdleMin (default 30, min 1)
//
// Strategy:
//   - Cada 5 min, escanear todas las tabs materializadas que NO están
//     seleccionadas en su window.
//   - Si lastSelectedAt < now - discardIdleMin*60s → discard.
//   - Pinned tabs NUNCA se discardean (UX: el user las pinneó por algo).
//
// Idempotente: stopDaemon antes de re-startDaemon.

const log = require('./logger')

const SCAN_INTERVAL_MS = 5 * 60 * 1000 // 5 min

class TabDiscardDaemon {
  constructor(opts = {}) {
    this.browser = opts.browser
    this.settingsManager = opts.settingsManager
    this._timer = null
    // Inyectable for tests:
    this._setInterval = opts.setInterval || setInterval
    this._clearInterval = opts.clearInterval || clearInterval
    this._now = opts.now || (() => Date.now())
  }

  /**
   * Run one scan now (also called by the interval). Public for tests.
   * Returns an array of {tabId, identityId, idleMs} for the discarded tabs.
   */
  scan() {
    const settings = this.settingsManager && this.settingsManager.get('performance')
    if (!settings || !settings.autoTabDiscard) return []
    const idleMs = (settings.discardIdleMin || 30) * 60 * 1000
    const cutoff = this._now() - idleMs
    const discarded = []
    for (const win of (this.browser && this.browser.windows) || []) {
      const tabs = win.tabs && win.tabs.tabList
      if (!tabs) continue
      const selectedId = win.tabs.selected ? win.tabs.selected.id : null
      for (const t of tabs) {
        if (!t.materialized) continue
        if (t.id === selectedId) continue // never discard the visible tab
        if (t.pinned) continue
        const lastSel = t.lastSelectedAt || t.createdAt || 0
        if (lastSel >= cutoff) continue
        // Discard
        try {
          if (typeof t.discard === 'function') {
            t.discard()
          } else if (typeof t.hide === 'function' && typeof t.destroy === 'function') {
            // Fallback: full destroy (tabList removal would be needed by caller).
            t.hide()
          }
          discarded.push({
            tabId: t.id,
            identityId: t.identityId,
            idleMs: this._now() - lastSel,
          })
        } catch (err) {
          log.warn('tab-discard-daemon', 'discard failed', {
            tabId: t.id,
            message: err.message,
          })
        }
      }
    }
    if (discarded.length > 0) {
      log.info('tab-discard-daemon', 'tabs discarded', {
        count: discarded.length,
      })
      if (this.browser && typeof this.browser.broadcastToWebUI === 'function') {
        this.browser.broadcastToWebUI('oz:tabs:updated', {
          kind: 'discarded',
          count: discarded.length,
        })
      }
    }
    return discarded
  }

  startDaemon({ intervalMs = SCAN_INTERVAL_MS } = {}) {
    if (this._timer) return false
    this._timer = this._setInterval(() => {
      try {
        this.scan()
      } catch (err) {
        log.error('tab-discard-daemon', 'scan crashed', { message: err.message })
      }
    }, intervalMs)
    log.info('tab-discard-daemon', 'daemon started', { intervalMs })
    return true
  }

  stopDaemon() {
    if (!this._timer) return false
    this._clearInterval(this._timer)
    this._timer = null
    log.info('tab-discard-daemon', 'daemon stopped')
    return true
  }
}

module.exports = { TabDiscardDaemon, SCAN_INTERVAL_MS }
