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
  // H-2i: anti-detect coherence overlays owned by proxy-dashboard-health.js.
  const healthApi = window.OZ_DashboardHealth
  // Keyed by identityId; populated by fetchHealth(), consumed by renderIdentities().
  let healthMap = new Map()
  // H-2j: WebRTC + DNS leak test overlays owned by proxy-dashboard-leaks.js.
  const leaksApi = window.OZ_DashboardLeaks
  let leakMap = new Map()

  // ---------------- helpers ----------------
  // Shared utils (fmtAgo, fmtCountry, fmtMs, esc, t) moved to
  // proxy-dashboard-utils.js for LOC budget compliance (ADR 0005). Fall
  // back to defensive no-ops if the script load order ever drifts.
  const utils = window.OZ_DashboardUtils || {}
  const fmtAgo = utils.fmtAgo || ((ts) => (ts ? String(ts) : '—'))
  const fmtCountry = utils.fmtCountry || ((c) => String(c || '—').toUpperCase())
  const fmtMs = utils.fmtMs || ((ms) => (ms == null ? '—' : Math.round(ms) + 'ms'))
  const esc = utils.esc || ((s) => String(s == null ? '' : s))
  const t = utils.t || ((k, f) => f || k)

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

  // H-2i: delegated to proxy-dashboard-health.js
  async function fetchHealth() {
    if (!healthApi) return
    healthMap = await healthApi.fetchHealthMap()
  }

  // H-2j: hydrate cached leak-test records (no fresh runs — user triggers).
  async function fetchLeaks() {
    if (!leaksApi) return
    leakMap = await leaksApi.fetchLeakMap()
  }

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
    // Decorate rows with derived fields for sorting/filtering. H-2i: status
    // now derives from anti-detect health overall (worst of 4 vectors) when
    // available, falling back to legacy leakRisk-only logic.
    const decorated = data.map((i) => {
      const hr = healthMap.get(i.id) || null
      return {
        ...i,
        proxyName: i.proxy ? i.proxy.name : '',
        country: i.proxy ? i.proxy.country : '',
        status: healthApi
          ? healthApi.deriveStatus(i, hr)
          : i.leakRisk
            ? 'red'
            : i.proxy
              ? 'green'
              : 'gray',
        _healthRecord: hr,
      }
    })
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
        // alpha.108: cell builders viven en proxy-dashboard-utils.js (LOC).
        const { proxyCell, reassignOpts } = utils.buildIdentityRowBits(i, proxyOptions)
        const isDefault = i.isDefault
        // H-2i: inline "Apply geo" button surfaces when ipTimezone vector
        // is yellow/red AND its fix kind is APPLY_GEO. Hidden for default
        // identity (no proxy to copy geo from).
        const fixBtn = healthApi
          ? healthApi.renderFixButton(i, i._healthRecord, t, esc)
          : ''
        // H-2j: "Leak test" button + last-result badge.
        const leakBtn = leaksApi
          ? leaksApi.renderLeakButton(i, leakMap.get(i.id), t, esc)
          : ''
        // alpha.108: la identity Default SÍ es reasignable (el boot managed
        // le auto-asigna proxy; el user puede elegir 'direct' para navegar
        // rápido en su browsing diario). Solo se ocultan fix/leak.
        const actions = isDefault
          ? `<div class="row-actions">
            <button class="primary" data-act="reload" data-id="${esc(i.id)}" title="Re-apply assigned proxy on current session">↻ ${t('proxyDashboard.actions.reload', 'Reload')}</button>
            <select class="reassign-select" data-act="reassign" data-id="${esc(i.id)}">${reassignOpts}</select>
          </div>`
          : `<div class="row-actions">
            ${fixBtn}
            <button class="primary" data-act="reload" data-id="${esc(i.id)}" title="Re-apply assigned proxy on current session">↻ ${t('proxyDashboard.actions.reload', 'Reload')}</button>
            ${leakBtn}
            <select class="reassign-select" data-act="reassign" data-id="${esc(i.id)}">${reassignOpts}</select>
          </div>`
        // H-2i: tooltip on the status pill surfaces the worst vector summary
        // so users can see WHY a row is yellow/red without opening a modal.
        const statusTitle = healthApi
          ? healthApi.buildStatusSummary(i._healthRecord, t)
          : null
        const pillTitleAttr = statusTitle ? ` title="${esc(statusTitle)}"` : ''
        return `<tr>
        <td class="bulk-cb-col">${cb}</td>
        <td class="nowrap"><strong>${esc(i.name)}</strong>${isDefault ? ' <span class="small">(default)</span>' : ''}</td>
        <td class="nowrap">${esc(i.workspaceName)}</td>
        <td>${proxyCell}</td>
        <td class="nowrap">${fmtCountry(i.country)}</td>
        <td><span class="pill" data-status="${i.status}"${pillTitleAttr}>${i.status}</span></td>
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
      await Promise.all([fetchData(false), fetchAlerts(), fetchHealth(), fetchLeaks()])
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
    // H-2g: + Import button → modal
    const btnImport = document.getElementById('btn-import')
    if (btnImport && window.OZ_DashboardImport) {
      btnImport.addEventListener('click', () =>
        window.OZ_DashboardImport.open({
          t,
          refreshDashboard: async () => {
            await fetchData(false)
            renderAll()
          },
        }),
      )
    }
    // H-2 extras (v1.1.6): export-diag + H-2k (v1.1.5): oxylabs builder.
    if (window.OZ_DashboardExport) {
      window.OZ_DashboardExport.wire(document.getElementById('btn-export-diag'), t)
    }
    const btnOxylabs = document.getElementById('btn-oxylabs')
    if (btnOxylabs && window.OZ_OxylabsBuilder) {
      btnOxylabs.addEventListener('click', () =>
        window.OZ_OxylabsBuilder.open({
          t,
          refreshDashboard: async () => {
            await fetchData(false)
            renderAll()
          },
        }),
      )
    }
    // H-2h: Bulk assign button → modal (placeholder until H-2h closes)
    const btnBulkAssign = document.getElementById('btn-bulk-assign')
    if (btnBulkAssign) {
      btnBulkAssign.addEventListener('click', () => {
        if (window.OZ_BulkAssign) {
          window.OZ_BulkAssign.open({
            t,
            refreshDashboard: async () => {
              await fetchData(false)
              renderAll()
            },
          })
        }
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
      // v1.6.7 fix: reassign-select <select> elements are handled by the
      // delegated 'change' listener below, not 'click'. If we let the click
      // path run, performAction() unconditionally sets el.disabled = true,
      // which Chromium interprets as "cancel the dropdown open" — net result:
      // the user clicks the dropdown and nothing visible happens, while the
      // select becomes silently disabled (greyed out).
      if (tt.tagName === 'SELECT') return
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
    await Promise.all([fetchData(false), fetchAlerts(), fetchHealth(), fetchLeaks()])
    renderAll()
    // H-2i: subscribe to live health-changed broadcasts. ApplyFix from
    // anywhere (health-modal, sidebar, MCP, our inline button) re-fetches
    // the map and re-renders without waiting for the 30s poll.
    if (healthApi) {
      healthApi.subscribeChanged(async () => {
        await fetchHealth()
        renderIdentities()
      })
    }
    // H-2j: subscribe to leak-test broadcasts (run/clear). Same pattern.
    if (leaksApi) {
      leaksApi.subscribeChanged(async () => {
        await fetchLeaks()
        renderIdentities()
      })
    }
    // Auto-refresh every 30s while tab is visible — dashboard data,
    // alerts, health records, leak-test cache.
    setInterval(async () => {
      if (document.hidden) return
      await Promise.all([fetchData(false), fetchAlerts(), fetchHealth(), fetchLeaks()])
      renderAll()
    }, 30 * 1000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
