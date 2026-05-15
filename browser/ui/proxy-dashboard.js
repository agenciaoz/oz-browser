// OZ Browser — Proxy Health Dashboard controller (H-2b, v1.1.1).
//
// Fetcheo + render del dashboard tab. Read-only en 1.1.1 — acciones llegan
// en H-2c (1.1.2).

;(function () {
  const PAGE_SIZE = 25

  const state = {
    data: null,
    identities: {
      search: '',
      sortKey: 'name',
      sortDir: 'asc',
      page: 0,
    },
    proxies: {
      search: '',
      sortKey: 'name',
      sortDir: 'asc',
      page: 0,
    },
  }
  // H-2e: alerts section is owned by proxy-dashboard-alerts.js (LOC budget).
  const alertsApi = window.OZ_DashboardAlerts
  // H-2f: bulk multi-select + bulk actions owned by proxy-dashboard-bulk.js.
  const bulkApi = window.OZ_DashboardBulk

  // ---------------- helpers ----------------
  function fmtAgo(ts) {
    if (!ts) return '—'
    const d = Date.now() - ts
    if (d < 60 * 1000) return Math.round(d / 1000) + 's ago'
    if (d < 60 * 60 * 1000) return Math.round(d / 60000) + 'm ago'
    if (d < 24 * 60 * 60 * 1000) return Math.round(d / 3600000) + 'h ago'
    return Math.round(d / 86400000) + 'd ago'
  }
  function fmtCountry(c) {
    if (!c) return '—'
    return String(c).toUpperCase()
  }
  function fmtMs(ms) {
    if (ms == null) return '—'
    return Math.round(ms) + 'ms'
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
  function t(key, fallback) {
    const tt = window.OZ && window.OZ.t
    if (!tt) return fallback || key
    const v = tt(key)
    if (!v || v === key) return fallback || key
    return v
  }

  // ---------------- fetch ----------------
  async function fetchData(forceTest) {
    if (!window.oz || !window.oz.proxyHealth) return null
    try {
      const data = forceTest
        ? await window.oz.proxyHealth
            .testAllAndStatus()
            .then(() => window.oz.proxyHealth.getDashboard())
        : await window.oz.proxyHealth.getDashboard()
      state.data = data
      return data
    } catch (_e) {
      return null
    }
  }

  // H-2e: delegated to proxy-dashboard-alerts.js
  const fetchAlerts = () => (alertsApi ? alertsApi.fetch() : Promise.resolve([]))

  // ---------------- render hero ----------------
  function renderHero() {
    const d = state.data
    const dot = document.getElementById('hero-dot')
    const hint = document.getElementById('hero-hint')
    if (!d || !d.globalStatus) {
      dot.dataset.status = 'gray'
      hint.textContent = t('proxyDashboard.unavailable', 'Status unavailable')
      return
    }
    const gs = d.globalStatus
    dot.dataset.status = gs.status
    const c = gs.counts || {}
    hint.textContent =
      (gs.hint || '') +
      `  ·  ${c.ok || 0}/${c.total || 0} healthy  ·  ` +
      (c.unassigned ? `${c.unassigned} unassigned identities  ·  ` : '') +
      (gs.lastTestedAt
        ? t('proxyDashboard.lastScan', 'last scan') + ': ' + fmtAgo(gs.lastTestedAt)
        : t('proxyDashboard.neverTested', 'never tested'))
  }

  // H-2e: delegated to proxy-dashboard-alerts.js
  const renderAlerts = () => alertsApi && alertsApi.render({ esc, fmtAgo, t })

  // ---------------- table renderers ----------------
  function applyFilterSort(list, view, fieldsForSearch) {
    let arr = list
    if (view.search) {
      const q = view.search.toLowerCase()
      arr = arr.filter((row) =>
        fieldsForSearch.some((f) => {
          const v = typeof f === 'function' ? f(row) : row[f]
          return v && String(v).toLowerCase().includes(q)
        }),
      )
    }
    const dir = view.sortDir === 'desc' ? -1 : 1
    arr = arr.slice().sort((a, b) => {
      const av = a[view.sortKey]
      const bv = b[view.sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return arr
  }

  function renderIdentities() {
    const tbody = document.getElementById('ident-tbody')
    const empty = document.getElementById('ident-empty')
    const pagerLbl = document.getElementById('ident-pager')
    const countEl = document.getElementById('ident-count')
    const prev = document.getElementById('ident-prev')
    const next = document.getElementById('ident-next')
    const data = (state.data && state.data.identities) || []
    // Decorate rows with derived fields for sorting/filtering.
    const decorated = data.map((i) => ({
      ...i,
      proxyName: i.proxy ? i.proxy.name : '',
      country: i.proxy ? i.proxy.country : '',
      status: i.leakRisk ? 'red' : i.proxy ? 'green' : 'gray',
    }))
    const filtered = applyFilterSort(decorated, state.identities, [
      'name',
      'workspaceName',
      'proxyName',
      'country',
    ])
    countEl.textContent = String(filtered.length)
    const total = filtered.length
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (state.identities.page >= pages) state.identities.page = pages - 1
    if (state.identities.page < 0) state.identities.page = 0
    const start = state.identities.page * PAGE_SIZE
    const end = Math.min(total, start + PAGE_SIZE)
    const slice = filtered.slice(start, end)
    if (total === 0) {
      tbody.innerHTML = ''
      empty.hidden = false
      pagerLbl.textContent = '0–0 of 0'
      prev.disabled = true
      next.disabled = true
      return
    }
    empty.hidden = true
    if (bulkApi)
      bulkApi.setVisibleIds(
        'ident',
        slice.map((i) => i.id),
      )
    const proxyOptions = (state.data && state.data.proxies) || []
    tbody.innerHTML = slice
      .map((i) => {
        const cb = bulkApi ? bulkApi.rowCheckboxHtml('ident', i.id) : ''
        const proxyCell = i.proxy
          ? `${esc(i.proxy.name || '?')} <span class="small">${esc(
              i.proxy.host,
            )}:${esc(i.proxy.port)}</span>`
          : `<span class="leak-flag">${t('proxyDashboard.noProxy', 'No proxy — leak risk')}</span>`
        const isDefault = i.isDefault
        const reassignOpts = [
          `<option value="(none)">${t('proxyDashboard.actions.none', 'None')}</option>`,
          `<option value="auto-random">${t('proxyDashboard.actions.autoRandom', 'auto-random')}</option>`,
          `<option value="auto-round-robin">${t('proxyDashboard.actions.autoRoundRobin', 'auto-round-robin')}</option>`,
          ...proxyOptions.map(
            (p) =>
              `<option value="${esc(p.id)}"${
                i.proxy && i.proxy.id === p.id ? ' selected' : ''
              }>${esc(p.name)} (${esc(p.country || '—')})</option>`,
          ),
        ].join('')
        const actions = isDefault
          ? `<span class="small">${t('proxyDashboard.actions.defaultIdent', 'default — n/a')}</span>`
          : `<div class="row-actions">
            <button class="primary" data-act="reload" data-id="${esc(i.id)}" title="Re-apply assigned proxy on current session">↻ ${t('proxyDashboard.actions.reload', 'Reload')}</button>
            <select class="reassign-select" data-act="reassign" data-id="${esc(i.id)}">${reassignOpts}</select>
          </div>`
        return `<tr>
        <td class="bulk-cb-col">${cb}</td>
        <td class="nowrap"><strong>${esc(i.name)}</strong>${isDefault ? ' <span class="small">(default)</span>' : ''}</td>
        <td class="nowrap">${esc(i.workspaceName)}</td>
        <td>${proxyCell}</td>
        <td class="nowrap">${fmtCountry(i.country)}</td>
        <td><span class="pill" data-status="${i.status}">${i.status}</span></td>
        <td>${actions}</td>
      </tr>`
      })
      .join('')
    pagerLbl.textContent = `${start + 1}–${end} of ${total}`
    prev.disabled = state.identities.page === 0
    next.disabled = end >= total
    if (bulkApi) bulkApi.syncActionBar('ident', t)
  }

  function renderProxies() {
    const tbody = document.getElementById('proxy-tbody')
    const empty = document.getElementById('proxy-empty')
    const pagerLbl = document.getElementById('proxy-pager')
    const countEl = document.getElementById('proxy-count')
    const prev = document.getElementById('proxy-prev')
    const next = document.getElementById('proxy-next')
    const data = (state.data && state.data.proxies) || []
    const decorated = data.map((p) => ({
      ...p,
      hostPort: `${p.host}:${p.port}`,
    }))
    const filtered = applyFilterSort(decorated, state.proxies, [
      'name',
      'label',
      'hostPort',
      'country',
      (r) => (r.tags || []).join(' '),
    ])
    countEl.textContent = String(filtered.length)
    const total = filtered.length
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (state.proxies.page >= pages) state.proxies.page = pages - 1
    if (state.proxies.page < 0) state.proxies.page = 0
    const start = state.proxies.page * PAGE_SIZE
    const end = Math.min(total, start + PAGE_SIZE)
    const slice = filtered.slice(start, end)
    if (total === 0) {
      tbody.innerHTML = ''
      empty.hidden = false
      pagerLbl.textContent = '0–0 of 0'
      prev.disabled = true
      next.disabled = true
      return
    }
    empty.hidden = true
    if (bulkApi)
      bulkApi.setVisibleIds(
        'proxy',
        slice.map((p) => p.id),
      )
    tbody.innerHTML = slice
      .map((p) => {
        const cb = bulkApi ? bulkApi.rowCheckboxHtml('proxy', p.id) : ''
        const stickyBtn =
          p.protocol && p.protocol !== 'socks5'
            ? `<button data-act="rotate" data-id="${esc(p.id)}" title="${t('proxyDashboard.actions.rotateTooltip', 'Rotate sticky session-id in username (Oxylabs format)')}">${t('proxyDashboard.actions.rotate', 'Rotate')}</button>`
            : ''
        const disableBtn = p.isDisabled
          ? `<button data-act="enable" data-id="${esc(p.id)}">${t('proxyDashboard.actions.enable', 'Enable')}</button>`
          : `<button data-act="disable" data-id="${esc(p.id)}">${t('proxyDashboard.actions.disable', 'Disable')}</button>`
        const actions = `<div class="row-actions">
          <button class="primary" data-act="test" data-id="${esc(p.id)}">${t('proxyDashboard.actions.test', 'Test')}</button>
          <button data-act="reset" data-id="${esc(p.id)}">${t('proxyDashboard.actions.reset', 'Reset')}</button>
          ${disableBtn}
          ${stickyBtn}
          <button class="danger" data-act="delete" data-id="${esc(p.id)}">${t('proxyDashboard.actions.delete', 'Delete')}</button>
        </div>`
        return `<tr>
        <td class="bulk-cb-col">${cb}</td>
        <td class="nowrap"><strong>${esc(p.name)}</strong>${
          p.label ? ` <span class="small">${esc(p.label)}</span>` : ''
        }</td>
        <td class="nowrap">${esc(p.hostPort)} <span class="small">${esc(p.protocol || '')}</span></td>
        <td class="nowrap">${fmtCountry(p.country)}</td>
        <td>${p.usedByCount} <span class="small">${p.usedByCount > 0 ? esc(p.usedBy.map((u) => u.name).join(', ')) : ''}</span></td>
        <td><span class="pill" data-status="${p.status}">${p.status}</span>${
          p.isDisabled ? ' <span class="small">disabled</span>' : ''
        }</td>
        <td class="nowrap">${fmtAgo(p.lastTestedAt)}</td>
        <td class="nowrap">${fmtMs(p.lastLatencyMs)}</td>
        <td>${actions}</td>
      </tr>`
      })
      .join('')
    pagerLbl.textContent = `${start + 1}–${end} of ${total}`
    prev.disabled = state.proxies.page === 0
    next.disabled = end >= total
    if (bulkApi) bulkApi.syncActionBar('proxy', t)
  }

  // H-2f: single-row action handler extracted to proxy-dashboard-actions.js
  const actionsApi = window.OZ_DashboardActions
  function performAction(act, id, el) {
    if (!actionsApi) return
    return actionsApi.performAction(act, id, el, {
      t,
      fetchData,
      renderAll,
      fetchAlerts,
      renderAlerts,
      alertsApi,
    })
  }

  // ---------------- wire UI events ----------------
  function wire() {
    document.getElementById('btn-refresh').addEventListener('click', async () => {
      await Promise.all([fetchData(false), fetchAlerts()])
      renderAll()
    })

    // H-2e: dismiss-all delegated to proxy-dashboard-alerts.js
    if (alertsApi) {
      alertsApi.wireDismissAll({
        t,
        refresh: async () => {
          await fetchAlerts()
          renderAlerts()
        },
      })
    }
    document.getElementById('btn-test-all').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget
      btn.disabled = true
      btn.textContent = t('proxyDashboard.testing', 'Testing…')
      try {
        await fetchData(true)
      } finally {
        btn.disabled = false
        btn.textContent = t('proxyDashboard.testAll', 'Test all now')
      }
      renderAll()
    })

    // Identities table
    const iSearch = document.getElementById('ident-search')
    iSearch.addEventListener('input', () => {
      state.identities.search = iSearch.value
      state.identities.page = 0
      renderIdentities()
    })
    document.getElementById('ident-prev').addEventListener('click', () => {
      if (state.identities.page > 0) {
        state.identities.page--
        renderIdentities()
      }
    })
    document.getElementById('ident-next').addEventListener('click', () => {
      state.identities.page++
      renderIdentities()
    })
    document
      .querySelectorAll('section.card:nth-of-type(1) thead th[data-sort]')
      .forEach((th) => {
        th.addEventListener('click', () => {
          const k = th.dataset.sort
          if (state.identities.sortKey === k) {
            state.identities.sortDir = state.identities.sortDir === 'asc' ? 'desc' : 'asc'
          } else {
            state.identities.sortKey = k
            state.identities.sortDir = 'asc'
          }
          renderIdentities()
        })
      })

    // Proxies table
    const pSearch = document.getElementById('proxy-search')
    pSearch.addEventListener('input', () => {
      state.proxies.search = pSearch.value
      state.proxies.page = 0
      renderProxies()
    })
    document.getElementById('proxy-prev').addEventListener('click', () => {
      if (state.proxies.page > 0) {
        state.proxies.page--
        renderProxies()
      }
    })
    document.getElementById('proxy-next').addEventListener('click', () => {
      state.proxies.page++
      renderProxies()
    })
    document
      .querySelectorAll('section.card:nth-of-type(2) thead th[data-sort]')
      .forEach((th) => {
        th.addEventListener('click', () => {
          const k = th.dataset.sort
          if (state.proxies.sortKey === k) {
            state.proxies.sortDir = state.proxies.sortDir === 'asc' ? 'desc' : 'asc'
          } else {
            state.proxies.sortKey = k
            state.proxies.sortDir = 'asc'
          }
          renderProxies()
        })
      })
  }

  function renderAll() {
    renderHero()
    renderAlerts()
    renderIdentities()
    renderProxies()
  }

  function wireActionDelegation() {
    // Delegated click handler for action buttons in either table.
    document.body.addEventListener('click', (ev) => {
      const tt = ev.target
      if (!tt || !tt.dataset || !tt.dataset.act) return
      const act = tt.dataset.act
      // H-2f: bulk actions handled by the bulk module first.
      if (bulkApi) {
        const handled = bulkApi.handleDelegatedClick(ev, {
          t,
          rerender: () => {
            renderIdentities()
            renderProxies()
          },
          refreshDashboard: async () => {
            await fetchData(false)
            renderAll()
          },
        })
        if (handled) return
      }
      if (act === 'bulk-deselect-ident') {
        bulkApi && bulkApi.clearSelection('ident')
        renderIdentities()
        return
      }
      if (act === 'bulk-deselect-proxy') {
        bulkApi && bulkApi.clearSelection('proxy')
        renderProxies()
        return
      }
      const id = tt.dataset.id
      if (!id) return
      performAction(act, id, tt)
    })
    // Delegated change handler for reassign selects.
    document.body.addEventListener('change', (ev) => {
      const t = ev.target
      if (!t || !t.dataset || t.dataset.act !== 'reassign') return
      const id = t.dataset.id
      if (!id) return
      performAction('reassign-set', id, t)
    })
  }

  async function start() {
    wire()
    wireActionDelegation()
    await Promise.all([fetchData(false), fetchAlerts()])
    renderAll()
    // Auto-refresh every 30s while tab is visible — both dashboard data and alerts.
    setInterval(async () => {
      if (document.hidden) return
      await Promise.all([fetchData(false), fetchAlerts()])
      renderAll()
    }, 30 * 1000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
