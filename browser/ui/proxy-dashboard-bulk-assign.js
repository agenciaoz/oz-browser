// OZ Browser — Proxy Dashboard Bulk Assign 1:1 modal (H-2h, v1.1.3).
//
// Modal accesible desde botón "Bulk assign" en dashboard header (o via
// "Reassign" en el bulk action bar de identities cuando hay >0 selected).
// Dos listas multi-select side-by-side: Proxies / Identities con search +
// checkbox + filtros (sin disabled, sin default). Preview area se actualiza
// on-change con tabla "Proxy → Identity" + warning si N!=M.
// "Assign N pairs" → backend execute → refresh dashboard.
//
// Expone window.OZ_BulkAssign con open(deps) y openForIdentities(ids).

;(function () {
  let _injected = false
  let _modalEl = null
  let _deps = null
  // Stable internal selection state (NOT shared with H-2f bulk module).
  const _sel = {
    proxyIds: new Set(),
    identityIds: new Set(),
    proxySearch: '',
    identitySearch: '',
    snapshot: null, // last dashboard snapshot for rendering
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function _modalHtml(t) {
    return `<div class="oz-bulk-assign-backdrop" id="oz-bulkassign-backdrop" hidden>
      <div class="oz-bulk-assign-modal" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h2>${_esc(t('proxyDashboard.bulkAssign.title', 'Bulk assign proxies (1:1)'))}</h2>
          <button class="modal-close" id="oz-bulkassign-close" aria-label="Close">✕</button>
        </header>
        <div class="modal-body">
          <div class="lists-row">
            <div class="list-col">
              <h3>${_esc(t('proxyDashboard.bulkAssign.proxiesHeader', 'Proxies'))} <span class="muted" id="oz-bulkassign-proxy-count">(0)</span></h3>
              <input type="search" id="oz-bulkassign-proxy-search" placeholder="${_esc(t('proxyDashboard.bulkAssign.searchProxies', 'Search proxies…'))}" />
              <div class="list-scroll" id="oz-bulkassign-proxy-list"></div>
            </div>
            <div class="list-col">
              <h3>${_esc(t('proxyDashboard.bulkAssign.identitiesHeader', 'Identities'))} <span class="muted" id="oz-bulkassign-ident-count">(0)</span></h3>
              <input type="search" id="oz-bulkassign-ident-search" placeholder="${_esc(t('proxyDashboard.bulkAssign.searchIdentities', 'Search identities…'))}" />
              <div class="list-scroll" id="oz-bulkassign-ident-list"></div>
            </div>
          </div>
          <div class="preview-area">
            <h3>${_esc(t('proxyDashboard.bulkAssign.previewHeader', 'Preview'))} <span class="muted" id="oz-bulkassign-preview-counts"></span></h3>
            <div class="preview-warning" id="oz-bulkassign-warning" hidden></div>
            <div class="preview-table-wrap">
              <table class="preview-table"><thead><tr><th>#</th><th>Proxy</th><th>→</th><th>Identity</th></tr></thead><tbody id="oz-bulkassign-preview-tbody"></tbody></table>
            </div>
          </div>
        </div>
        <footer class="modal-footer">
          <button class="btn-secondary" id="oz-bulkassign-cancel">${_esc(t('proxyDashboard.bulkAssign.close', 'Close'))}</button>
          <button class="btn-primary" id="oz-bulkassign-go" disabled>${_esc(t('proxyDashboard.bulkAssign.assignBtn', 'Assign {{n}} pairs').replace('{{n}}', '0'))}</button>
        </footer>
      </div>
    </div>`
  }

  function _injectStyles() {
    if (document.getElementById('oz-bulkassign-styles')) return
    const css = `
      .oz-bulk-assign-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 100;
      }
      .oz-bulk-assign-modal {
        background: var(--panel); color: var(--text);
        border: 1px solid var(--border); border-radius: 8px;
        width: min(1100px, 95vw); max-height: 92vh;
        display: flex; flex-direction: column; overflow: hidden;
      }
      .oz-bulk-assign-modal .modal-header,
      .oz-bulk-assign-modal .modal-footer {
        padding: 14px 18px; display: flex; align-items: center; gap: 10px;
        border-bottom: 1px solid var(--border);
      }
      .oz-bulk-assign-modal .modal-footer {
        border-bottom: none; border-top: 1px solid var(--border);
        justify-content: flex-end;
      }
      .oz-bulk-assign-modal h2 { margin: 0; font-size: 16px; flex: 1; }
      .oz-bulk-assign-modal h3 { margin: 0 0 6px; font-size: 13px; }
      .oz-bulk-assign-modal .modal-close {
        background: transparent; color: var(--text-muted);
        border: none; font-size: 18px; cursor: pointer;
      }
      .oz-bulk-assign-modal .modal-body {
        flex: 1; overflow-y: auto; padding: 14px 18px;
        display: flex; flex-direction: column; gap: 14px;
      }
      .oz-bulk-assign-modal .lists-row {
        display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
      }
      .oz-bulk-assign-modal .list-col {
        display: flex; flex-direction: column; gap: 6px;
        background: var(--bg); border: 1px solid var(--border);
        border-radius: 6px; padding: 10px;
      }
      .oz-bulk-assign-modal .list-col input[type=search] {
        background: var(--panel); color: var(--text);
        border: 1px solid var(--border); border-radius: 4px;
        padding: 6px 8px; font-size: 12px; width: 100%;
      }
      .oz-bulk-assign-modal .list-scroll {
        max-height: 240px; overflow-y: auto;
        border-top: 1px solid var(--border); padding-top: 4px;
      }
      .oz-bulk-assign-modal .list-scroll label {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 6px; font-size: 12px; cursor: pointer;
        border-radius: 3px;
      }
      .oz-bulk-assign-modal .list-scroll label:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      .oz-bulk-assign-modal .list-scroll input[type=checkbox] {
        accent-color: var(--accent); cursor: pointer; flex: 0 0 auto;
      }
      .oz-bulk-assign-modal .list-scroll .row-meta {
        color: var(--text-muted); font-size: 11px; margin-left: auto;
      }
      .oz-bulk-assign-modal .preview-area .preview-warning {
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.5);
        border-radius: 4px; padding: 6px 10px; font-size: 12px;
        color: var(--red); margin-bottom: 8px;
      }
      .oz-bulk-assign-modal .preview-table-wrap {
        max-height: 200px; overflow-y: auto;
        border: 1px solid var(--border); border-radius: 4px;
      }
      .oz-bulk-assign-modal .preview-table {
        width: 100%; font-size: 12px;
      }
      .oz-bulk-assign-modal .preview-table th {
        position: sticky; top: 0; background: var(--panel);
        text-transform: none; letter-spacing: 0; cursor: default;
      }
      .oz-bulk-assign-modal .muted {
        color: var(--text-muted); font-size: 11px; font-weight: normal;
      }
      .oz-bulk-assign-modal .btn-primary,
      .oz-bulk-assign-modal .btn-secondary {
        padding: 6px 14px; border-radius: 4px; font-size: 13px; cursor: pointer; border: none;
      }
      .oz-bulk-assign-modal .btn-primary {
        background: var(--accent); color: white;
      }
      .oz-bulk-assign-modal .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
      .oz-bulk-assign-modal .btn-secondary {
        background: transparent; color: var(--text); border: 1px solid var(--border);
      }
    `
    const style = document.createElement('style')
    style.id = 'oz-bulkassign-styles'
    style.textContent = css
    document.head.appendChild(style)
  }

  async function _fetchSnapshot() {
    if (!window.oz || !window.oz.proxyHealth) return null
    try {
      const d = await window.oz.proxyHealth.getDashboard()
      _sel.snapshot = d
      return d
    } catch (_e) {
      return null
    }
  }

  function _filterProxies() {
    const all = (_sel.snapshot && _sel.snapshot.proxies) || []
    const q = (_sel.proxySearch || '').toLowerCase()
    // Filter out disabled (decisión Jose): only assignable.
    return all
      .filter((p) => !p.isDisabled)
      .filter((p) => {
        if (!q) return true
        const hay = `${p.name || ''} ${p.host || ''} ${p.country || ''}`.toLowerCase()
        return hay.includes(q)
      })
  }

  function _filterIdentities() {
    const all = (_sel.snapshot && _sel.snapshot.identities) || []
    const q = (_sel.identitySearch || '').toLowerCase()
    // Filter out default identity (no proxy applies to it).
    return all
      .filter((i) => !i.isDefault)
      .filter((i) => {
        if (!q) return true
        const hay = `${i.name || ''} ${i.workspaceName || ''}`.toLowerCase()
        return hay.includes(q)
      })
  }

  function _renderLists() {
    const proxies = _filterProxies()
    const idents = _filterIdentities()
    document.getElementById('oz-bulkassign-proxy-count').textContent =
      `(${proxies.length})`
    document.getElementById('oz-bulkassign-ident-count').textContent =
      `(${idents.length})`
    document.getElementById('oz-bulkassign-proxy-list').innerHTML = proxies
      .map((p) => {
        const checked = _sel.proxyIds.has(p.id) ? ' checked' : ''
        return `<label><input type="checkbox" data-ba-kind="proxy" data-id="${_esc(p.id)}"${checked}/><span>${_esc(p.name || p.host)}</span><span class="row-meta">${_esc(p.host)}:${_esc(p.port)} ${_esc((p.country || '').toUpperCase())}</span></label>`
      })
      .join('')
    document.getElementById('oz-bulkassign-ident-list').innerHTML = idents
      .map((i) => {
        const checked = _sel.identityIds.has(i.id) ? ' checked' : ''
        const proxyLbl = i.proxy ? i.proxy.name : '—'
        return `<label><input type="checkbox" data-ba-kind="ident" data-id="${_esc(i.id)}"${checked}/><span>${_esc(i.name)}</span><span class="row-meta">${_esc(i.workspaceName || '')} · ${_esc(proxyLbl)}</span></label>`
      })
      .join('')
  }

  async function _renderPreview() {
    const t = _deps.t
    const proxyIds = Array.from(_sel.proxyIds)
    const identityIds = Array.from(_sel.identityIds)
    const identityNamesById = {}
    const idents = (_sel.snapshot && _sel.snapshot.identities) || []
    for (const i of idents) identityNamesById[i.id] = i.name
    let preview
    if (window.oz && window.oz.proxyBulkAssign) {
      preview = await window.oz.proxyBulkAssign.preview(proxyIds, identityIds, {
        identityNamesById,
      })
    } else {
      preview = {
        pairings: [],
        warning: null,
        counts: { proxies: proxyIds.length, identities: identityIds.length, paired: 0 },
      }
    }
    const warnEl = document.getElementById('oz-bulkassign-warning')
    if (preview.warning) {
      const c = preview.counts || {}
      warnEl.textContent = t(
        'proxyDashboard.bulkAssign.warningMismatch',
        'Mismatch: {{n}} proxies vs {{m}} identities — only the first {{k}} will be paired.',
      )
        .replace('{{n}}', String(c.proxies || 0))
        .replace('{{m}}', String(c.identities || 0))
        .replace('{{k}}', String(c.paired || 0))
      warnEl.hidden = false
    } else {
      warnEl.hidden = true
    }
    const c = preview.counts || {}
    document.getElementById('oz-bulkassign-preview-counts').textContent =
      `· ${c.proxies || 0} proxies · ${c.identities || 0} identities · ${c.paired || 0} pairs`
    const tbody = document.getElementById('oz-bulkassign-preview-tbody')
    if (!preview.pairings || preview.pairings.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center; padding: 14px;">—</td></tr>`
    } else {
      tbody.innerHTML = preview.pairings
        .map(
          (p, idx) =>
            `<tr><td>${idx + 1}</td><td>${_esc(p.proxyName || p.proxyId)}</td><td>→</td><td>${_esc(p.identityName || p.identityId)}</td></tr>`,
        )
        .join('')
    }
    const goBtn = document.getElementById('oz-bulkassign-go')
    const n = (preview.pairings && preview.pairings.length) || 0
    goBtn.disabled = n === 0
    goBtn.textContent = t(
      'proxyDashboard.bulkAssign.assignBtn',
      'Assign {{n}} pairs',
    ).replace('{{n}}', String(n))
    // Save the pairings for execute step.
    _sel._lastPairings = preview.pairings
  }

  async function _runExecute() {
    if (!_sel._lastPairings || _sel._lastPairings.length === 0) return
    const goBtn = document.getElementById('oz-bulkassign-go')
    goBtn.disabled = true
    try {
      const r = await window.oz.proxyBulkAssign.execute(_sel._lastPairings)
      const s = r.summary || {}
      window.alert(
        `Assigned ${s.ok || 0} / ${s.total || 0} pairs.` +
          (s.failed ? ` ${s.failed} failed.` : ''),
      )
      close()
      if (_deps.refreshDashboard) await _deps.refreshDashboard()
    } catch (err) {
      window.alert('Assign failed: ' + err.message)
    } finally {
      goBtn.disabled = false
    }
  }

  function _wire() {
    document.getElementById('oz-bulkassign-close').addEventListener('click', close)
    document.getElementById('oz-bulkassign-cancel').addEventListener('click', close)
    document.getElementById('oz-bulkassign-go').addEventListener('click', _runExecute)
    document.getElementById('oz-bulkassign-backdrop').addEventListener('click', (ev) => {
      if (ev.target.id === 'oz-bulkassign-backdrop') close()
    })
    document
      .getElementById('oz-bulkassign-proxy-search')
      .addEventListener('input', (ev) => {
        _sel.proxySearch = ev.target.value
        _renderLists()
      })
    document
      .getElementById('oz-bulkassign-ident-search')
      .addEventListener('input', (ev) => {
        _sel.identitySearch = ev.target.value
        _renderLists()
      })
    // Delegated checkbox handler on both list-scrolls.
    _modalEl.addEventListener('change', (ev) => {
      const tt = ev.target
      if (!tt || !tt.dataset || !tt.dataset.baKind) return
      const id = tt.dataset.id
      const set = tt.dataset.baKind === 'proxy' ? _sel.proxyIds : _sel.identityIds
      if (tt.checked) set.add(id)
      else set.delete(id)
      _renderPreview()
    })
  }

  async function open(deps) {
    _deps = deps || {}
    if (!_injected) {
      _injectStyles()
      const wrap = document.createElement('div')
      wrap.innerHTML = _modalHtml(_deps.t || ((k, f) => f || k))
      document.body.appendChild(wrap.firstElementChild)
      _modalEl = document.getElementById('oz-bulkassign-backdrop')
      _wire()
      _injected = true
    }
    _modalEl.hidden = false
    await _fetchSnapshot()
    _renderLists()
    await _renderPreview()
  }

  // Open from H-2f bulk-reassign action: pre-select the identities.
  async function openForIdentities(identityIds) {
    if (Array.isArray(identityIds)) {
      _sel.identityIds = new Set(identityIds)
    }
    await open(_deps || { t: (k, f) => f || k })
  }

  function close() {
    if (_modalEl) _modalEl.hidden = true
  }

  window.OZ_BulkAssign = { open, openForIdentities, close }
})()
