// OZ Browser — Diagnostics handlers (alpha.112).
//
// Mapa de handlers del subsistema de diagnóstico, consumido por MCP (oz.diag.*)
// — MCP-first (regla Jose). Da al agente una vista COMPLETA del navegador:
//   - snapshot()   estado estructurado (system-diagnostics.buildDiagnostics)
//   - logs()       cola de errores/warnings del log
//   - selfCheck()  el diagnóstico se verifica a sí mismo
//   - screenshot() captura visual (Electron capturePage) → PNG en disco cuyo
//                  path el agente puede leer y analizar como imagen
//
// El screenshot es la pieza que Jose pidió: "hasta con pantallazos y análisis
// de esas imágenes". El módulo NO hace visión por computadora — produce una
// imagen robusta y devuelve el path; el agente (Claude) la lee y la analiza
// con su visión.
//
// Doc: docs/modules/system-diagnostics.md
// ADR: docs/architecture/0043-system-diagnostics.md

'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const log = require('./logger')
const diag = require('./system-diagnostics')

function _err(code, message) {
  return { __error: { code, message: message || code } }
}

function buildDiagnosticsHandlers(browser) {
  const focusedWin = () =>
    (browser.getFocusedWindow && browser.getFocusedWindow()) ||
    (browser.windows && browser.windows[0]) ||
    null

  // Resuelve el webContents objetivo del screenshot según target.
  function resolveTarget({ target, tabId, identityId }) {
    const win = focusedWin()
    if (!win) return { error: _err('NO_WINDOW', 'no focused window') }
    const t = target || 'content'

    if (t === 'chrome') {
      const wc = win.window && win.window.webContents
      if (!wc) return { error: _err('NO_CHROME', 'window has no webContents') }
      return { wc, label: 'chrome' }
    }

    // content / tab / identity → un tab materializado.
    let tab = null
    const list = (win.tabs && win.tabs.tabList) || []
    if (t === 'tab' && tabId) {
      tab = list.find((x) => x.id === tabId) || null
    } else if (t === 'identity' && identityId) {
      tab = list.find((x) => x.identityId === identityId && x.materialized) || null
    } else {
      tab = (win.tabs && win.tabs.selected) || null
    }
    if (!tab) return { error: _err('NO_TAB', 'no matching materialized tab') }
    if (!tab.materialized || !tab.webContents) {
      return { error: _err('TAB_NOT_MATERIALIZED', 'tab has no live webContents') }
    }
    return { wc: tab.webContents, label: `tab-${tab.id}`, tab }
  }

  return {
    /** Snapshot estructurado completo. opts: {includeLog, logLevel, logLimit}. */
    snapshot(opts = {}) {
      try {
        return diag.buildDiagnostics(browser, { ...opts, logger: log })
      } catch (e) {
        return _err('DIAG_CRASH', e && e.message)
      }
    },

    /** Cola de log filtrada. opts: {level, limit}. */
    logs(opts = {}) {
      try {
        const p = log.getLogFilePath ? log.getLogFilePath() : null
        return diag.readLogTail(p, {
          level: opts.level || 'WARN',
          limit: opts.limit || 50,
        })
      } catch (e) {
        return _err('LOG_CRASH', e && e.message)
      }
    },

    /** Auto-verificación del subsistema de diagnóstico. */
    selfCheck() {
      try {
        return diag.selfCheck(browser)
      } catch (e) {
        return _err('SELFCHECK_CRASH', e && e.message)
      }
    },

    /**
     * Captura una imagen del chrome o del contenido de un tab y la guarda como
     * PNG en userData/diagnostics/. Devuelve el path para que el agente lo lea.
     * @param {object} opts
     * @param {'content'|'chrome'|'tab'|'identity'} [opts.target='content']
     * @param {string} [opts.tabId]
     * @param {string} [opts.identityId]
     * @returns {Promise<{ok, path, target, bytes, width, height, url?}|{__error}>}
     */
    async screenshot(opts = {}) {
      const resolved = resolveTarget(opts)
      if (resolved.error) return resolved.error
      const { wc, label, tab } = resolved
      try {
        const image = await wc.capturePage()
        if (!image || image.isEmpty()) {
          return _err('EMPTY_CAPTURE', 'capturePage returned empty image')
        }
        const size = image.getSize()
        const png = image.toPNG()
        const dir = path.join(app.getPath('userData'), 'diagnostics')
        fs.mkdirSync(dir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const file = path.join(dir, `diag-${label}-${ts}.png`)
        fs.writeFileSync(file, png)
        log.info('diagnostics', 'screenshot captured', {
          target: opts.target || 'content',
          path: file,
          bytes: png.length,
        })
        return {
          ok: true,
          path: file,
          target: opts.target || 'content',
          bytes: png.length,
          width: size.width,
          height: size.height,
          url: tab
            ? tab.pendingUrl || (tab.webContents && tab.webContents.getURL()) || null
            : null,
        }
      } catch (e) {
        return _err('CAPTURE_CRASH', e && e.message)
      }
    },
  }
}

module.exports = { buildDiagnosticsHandlers }
