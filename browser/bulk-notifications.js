// OZ Browser — Bulk Run native OS notifications (v2 Etapa 4.2).
//
// Suscribe a `bulkRunner.on('completed')` y dispara una Electron Notification
// nativa por cada run que termine en estado terminal. Click en la notif
// abre el Bulk History dashboard directo al detail view de ese run via IPC
// `oz:bulk-history:open-at-run`.
//
// Gate: `settings.notifications.showOSAlert` — mismo flag que usa
// anti-logout.js. NO se introduce key nueva (Jose mantiene una sola palanca
// de "molestame con notifs nativas").
//
// Test-friendly: deps inyectables (bulkRunner, settingsManager, browser,
// notificationFactory, logger). Default factory hace lazy require Electron.
//
// ADR: docs/architecture/0033-bulk-notifications.md
// Doc: docs/modules/bulk-notifications.md

'use strict'

function _defaultNotification() {
  try {
    const electron = require('electron')
    return electron.Notification
  } catch (_e) {
    return null
  }
}

function _silentLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop }
}

class BulkNotifications {
  /**
   * @param {object} opts
   * @param {EventEmitter} opts.bulkRunner — emits 'completed' {runId, meta}
   * @param {object} opts.browser — main process app handle (for IPC broadcast)
   * @param {object} [opts.settingsManager] — has .get('notifications')
   * @param {function} [opts.notificationFactory] — returns electron.Notification
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    if (!opts.bulkRunner) throw new Error('BulkNotifications: bulkRunner required')
    if (!opts.browser) throw new Error('BulkNotifications: browser required')
    this.bulkRunner = opts.bulkRunner
    this.browser = opts.browser
    this.settingsManager = opts.settingsManager || null
    this.notificationFactory = opts.notificationFactory || _defaultNotification
    this.log = opts.logger || _silentLogger()
    this._installed = false
    this._listener = null
  }

  install() {
    if (this._installed) return
    this._listener = ({ runId, meta }) => this._handleCompleted(runId, meta)
    this.bulkRunner.on('completed', this._listener)
    this._installed = true
    this.log.info('bulk-notifications', 'installed')
  }

  uninstall() {
    if (!this._installed) return
    if (this._listener) this.bulkRunner.off('completed', this._listener)
    this._listener = null
    this._installed = false
  }

  /** Returns false if user has opted out of OS notifs (or unset). */
  _enabled() {
    if (!this.settingsManager) return true
    try {
      const sect = this.settingsManager.get('notifications')
      if (sect && typeof sect === 'object' && sect.showOSAlert === false) {
        return false
      }
    } catch (_e) {
      // best-effort — default to true on read failure
    }
    return true
  }

  _handleCompleted(runId, meta) {
    if (!this._enabled()) return
    if (!meta || typeof meta !== 'object') return
    const { title, body } = this.formatMessage(meta)
    this._show(title, body, runId)
  }

  /**
   * Pure helper — formats notification title + body from a run meta.
   * Exported so the smoketest can verify it without an Electron context.
   *
   *   formatMessage({actionLabel:'IG Like', stats:{done:3,failed:1,skipped:0,cancelled:0}})
   *   → {
   *       title: 'Bulk run finished — IG Like',
   *       body:  '3 done · 1 failed',
   *     }
   *
   * Body omits zero buckets to keep the toast scannable. If everything is
   * zero (rare — empty run somehow), shows "no items".
   */
  formatMessage(meta) {
    const label = meta.actionLabel || meta.actionId || 'bulk run'
    const status = meta.status || 'completed'
    const titlePrefix =
      status === 'failed'
        ? 'Bulk run failed'
        : status === 'cancelled'
          ? 'Bulk run cancelled'
          : 'Bulk run finished'
    const title = `${titlePrefix} — ${label}`
    const s = meta.stats || {}
    const segs = []
    if (s.done) segs.push(`${s.done} done`)
    if (s.failed) segs.push(`${s.failed} failed`)
    if (s.skipped) segs.push(`${s.skipped} skipped`)
    if (s.cancelled) segs.push(`${s.cancelled} cancelled`)
    const body = segs.length > 0 ? segs.join(' · ') : 'no items'
    return { title, body }
  }

  _show(title, body, runId) {
    let Notification
    try {
      Notification = this.notificationFactory()
    } catch (err) {
      this.log.warn('bulk-notifications', 'factory threw', { message: err.message })
      return
    }
    if (!Notification) return
    // Notification.isSupported() returns false on some headless/CI environs.
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      this.log.debug('bulk-notifications', 'notifications not supported by platform')
      return
    }
    try {
      const n = new Notification({ title, body })
      if (typeof n.on === 'function') {
        n.on('click', () => this._handleClick(runId))
      }
      if (typeof n.show === 'function') n.show()
    } catch (err) {
      this.log.warn('bulk-notifications', 'notification failed', {
        message: err.message,
      })
    }
  }

  /** Click → broadcast IPC so the focused window opens the dashboard. */
  _handleClick(runId) {
    try {
      const win =
        (this.browser.getFocusedWindow && this.browser.getFocusedWindow()) ||
        (this.browser.getAnyWindow && this.browser.getAnyWindow()) ||
        null
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('oz:bulk-history:open-at-run', { runId })
        if (typeof win.focus === 'function') win.focus()
      } else if (this.browser.broadcastToWebUI) {
        // Fallback: broadcast to all webUI windows if no focused one.
        this.browser.broadcastToWebUI('oz:bulk-history:open-at-run', { runId })
      }
    } catch (err) {
      this.log.warn('bulk-notifications', 'click handler failed', {
        message: err.message,
      })
    }
  }
}

module.exports = { BulkNotifications, _defaultNotification }
