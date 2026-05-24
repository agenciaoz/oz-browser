// OZ Browser — Bright Data Proxy Builder modal (v2.0.0-alpha.22).
//
// Lazy-injected modal accessible from the proxy-dashboard header
// (button "+ Bright Data"). Configures Bright Data Residential proxy
// generation:
//   - Endpoint default brd.superproxy.io:22225
//   - Customer ID + Password + Zone (required)
//   - Country dropdown (30 common codes), city text optional
//   - Sticky toggle (default ON) — when on emits `-session-{N}`, when off
//     omits the session token (rotating exit IP per request)
//   - Start session id + count (1..1000)
//   - Live preview of first 5 generated proxy specs
//   - "Insert N proxies" → window.oz.proxies.expandProvider('brightdata', opts)
//
// Mirrors oxylabs-builder.js. Backend pure: browser/proxy-providers.js
// (expandBrightData). Exposes window.OZ_BrightDataBuilder.

;(function () {
  // Same 30 codes as oxylabs-builder — Bright Data exposes a broader set but
  // we keep parity for UI consistency (user can hand-type country anyway).
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

  let state = null
  let $root = null

  function open(deps) {
    if ($root) return // idempotent — opening twice is a no-op
    state = {
      endpoint: 'brd.superproxy.io:22225',
      customer: '',
      password: '',
      zone: '',
      country: '',
      city: '',
      sticky: true,
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

  // ----- preview generator (mirrors backend expandBrightData) -----
  function previewGenerate(maxItems) {
    if (!state) return []
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
      const parts = [
        `brd-customer-${state.customer || 'CUSTOMER'}`,
        `zone-${state.zone || 'ZONE'}`,
      ]
      if (state.country) parts.push(`country-${state.country.toLowerCase()}`)
      if (citySlug) parts.push(`city-${citySlug}`)
      if (state.sticky) parts.push(`session-${sessId}`)
      items.push({
        username: parts.join('-'),
        host: m[1],
        port: parseInt(m[2], 10),
        zone: state.zone || '—',
        sessId: state.sticky ? sessId : '—',
      })
    }
    return items
  }

  function renderModal(deps) {
    const t = (deps && deps.t) || ((k, f) => f || k)
    const root = document.createElement('div')
    root.className = 'pm-backdrop'
    root.id = 'bd-builder-backdrop'
    root.innerHTML = `
      <div class="pm-modal" style="max-width: 760px; width: 92vw; max-height: 90vh;">
        <header class="pm-header">
          <h2>${esc(t('brightdataBuilder.title', 'Bright Data Proxy Builder'))}</h2>
          <button class="pm-close" type="button" title="Close">×</button>
        </header>
        <div class="pm-body" style="overflow:auto;">
          <form id="bd-form" class="pm-form" style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <label class="full" style="grid-column: 1 / -1;">${esc(t('brightdataBuilder.endpoint', 'Endpoint (host:port)'))}
              <input name="endpoint" type="text" value="brd.superproxy.io:22225"></label>
            <label>${esc(t('brightdataBuilder.customer', 'Customer ID'))}
              <input name="customer" type="text" placeholder="hl_xxxxxxxx"></label>
            <label>${esc(t('brightdataBuilder.password', 'Password'))}
              <input name="password" type="password"></label>
            <label>${esc(t('brightdataBuilder.zone', 'Zone'))}
              <input name="zone" type="text" placeholder="residential-1"></label>
            <label>${esc(t('brightdataBuilder.country', 'Country'))}
              <select name="country">${COUNTRIES.map(
                ([code, label]) =>
                  `<option value="${esc(code)}">${esc(label)}${code ? ' (' + code + ')' : ''}</option>`,
              ).join('')}</select></label>
            <label>${esc(t('brightdataBuilder.city', 'City (optional)'))}
              <input name="city" type="text" placeholder="new_york"></label>
            <label class="full" style="grid-column: 1 / -1; display:flex; align-items:center; gap:8px;">
              <input name="sticky" type="checkbox" checked>
              <span>${esc(t('brightdataBuilder.sticky', 'Sticky session (same IP until rotated; off = rotating per request)'))}</span>
            </label>
            <label>${esc(t('brightdataBuilder.startSessId', 'Start session #'))}
              <input name="startSessId" type="number" min="1" value="1"></label>
            <label>${esc(t('brightdataBuilder.count', 'How many proxies'))}
              <input name="count" type="number" min="1" max="1000" value="10"></label>
          </form>
          <div class="pm-section-title" style="margin-top:16px;">${esc(t('brightdataBuilder.preview', 'Preview (first 5)'))}</div>
          <div id="bd-preview" class="bd-preview-box"></div>
          <div id="bd-error" class="bd-error" hidden></div>
        </div>
        <footer class="pm-footer">
          <span id="bd-count-hint" class="small"></span>
          <span class="spacer"></span>
          <button id="bd-cancel" type="button">${esc(t('common.cancel', 'Cancel'))}</button>
          <button id="bd-insert" class="primary" type="button" disabled>${esc(t('brightdataBuilder.insert', 'Insert proxies'))}</button>
        </footer>
      </div>
    `
    injectStylesOnce()
    wireEvents(root, deps)
    return root
  }

  function wireEvents(root, deps) {
    root.querySelector('.pm-close').addEventListener('click', close)
    root.querySelector('#bd-cancel').addEventListener('click', close)
    root.addEventListener('click', (ev) => {
      if (ev.target === root) close()
    })
    const form = root.querySelector('#bd-form')
    form.addEventListener('input', () => {
      readFormIntoState(form)
      refreshPreview()
    })
    form.addEventListener('change', () => {
      readFormIntoState(form)
      refreshPreview()
    })
    root.querySelector('#bd-insert').addEventListener('click', () => insert(deps))
  }

  function readFormIntoState(form) {
    state.endpoint = form.endpoint.value.trim()
    state.customer = form.customer.value.trim()
    state.password = form.password.value
    state.zone = form.zone.value.trim()
    state.country = form.country.value
    state.city = form.city.value.trim()
    state.sticky = !!form.sticky.checked
    state.startSessId = Math.max(1, Number(form.startSessId.value) || 1)
    state.count = Math.max(0, Math.min(1000, Number(form.count.value) || 0))
  }

  function refreshPreview() {
    if (!$root) return
    const items = previewGenerate(5)
    const box = $root.querySelector('#bd-preview')
    const hint = $root.querySelector('#bd-count-hint')
    const insertBtn = $root.querySelector('#bd-insert')
    const errBox = $root.querySelector('#bd-error')

    const issues = []
    if (!state.endpoint || !/^[^:]+:\d+$/.test(state.endpoint)) {
      issues.push('Endpoint must be host:port')
    }
    if (!state.customer) issues.push('Customer required')
    if (!state.password) issues.push('Password required')
    if (!state.zone) issues.push('Zone required')
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
      ? `<table class="bd-preview-table">
          <thead><tr><th>#</th><th>Zone</th><th>Sess ID</th><th>Username</th><th>host:port</th></tr></thead>
          <tbody>${items
            .map(
              (it, i) =>
                `<tr><td>${i + 1}</td><td>${esc(it.zone)}</td><td>${esc(it.sessId)}</td><td class="mono">${esc(it.username)}</td><td class="mono">${esc(it.host)}:${esc(it.port)}</td></tr>`,
            )
            .join('')}${
            state.count > items.length
              ? `<tr class="muted-row"><td colspan="5">… and ${state.count - items.length} more</td></tr>`
              : ''
          }</tbody>
        </table>`
      : `<div class="muted">Fill the form to preview generated proxies.</div>`
  }

  async function insert(deps) {
    if (!window.oz || !window.oz.proxies || !window.oz.proxies.expandProvider) return
    const insertBtn = $root.querySelector('#bd-insert')
    insertBtn.disabled = true
    insertBtn.textContent = 'Inserting…'
    const opts = {
      endpoint: state.endpoint,
      customer: state.customer,
      password: state.password,
      zone: state.zone,
      count: state.count,
      sticky: state.sticky,
      startSessId: state.startSessId,
      country: state.country || null,
      city: state.city || null,
    }
    let r = null
    try {
      r = await window.oz.proxies.expandProvider('brightdata', opts)
    } catch (err) {
      r = { __error: { code: 'IPC_THREW', message: err && err.message } }
    }
    if (r && r.__error) {
      const errBox = $root.querySelector('#bd-error')
      errBox.hidden = false
      errBox.textContent = `${r.__error.code}: ${r.__error.message || ''}`
      insertBtn.disabled = false
      insertBtn.textContent = 'Insert proxies'
      return
    }
    window.alert(`✅ Added ${r && r.addedCount} Bright Data proxies to the pool.`)
    close()
    if (deps && typeof deps.refreshDashboard === 'function') {
      try {
        await deps.refreshDashboard()
      } catch (_err) {
        // swallow — dashboard refresh isn't critical, broadcast also triggers it.
      }
    }
  }

  function injectStylesOnce() {
    if (document.getElementById('bd-builder-styles')) return
    const style = document.createElement('style')
    style.id = 'bd-builder-styles'
    style.textContent = `
      .pm-backdrop#bd-builder-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; display: flex; align-items: center; justify-content: center; }
      .pm-backdrop#bd-builder-backdrop .pm-modal { background: var(--panel, #232323); color: var(--text, #e8e8e8); border-radius: 10px; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
      .pm-backdrop#bd-builder-backdrop .pm-header { padding: 14px 18px; border-bottom: 1px solid var(--border, #2e2e2e); display: flex; align-items: center; justify-content: space-between; }
      .pm-backdrop#bd-builder-backdrop .pm-header h2 { margin: 0; font-size: 16px; }
      .pm-backdrop#bd-builder-backdrop .pm-close { background: transparent; color: var(--text-muted, #888); border: 0; font-size: 22px; cursor: pointer; line-height: 1; padding: 2px 8px; }
      .pm-backdrop#bd-builder-backdrop .pm-body { padding: 18px; }
      .pm-backdrop#bd-builder-backdrop .pm-footer { padding: 12px 18px; border-top: 1px solid var(--border, #2e2e2e); display: flex; gap: 8px; align-items: center; }
      .pm-backdrop#bd-builder-backdrop .pm-footer .spacer { flex: 1; }
      .pm-backdrop#bd-builder-backdrop .pm-footer button { padding: 6px 14px; border-radius: 5px; border: 1px solid var(--border, #2e2e2e); background: transparent; color: var(--text, #e8e8e8); cursor: pointer; }
      .pm-backdrop#bd-builder-backdrop .pm-footer button.primary { background: var(--accent, #7c5fbf); border-color: var(--accent, #7c5fbf); color: white; }
      .pm-backdrop#bd-builder-backdrop .pm-footer button:disabled { opacity: 0.4; cursor: not-allowed; }
      .pm-backdrop#bd-builder-backdrop label { display: flex; flex-direction: column; font-size: 12px; color: var(--text-muted, #888); gap: 4px; }
      .pm-backdrop#bd-builder-backdrop input, .pm-backdrop#bd-builder-backdrop select { background: var(--bg, #1a1a1a); color: var(--text, #e8e8e8); border: 1px solid var(--border, #2e2e2e); border-radius: 4px; padding: 5px 8px; font-size: 13px; }
      .pm-backdrop#bd-builder-backdrop .pm-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted, #888); }
      .pm-backdrop#bd-builder-backdrop .bd-preview-box { margin-top: 8px; max-height: 240px; overflow: auto; border: 1px solid var(--border, #2e2e2e); border-radius: 6px; padding: 6px; background: var(--bg, #1a1a1a); }
      .pm-backdrop#bd-builder-backdrop .bd-preview-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .pm-backdrop#bd-builder-backdrop .bd-preview-table th { color: var(--text-muted, #888); padding: 4px 6px; text-align: left; font-weight: 600; }
      .pm-backdrop#bd-builder-backdrop .bd-preview-table td { padding: 3px 6px; border-top: 1px solid var(--border, #2e2e2e); }
      .pm-backdrop#bd-builder-backdrop .bd-preview-table td.mono { font-family: ui-monospace, monospace; font-size: 10px; word-break: break-all; }
      .pm-backdrop#bd-builder-backdrop .bd-preview-table tr.muted-row td { color: var(--text-muted, #888); font-style: italic; text-align: center; }
      .pm-backdrop#bd-builder-backdrop .bd-error { margin-top: 8px; padding: 8px 12px; background: rgba(239, 68, 68, 0.12); color: var(--red, #ef4444); border-radius: 6px; font-size: 12px; }
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

  window.OZ_BrightDataBuilder = { open, close, previewGenerate, COUNTRIES }
})()
