// OZ Browser — Power monitor setup (K1-extras, v1.4.2).
//
// Listens to Electron's `powerMonitor.on('resume')` event (fired when the
// Mac wakes from sleep) and triggers `proxyHealth.testAll()` to re-validate
// every proxy. Why: during sleep, proxies can become temporarily
// unreachable (provider rotates IPs, network changes from WiFi to wired,
// VPN dropped). Without this, the next time the user opens a tab the proxy
// may be silently dead and they get a "page not loading" experience.
//
// Default behavior: re-test on resume. Suppressible via Settings →
// notifications.macSleepProxyRescan = false (we read the same `notifications`
// section anti-logout uses, keeping the surface small).
//
// Pattern: factory function returns `{stop}` for clean teardown. Same
// pattern as power-monitor wrappers in other Electron apps — keeps tests
// happy with injectable dependencies.
//
// Doc: docs/modules/power-monitor-setup.md (TBD)

const log = require('./logger')

const DEFAULT_DEBOUNCE_MS = 3000 // Wait 3s after resume before testing (let
// the network reconnect).
const SETTING_KEY = 'macSleepProxyRescan'

/**
 * Wire powerMonitor.on('resume') to proxyHealth.testAll().
 *
 * @param {object} deps
 * @param {{testAll: Function}} deps.proxyHealth
 * @param {{on: Function, removeListener?: Function}} deps.powerMonitor
 *   Electron's powerMonitor. Injectable for tests.
 * @param {{get?: Function}} [deps.settingsManager]
 *   Reads settings.notifications.<SETTING_KEY> — when false, listener
 *   still installs but skips the testAll call (so toggling at runtime
 *   takes effect without reboot).
 * @param {number} [deps.debounceMs=3000]
 * @returns {{stop: Function, _trigger: Function}} _trigger exposed for tests.
 */
function setupPowerMonitor({
  proxyHealth,
  powerMonitor,
  settingsManager,
  debounceMs = DEFAULT_DEBOUNCE_MS,
} = {}) {
  if (!proxyHealth || typeof proxyHealth.testAll !== 'function') {
    log.warn('power-monitor-setup', 'no proxyHealth.testAll — power monitor disabled')
    return { stop: () => {} }
  }
  if (!powerMonitor || typeof powerMonitor.on !== 'function') {
    log.warn('power-monitor-setup', 'no powerMonitor — disabled')
    return { stop: () => {} }
  }

  let pendingTimer = null

  function _enabled() {
    if (!settingsManager || typeof settingsManager.get !== 'function') return true
    try {
      const sect = settingsManager.get('notifications')
      if (sect && typeof sect === 'object' && sect[SETTING_KEY] === false) return false
    } catch (_e) {
      // best-effort — default true
    }
    return true
  }

  async function _trigger(reason) {
    if (!_enabled()) {
      log.info('power-monitor-setup', `resume — skipped (${SETTING_KEY}=false)`)
      return { skipped: true, reason: 'disabled' }
    }
    log.info('power-monitor-setup', 'resume — re-testing all proxies', { reason })
    try {
      const result = await proxyHealth.testAll()
      log.info('power-monitor-setup', 'resume re-test done', { result })
      return { ok: true, result }
    } catch (err) {
      log.warn('power-monitor-setup', 'resume re-test failed', {
        message: err && err.message,
      })
      return { ok: false, error: err && err.message }
    }
  }

  function onResume() {
    // Debounce — coalesce rapid resume events (lid open/close cycle).
    if (pendingTimer) {
      clearTimeout(pendingTimer)
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      _trigger('resume').catch(() => {
        // never throw from event handler
      })
    }, debounceMs)
  }

  powerMonitor.on('resume', onResume)
  log.info('power-monitor-setup', 'installed resume listener', { debounceMs })

  function stop() {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    if (typeof powerMonitor.removeListener === 'function') {
      powerMonitor.removeListener('resume', onResume)
    } else if (typeof powerMonitor.off === 'function') {
      powerMonitor.off('resume', onResume)
    }
    log.info('power-monitor-setup', 'stopped resume listener')
  }

  return { stop, _trigger }
}

/**
 * One-call wire-up for the main browser instance. Resolves Electron's
 * powerMonitor + uses browser.proxyHealth + browser.settingsManager. Adds
 * teardown handle to browser._powerMonitorTeardown so main's before-quit
 * cleanup can call it. Defensive: swallows errors so a non-Electron
 * environment (tests) doesn't crash.
 */
function wirePowerMonitorOntoBrowser(browser) {
  try {
    const { powerMonitor } = require('electron')
    const teardown = setupPowerMonitor({
      proxyHealth: browser.proxyHealth,
      powerMonitor,
      settingsManager: browser.settingsManager,
    })
    browser._powerMonitorTeardown = teardown
    return teardown
  } catch (err) {
    log.warn('power-monitor-setup', 'wire-up failed', { message: err && err.message })
    return { stop: () => {} }
  }
}

/**
 * Symmetric teardown — safe to call multiple times. Reads from
 * browser._powerMonitorTeardown that wirePowerMonitorOntoBrowser sets.
 */
function teardownPowerMonitorFromBrowser(browser) {
  const t = browser && browser._powerMonitorTeardown
  if (t && typeof t.stop === 'function') {
    try {
      t.stop()
    } catch (err) {
      log.warn('power-monitor-setup', 'teardown failed', { message: err && err.message })
    }
    browser._powerMonitorTeardown = null
  }
}

module.exports = {
  setupPowerMonitor,
  wirePowerMonitorOntoBrowser,
  teardownPowerMonitorFromBrowser,
  DEFAULT_DEBOUNCE_MS,
  SETTING_KEY,
}
