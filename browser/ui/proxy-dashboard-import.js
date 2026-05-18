// OZ Browser — Proxy Dashboard Import modal (H-2g, v1.1.3).
//
// Modal "Import proxies" desde el botón "+ Import" en el dashboard header.
// Auto-detect entre 3 formatos (CSV / URL-style / host-port). Preview tabla
// con N rows + errores highlighted. "Import N valid proxies" → batch.
//
// Expone window.OZ_DashboardImport con open(deps), close(). Inyecta su markup
// en document.body al primer open (lazy).

;(function () {
  let _injected = false
  let _modalEl = null
  let _lastParsed = null
  let _deps = null
  let _reparseOnChange = true

  function _modalHtml(t) {
    return `<div class="oz-import-modal-backdrop" id="oz-import-backdrop" hidden>
      <div class="oz-import-modal" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h2>${_esc(t('proxyDashboard.import.title', 'Import proxies'))}</h2>
          <button class="modal-close" id="oz-import-close" aria-label="Close">✕</button>
        </header>
        <div class="modal-body">
          <div class="row paste-row">
            <label for="oz-import-textarea">${_esc(t('proxyDashboard.import.paste', 'Paste proxy list'))}</label>
            <textarea id="oz-import-textarea" rows="8" placeholder="${_esc(t('proxyDashboard.import.placeholder', 'host:port:user:pass\nuser:pass@host:port\nor CSV with headers: host,port,user,pass,country,label'))}"></textarea>
          </div>
          <div class="row controls-row">
            <input type="file" id="oz-import-file" accept=".csv,.txt,.tsv" />
            <label class="cb-row">
              <input type="checkbox" id="oz-import-reparse" checked />
              <span>${_esc(t('proxyDashboard.import.reparseOnChange', 'Re-parse on text change'))}</span>
            </label>
            <span class="format-pill" id="oz-import-format">—</span>
            <span class="spacer"></span>
            <button class="btn-primary" id="oz-import-parse-btn">Parse</button>
          </div>
          <div class="row preview-row">
            <h3>${_esc(t('proxyDashboard.import.previewTitle', 'Preview'))} <span class="muted" id="oz-import-summary"></span></h3>
            <div class="preview-table-wrap">
              <table class="preview-table">
                <thead><tr><th>#</th><th>Status</th><th>Host</th><th>Port</th><th>User</th><th>Country</th><th>Error</th></tr></thead>
                <tbody id="oz-import-preview-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
        <footer class="modal-footer">
          <button class="btn-secondary" id="oz-import-cancel">${_esc(t('proxyDashboard.import.close', 'Close'))}</button>
          <button class="btn-primary" id="oz-import-go" disabled>${_esc(t('proxyDashboard.import.addProxies', 'Import {{n}} valid proxies').replace('{{n}}', '0'))}</button>
        </footer>
      </div>
    </div>`
  }

  function _injectStyles() {
    if (document.getElementById('oz-import-styles')) return
    const css = `
      .oz-import-modal-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 100;
      }
      /* v1.6.6 fix: same display:flex-vs-[hidden] bug as bulk-assign. */
      .oz-import-modal-backdrop[hidden] { display: none !important; }
      .oz-import-modal {
        background: var(--panel); color: var(--text);
        border: 1px solid var(--border); border-radius: 8px;
        width: min(900px, 95vw); max-height: 90vh; overflow: hidden;
        display: flex; flex-direction: column;
      }
      .oz-import-modal .modal-header,
      .oz-import-modal .modal-footer {
        padding: 14px 18px; display: flex; align-items: center; gap: 10px;
        border-bottom: 1px solid var(--border);
      }
      .oz-import-modal .modal-footer {
        border-bottom: none; border-top: 1px solid var(--border);
        justify-content: flex-end;
      }
      .oz-import-modal h2 { margin: 0; font-size: 16px; flex: 1; }
      .oz-import-modal .modal-close {
        background: transparent; color: var(--text-muted);
        border: none; font-size: 18px; cursor: pointer;
      }
      .oz-import-modal .modal-body {
        flex: 1; overflow-y: auto; padding: 14px 18px;
        display: flex; flex-direction: column; gap: 12px;
      }
      .oz-import-modal label { font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 4px; }
      .oz-import-modal textarea {
        width: 100%; background: var(--bg); color: var(--text);
        border: 1px solid var(--border); border-radius: 4px;
        padding: 8px; font-family: monospace; font-size: 12px;
        resize: vertical;
      }
      .oz-import-modal .controls-row {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      .oz-import-modal .cb-row {
        display: inline-flex; gap: 6px; align-items: center;
        margin: 0; font-size: 12px;
      }
      .oz-import-modal .format-pill {
        background: var(--border); padding: 2px 10px; border-radius: 10px;
        font-size: 11px; color: var(--text);
      }
      .oz-import-modal .format-pill[data-format="csv"],
      .oz-import-modal .format-pill[data-format="url-style"],
      .oz-import-modal .format-pill[data-format="host-port"] {
        background: rgba(124, 95, 191, 0.2); color: var(--accent);
      }
      .oz-import-modal .format-pill[data-format="unknown"] {
        background: rgba(239, 68, 68, 0.15); color: var(--red);
      }
      .oz-import-modal .spacer { flex: 1; }
      .oz-import-modal .btn-primary,
      .oz-import-modal .btn-secondary {
        padding: 6px 14px; border-radius: 4px; font-size: 13px; cursor: pointer; border: none;
      }
      .oz-import-modal .btn-primary {
        background: var(--accent); color: white;
      }
      .oz-import-modal .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
      .oz-import-modal .btn-secondary {
        background: transparent; color: var(--text); border: 1px solid var(--border);
      }
      .oz-import-modal .preview-row h3 { margin: 0 0 8px; font-size: 13px; }
      .oz-import-modal .preview-table-wrap {
        max-height: 280px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px;
      }
      .oz-import-modal .preview-table {
        width: 100%; font-size: 12px;
      }
      .oz-import-modal .preview-table th {
        position: sticky; top: 0; background: var(--panel);
        text-transform: none; letter-spacing: 0; cursor: default;
      }
      .oz-import-modal .preview-table tr.invalid {
        background: rgba(239, 68, 68, 0.07);
      }
      .oz-import-modal .preview-table .status-pill {
        display: inline-block; padding: 1px 6px; border-radius: 8px;
        font-size: 10px; font-weight: 600;
      }
      .oz-import-modal .preview-table .status-pill.ok {
        background: rgba(74,222,128,0.15); color: var(--green);
      }
      .oz-import-modal .preview-table .status-pill.fail {
        background: rgba(239, 68, 68, 0.15); color: var(--red);
      }
      .oz-import-modal .muted { color: var(--text-muted); font-size: 11px; font-weight: normal; }
    `
    const style = document.createElement('style')
    style.id = 'oz-import-styles'
    style.textContent = css
    document.head.appendChild(style)
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function _renderPreview(parsed, t) {
    _lastParsed = parsed
    const tbody = document.getElementById('oz-import-preview-tbody')
    const pill = document.getElementById('oz-import-format')
    const summary = document.getElementById('oz-import-summary')
    const goBtn = document.getElementById('oz-import-go')
    const fmt = (parsed && parsed.format) || 'unknown'
    pill.dataset.format = fmt
    pill.textContent = t('proxyDashboard.import.format' + _capFmt(fmt), fmt)
    const rows = (parsed && parsed.rows) || []
    const s = (parsed && parsed.summary) || { total: 0, valid: 0, invalid: 0 }
    summary.textContent = `${s.total} rows · ${s.valid} valid · ${s.invalid} invalid`
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center; padding: 20px;">${_esc(t('proxyDashboard.import.formatUnknown', 'Unknown — please review'))}</td></tr>`
    } else {
      tbody.innerHTML = rows
        .slice(0, 50)
        .map((r) => {
          const cls = r.ok ? '' : 'invalid'
          const p = r.proxy || {}
          const status = r.ok
            ? '<span class="status-pill ok">OK</span>'
            : '<span class="status-pill fail">' +
              _esc(t('proxyDashboard.import.invalidRow', 'invalid')) +
              '</span>'
          const errMsg = r.ok
            ? ''
            : _esc((r.reason || '') + (r.message ? ' — ' + r.message : ''))
          return `<tr class="${cls}"><td>${r.row}</td><td>${status}</td><td>${_esc(p.host || '')}</td><td>${_esc(p.port == null ? '' : p.port)}</td><td>${_esc(p.username || '')}</td><td>${_esc(p.country || '')}</td><td>${errMsg}</td></tr>`
        })
        .join('')
    }
    const validCount = s.valid
    goBtn.disabled = validCount === 0
    goBtn.textContent = t(
      'proxyDashboard.import.addProxies',
      'Import {{n}} valid proxies',
    ).replace('{{n}}', String(validCount))
  }

  function _capFmt(fmt) {
    if (fmt === 'csv') return 'Csv'
    if (fmt === 'url-style') return 'UrlStyle'
    if (fmt === 'host-port') return 'HostPort'
    return 'Unknown'
  }

  async function _parseFromTextarea() {
    if (!_deps) return
    const ta = document.getElementById('oz-import-textarea')
    if (!ta) return
    const text = ta.value || ''
    if (!text.trim()) {
      _renderPreview(
        { format: 'unknown', rows: [], summary: { total: 0, valid: 0, invalid: 0 } },
        _deps.t,
      )
      return
    }
    let parsed
    if (window.oz && window.oz.proxyImporter) {
      parsed = await window.oz.proxyImporter.parse(text)
    } else {
      parsed = {
        format: 'unknown',
        rows: [],
        summary: { total: 0, valid: 0, invalid: 0 },
      }
    }
    _renderPreview(parsed, _deps.t)
  }

  function _onFileChange(ev) {
    const file = ev.target.files && ev.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const ta = document.getElementById('oz-import-textarea')
      ta.value = e.target.result || ''
      _parseFromTextarea()
    }
    reader.readAsText(file)
  }

  async function _runImport() {
    if (!_lastParsed || !_lastParsed.rows) return
    const valid = _lastParsed.rows.filter((r) => r.ok)
    if (valid.length === 0) return
    const goBtn = document.getElementById('oz-import-go')
    goBtn.disabled = true
    goBtn.textContent = _deps.t('proxyDashboard.import.importing', 'Importing…')
    try {
      const r = await window.oz.proxyImporter.import(valid)
      window.alert(
        _deps
          .t(
            'proxyDashboard.import.importComplete',
            'Import complete — added {{n}} proxies',
          )
          .replace('{{n}}', String(r.added || 0)),
      )
      close()
      if (_deps.refreshDashboard) await _deps.refreshDashboard()
    } catch (err) {
      window.alert('Import failed: ' + err.message)
    } finally {
      goBtn.disabled = false
    }
  }

  function _wire() {
    document.getElementById('oz-import-close').addEventListener('click', close)
    document.getElementById('oz-import-cancel').addEventListener('click', close)
    document.getElementById('oz-import-textarea').addEventListener('input', () => {
      if (_reparseOnChange) _parseFromTextarea()
    })
    document.getElementById('oz-import-reparse').addEventListener('change', (e) => {
      _reparseOnChange = !!e.target.checked
    })
    document
      .getElementById('oz-import-parse-btn')
      .addEventListener('click', _parseFromTextarea)
    document.getElementById('oz-import-file').addEventListener('change', _onFileChange)
    document.getElementById('oz-import-go').addEventListener('click', _runImport)
    document.getElementById('oz-import-backdrop').addEventListener('click', (ev) => {
      if (ev.target.id === 'oz-import-backdrop') close()
    })
  }

  function open(deps) {
    _deps = deps || {}
    if (!_injected) {
      _injectStyles()
      const wrap = document.createElement('div')
      wrap.innerHTML = _modalHtml(_deps.t || ((k, f) => f || k))
      document.body.appendChild(wrap.firstElementChild)
      _modalEl = document.getElementById('oz-import-backdrop')
      _wire()
      _injected = true
    }
    document.getElementById('oz-import-textarea').value = ''
    _lastParsed = null
    _renderPreview(
      { format: 'unknown', rows: [], summary: { total: 0, valid: 0, invalid: 0 } },
      _deps.t,
    )
    _modalEl.hidden = false
  }

  function close() {
    if (_modalEl) _modalEl.hidden = true
  }

  window.OZ_DashboardImport = { open, close }
})()
