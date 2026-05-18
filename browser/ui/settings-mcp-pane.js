// OZ Browser — Settings panel: MCP pane helpers (v1.6.1).
//
// Extracted from settings.js per ADR 0005 (500-LOC budget). Standalone IIFE
// that registers window.OZ.settingsMcpPane with three functions the Settings
// modal calls when the Automation section is open:
//
//   - refresh(): poll oz.mcp.status() and render the pill
//   - render(status): paint pill from a status snapshot (used by push subs)
//   - copy(btn): copy the Cowork config JSON to clipboard, flash button
//
// All three are safe to call without the modal being open — they no-op if
// the target DOM nodes are missing.

;(function () {
  function t(key, params) {
    if (window.oz && window.oz.i18n && typeof window.oz.i18n.t === 'function') {
      return window.oz.i18n.t(key, params)
    }
    return key
  }

  async function refresh() {
    if (!window.oz || !window.oz.mcp) return null
    let status
    try {
      status = await window.oz.mcp.status()
    } catch (_err) {
      return null
    }
    if (!status || status.__error) return null
    render(status)
    return status
  }

  function render(status) {
    const pill = document.getElementById('oz-stg-mcpStatus')
    const text = document.getElementById('oz-stg-mcpStatusText')
    if (!pill || !text || !status) return
    if (status.lastError) {
      pill.setAttribute('data-state', 'error')
      text.textContent = t('settings.automation.statusError', {
        message: status.lastError,
      })
    } else if (status.running) {
      pill.setAttribute('data-state', 'running')
      text.textContent = t('settings.automation.statusRunning', {
        host: status.host,
        port: status.port,
        tools: status.toolCount,
      })
    } else {
      pill.setAttribute('data-state', 'stopped')
      text.textContent = t('settings.automation.statusStopped')
    }
  }

  async function copy(btn, onError) {
    if (!window.oz || !window.oz.mcp || !btn) return
    let snippet
    try {
      snippet = await window.oz.mcp.getCoworkConfigSnippet()
    } catch (err) {
      if (onError) onError(`mcp.getCoworkConfigSnippet failed: ${err.message || err}`)
      return
    }
    if (!snippet || snippet.__error) {
      if (onError) onError('Could not build Cowork config snippet.')
      return
    }
    const json = JSON.stringify(snippet, null, 2)
    try {
      await navigator.clipboard.writeText(json)
    } catch (err) {
      if (onError) onError(`Clipboard write failed: ${err.message || err}`)
      return
    }
    const originalLabel = btn.textContent
    btn.classList.add('copied')
    btn.textContent = t('settings.automation.coworkCopied')
    setTimeout(() => {
      btn.classList.remove('copied')
      btn.textContent = originalLabel
    }, 1500)
  }

  window.OZ = window.OZ || {}
  window.OZ.settingsMcpPane = { refresh, render, copy }
})()
