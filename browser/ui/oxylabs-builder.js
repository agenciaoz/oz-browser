// OZ Browser — Oxylabs Proxy Builder modal (H-2k, v1.1.5).
//
// Lazy-injected modal accessible from the proxy-dashboard header
// (button "+ Oxylabs"). Configures Oxylabs Residential proxy generation:
//   - Endpoint + customer + password (one time per session — could be
//     remembered in a future polish pass; for now user pastes from
//     Oxylabs dashboard)
//   - Country dropdown (30 common codes), city text optional
//   - Sticky toggle (default ON) + sesstime select (10/30/60/120 min)
//   - Start session id + count (1-1000)
//   - Live preview of first 5 generated proxy specs
//   - "Insert N proxies" → window.oz.proxies.expandProvider('oxylabs', opts)
//
// Pattern matches proxy-dashboard-import.js + proxy-dashboard-bulk-assign.js.
// Exposes window.OZ_OxylabsBuilder. Backend pure: browser/proxy-providers.js
// (expandOxylabs).
//
// Doc: docs/modules/oxylabs-builder.md (TBD)

;(function () {
  // 30 country codes Oxylabs Residential exposes most reliably.
  // Source: Oxylabs docs + Jose's existing accounts (LATAM heavy).
  const COUNTRIES = [
    ['', '— Any —'],
    ['US', 'United States'],
    ['AR', 'Argentina'],
    ['BR', 'Brazil'],
    ['MX', 'Mexico'],
    ['CO', 'Colombia'],
    ['CL', 'Chile'],
    ['PE', 'Peru'],
    ['ES', 'Spain'],
    ['GB', 'United Kingdom'],
    ['FR', 'France'],
    ['DE', 'Germany'],
    ['IT', 'Italy'],
    ['NL', 'Netherlands'],
    ['BE', 'Belgium'],
    ['RU', 'Russia'],
    ['UA', 'Ukraine'],
    ['JP', 'Japan'],
    ['CN', 'China'],
    ['KR', 'South Korea'],
    ['IN', 'India'],
    ['ID', 'Indonesia'],
    ['TH', 'Thailand'],
    ['VN', 'Vietnam'],
    ['PH', 'Philippines'],
    ['MY', 'Malaysia'],
    ['SG', 'Singapore'],
    ['AU', 'Australia'],
    ['NZ', 'New Zealand'],
    ['CA', 'Canada'],
    ['ZA', 'South Africa'],
  ]

  // State lives only while the modal is open.
  let state = null
  let $root = null

  function open(deps) {
    if ($root) return // already open — idempotent
    state = {
      endpoint: 'us-pr.oxylabs.io:10001',
      customer: '',
      password: '',
      country: '',
      city: '',
      sticky: true,
      sesstimeMin: 30,
      startSessId: 1,
      count: 10,
    }
    $root = renderModal(deps)
    document.body.appendChild($root)
    refreshPreview()
  }

  function close() {
    if ($root && $root.parentNode) $root.parentNode.removeChild($root)
    $root = null
    state = null
  }

  // ----- preview generator (mirrors backend expandOxylabs, but for preview
  // only — we DON'T submit to backend until user clicks Insert) -----
  function previewGenerate(maxItems) {
    if (!state) return [] // defensive — called pre-open / post-close
    const n = Math.min(Math.max(0, Number(state.count) || 0), maxItems || 5)
    if (n === 0) return []
    const m = String(state.endpoint).match(/^([^:]+):(\d+)$/)
    if (!m) return []
    const items = []
    const citySlug = state.city
      ? String(state.city).trim().toLowerCase().replace(/\s+/g, '_')
      : null
    for (let i = 0; i < n; i++) {
      const sessId = String(Number(state.startSessId) + i).padStart(6, '0')
      const parts = [`customer-${state.customer || 'CUSTOMER'}`]
      if (state.country) parts.push(`cc-${state.country.toLowerCase()}`)
      if (citySlug) parts.push(`city-${citySlug}`)
      if (state.sticky) {
        parts.push(`sessid-${sessId}`)
        parts.push(`sesstime-${state.sesstimeMin}`)
      }
      items.push({
        username: parts.join('-'),
        host: m[1],
        port: parseInt(m[2], 10),
        sessId: state.sticky ? sessId : '—',
      })
    }
    return items
  }

  // ----- render -----
  function renderModal(deps) {
    const t = (deps && deps.t) || ((k, f) => f || k)
    const root = document.createElement('div')
    root.className = 'pm-backdrop'
    root.id = 'oxy-builder-backdrop'
    root.innerHTML = `
      <div class="pm-modal" style="max-width: 760px; width: 92vw; max-height: 90vh;">
        <header class="pm-header">
          <h2>${esc(t('oxylabsBuilder.title', 'Oxylabs Proxy Builder'))}</h2>
          <button class="pm-close" type="button" title="Close">×</button>
        </header>
        <div class="pm-body" style="overflow:auto;">
          <form id="oxy-form" class="pm-form" style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <label class="full" style="grid-column: 1 / -1;">${esc(t('oxylabsBuilder.endpoint', 'Endpoint (host:port)'))}
              <input name="endpoint" type="text" value="us-pr.oxylabs.io:10001"></label>
            <label>${esc(t('oxylabsBuilder.customer', 'Customer'))}
              <input name="customer" type="text" placeholder="mzewama"></label>
            <label>${esc(t('oxylabsBuilder.password', 'Password'))}
              <input name="password" type="password"></label>
            <label>${esc(t('oxylabsBuilder.country', 'Country'))}
              <select name="country">${COUNTRIES.map(
                ([code, label]) =>
                  `<option value="${esc(code)}">${esc(label)}${code ? ' (' + code + ')' : ''}</option>`,
              ).join('')}</select></label>
            <label>${esc(t('oxylabsBuilder.city', 'City (optional)'))}
              <input name="city" type="text" placeholder="new_york"></label>
            <label class="full" style="grid-column: 1 / -1; display:flex; align-items:center; gap:8px;">
              <input name="sticky" type="checkbox" checked>
              <span>${esc(t('oxylabsBuilder.sticky', 'Sticky session (same IP for sesstime; off = rotating per request)'))}</span>
            </label>
            <label id="oxy-sesstime-wrap">${esc(t('oxylabsBuilder.sesstime', 'Sticky duration'))}
              <select name="sesstimeMin">
                <option value="10">10 min</option>
                <option value="30" selected>30 min</option>
                <option value="60">60 min (1h)</option>
                <option value="120">120 min (2h)</option>
              </select></label>
            <label>${esc(t('oxylabsBuilder.startSessId', 'Start session #'))}
              <input name="startSessId" type="number" min="1" value="1"></label>
            <label>${esc(t('oxylabsBuilder.count', 'How many proxies'))}
              <input name="count" type="number" min="1" max="1000" value="10"></label>
          </form>
          <div class="pm-section-title" style="margin-top:16px;">${esc(t('oxylabsBuilder.preview', 'Preview (first 5)'))}</div>
          <div id="oxy-preview" class="oxy-preview-box"></div>
          <div id="oxy-error" class="oxy-error" hidden></div>
        </div>
        <footer class="pm-footer">
          <span id="oxy-count-hint" class="small"></span>
          <span class="spacer"></span>
          <button id="oxy-cancel" type="button">${esc(t('common.cancel', 'Cancel'))}</button>
          <button id="oxy-insert" class="primary" type="button" disabled>${esc(t('oxylabsBuilder.insert', 'Insert proxies'))}</button>
        </footer>
      </div>
    `
    injectStylesOnce()
    wireEvents(root, deps)
    return root
  }

  function wireEvents(root, deps) {
    root.querySelector('.pm-close').addEventListener('click', close)
    root.querySelector('#oxy-cancel').addEventListener('click', close)
    root.addEventListener('click', (ev) => {
      // Click outside the modal box → close.
      if (ev.target === root) close()
    })
    const form = root.querySelector('#oxy-form')
    form.addEventListener('input', () => {
      readFormIntoState(form)
      updateSesstimeVisibility(root)
      refreshPreview()
    })
    form.addEventListener('change', () => {
      readFormIntoState(form)
      updateSesstimeVisibility(root)
      refreshPreview()
    })
    root.querySelector('#oxy-insert').addEventListener('click', () => insert(deps))
  }

  function readFormIntoState(form) {
    state.endpoint = form.endpoint.value.trim()
    state.customer = form.customer.value.trim()
    state.password = form.password.value
    state.country = form.country.value
    state.city = form.city.value.trim()
    state.sticky = !!form.sticky.checked
    state.sesstimeMin = Number(form.sesstimeMin.value) || 30
    state.startSessId = Math.max(1, Number(form.startSessId.value) || 1)
    state.count = Math.max(0, Math.min(1000, Number(form.count.value) || 0))
  }

  function updateSesstimeVisibility(root) {
    const wrap = root.querySelector('#oxy-sesstime-wrap')
    wrap.style.display = state.sticky ? '' : 'none'
  }

  function refreshPreview() {
    if (!$root) return
    const items = previewGenerate(5)
    const box = $root.querySelector('#oxy-preview')
    const hint = $root.querySelector('#oxy-count-hint')
    const insertBtn = $root.querySelector('#oxy-insert')
    const errBox = $root.querySelector('#oxy-error')

    // Validation.
    const issues = []
    if (!state.endpoint || !/^[^:]+:\d+$/.test(state.endpoint)) {
      issues.push('Endpoint must be host:port')
    }
    if (!state.customer) issues.push('Customer required')
    if (!state.password) issues.push('Password required')
    if (state.count < 1 || state.count > 1000) issues.push('Count must be 1–1000')

    if (issues.length) {
      errBox.hidden = false
      errBox.textContent = issues.join(' · ')
      insertBtn.disabled = true
    } else {
      errBox.hidden = true
      insertBtn.disabled = false
    }

    hint.textContent = `${state.count} proxies will be inserted`
    box.innerHTML = items.length
      ? `<table class="oxy-preview-table">
          <thead><tr><th>#</th><th>Sess ID</th><th>Username</th><th>host:port</th></tr></thead>
          <tbody>${items
            .map(
              (it, i) =>
                `<tr><td>${i + 1}</td><td>${esc(it.sessId)}</td><td class="mono">${esc(it.username)}</td><td class="mono">${esc(it.host)}:${esc(it.port)}</td></tr>`,
            )
            .join('')}${
            state.count > items.length
              ? `<tr class="muted-row"><td colspan="4">… and ${state.count - items.length} more</td></tr>`
              : ''
          }</tbody>
        </table>`
      : `<div class="muted">Fill the form to preview generated proxies.</div>`
  }

  async function insert(deps) {
    if (!window.oz || !window.oz.proxies || !window.oz.proxies.expandProvider) return
    const insertBtn = $root.querySelector('#oxy-insert')
    insertBtn.disabled = true
    insertBtn.textContent = 'Inserting…'
    const opts = {
      endpoint: state.endpoint,
      customer: state.customer,
      password: state.password,
      count: state.count,
      sticky: state.sticky,
      sesstimeMin: state.sesstimeMin,
      startSessId: state.startSessId,
      country: state.country || null,
      city: state.city || null,
    }
    let r = null
    try {
      r = await window.oz.proxies.expandProvider('oxylabs', opts)
    } catch (err) {
      r = { __error: { code: 'IPC_THREW', message: err && err.message } }
    }
    if (r && r.__error) {
      const errBox = $root.querySelector('#oxy-error')
      errBox.hidden = false
      errBox.textContent = `${r.__error.code}: ${r.__error.message || ''}`
      insertBtn.disabled = false
      insertBtn.textContent = 'Insert proxies'
      return
    }
    window.alert(`✅ Added ${r && r.addedCount} Oxylabs proxies to the pool.`)
    close()
    if (deps && typeof deps.refreshDashboard === 'function') {
      try {
        await deps.refreshDashboard()
      } catch (_err) {
        // swallow — dashboard refresh isn't critical, broadcast also triggers it.
      }
    }
  }

  // ----- CSS — injected once -----
  function injectStylesOnce() {
    if (document.getElementById('oxy-builder-styles')) return
    const style = document.createElement('style')
    style.id = 'oxy-builder-styles'
    style.textContent = `
      .pm-backdrop#oxy-builder-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; display: flex; align-items: center; justify-content: center; }
      .pm-backdrop#oxy-builder-backdrop .pm-modal { background: var(--panel, #232323); color: var(--text, #e8e8e8); border-radius: 10px; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
      .pm-backdrop#oxy-builder-backdrop .pm-header { padding: 14px 18px; border-bottom: 1px solid var(--border, #2e2e2e); display: flex; align-items: center; justify-content: space-between; }
      .pm-backdrop#oxy-builder-backdrop .pm-header h2 { margin: 0; font-size: 16px; }
      .pm-backdrop#oxy-builder-backdrop .pm-close { background: transparent; color: var(--text-muted, #888); border: 0; font-size: 22px; cursor: pointer; line-height: 1; padding: 2px 8px; }
      .pm-backdrop#oxy-builder-backdrop .pm-body { padding: 18px; }
      .pm-backdrop#oxy-builder-backdrop .pm-footer { padding: 12px 18px; border-top: 1px solid var(--border, #2e2e2e); display: flex; gap: 8px; align-items: center; }
      .pm-backdrop#oxy-builder-backdrop .pm-footer .spacer { flex: 1; }
      .pm-backdrop#oxy-builder-backdrop .pm-footer button { padding: 6px 14px; border-radius: 5px; border: 1px solid var(--border, #2e2e2e); background: transparent; color: var(--text, #e8e8e8); cursor: pointer; }
      .pm-backdrop#oxy-builder-backdrop .pm-footer button.primary { background: var(--accent, #7c5fbf); border-color: var(--accent, #7c5fbf); color: white; }
      .pm-backdrop#oxy-builder-backdrop .pm-footer button:disabled { opacity: 0.4; cursor: not-allowed; }
      .pm-backdrop#oxy-builder-backdrop label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-muted, #888); gap: 4px; }
      .pm-backdrop#oxy-builder-backdrop input, .pm-backdrop#oxy-builder-backdrop select { background: var(--bg, #1a1a1a); color: var(--text, #e8e8e8); border: 1px solid var(--border, #2e2e2e); border-radius: 4px; padding: 5px 8px; font-size: 13px; }
      .pm-backdrop#oxy-builder-backdrop .pm-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted, #888); }
      .pm-backdrop#oxy-builder-backdrop .oxy-preview-box { margin-top: 8px; max-height: 240px; overflow: auto; border: 1px solid var(--border, #2e2e2e); border-radius: 6px; padding: 6px; background: var(--bg, #1a1a1a); }
      .pm-backdrop#oxy-builder-backdrop .oxy-preview-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .pm-backdrop#oxy-builder-backdrop .oxy-preview-table th { color: var(--text-muted, #888); padding: 4px 6px; text-align: left; font-weight: 600; }
      .pm-backdrop#oxy-builder-backdrop .oxy-preview-table td { padding: 3px 6px; border-top: 1px solid var(--border, #2e2e2e); }
      .pm-backdrop#oxy-builder-backdrop .oxy-preview-table td.mono { font-family: ui-monospace, monospace; font-size: 10px; word-break: break-all; }
      .pm-backdrop#oxy-builder-backdrop .oxy-preview-table tr.muted-row td { color: var(--text-muted, #888); font-style: italic; text-align: center; }
      .pm-backdrop#oxy-builder-backdrop .oxy-error { margin-top: 8px; padding: 8px 12px; background: rgba(239, 68, 68, 0.12); color: var(--red, #ef4444); border-radius: 6px; font-size: 12px; }
    `
    document.head.appendChild(style)
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  window.OZ_OxylabsBuilder = { open, close, previewGenerate, COUNTRIES }
})()
