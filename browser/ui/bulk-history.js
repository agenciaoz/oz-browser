// OZ Browser — Bulk Run History dashboard UI (Etapa 4.1+4.3+4.5).
// Modal con list + detail (filtros / sort / drill-down / retry / CSV export).
// Backend cero — consume oz.bulk.list/get desde alpha.1.
// Pure helpers → bulk-history-helpers.js. Actions (retry+export) →
// bulk-history-actions.js. Cargar ambos ANTES que este file en webui.html.
// ADR: docs/architecture/0032-bulk-history-dashboard.md

;(function () {
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  function _escapeHtml(s) {
    if (s == null) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  const ERROR_CODE_EXPLAIN =
    (window.OZ &&
      window.OZ.bulkRunnerCodes &&
      window.OZ.bulkRunnerCodes.ERROR_CODE_EXPLAIN) ||
    {}

  // Helpers from sibling module. Defensive no-op fallback if loader order breaks.
  const helpers = (window.OZ && window.OZ.bulkHistoryHelpers) || {
    filterRuns: (rows) => rows || [],
    sortRuns: (rows) => rows || [],
    buildStats: () => ({ total: 0, completed: 0, failed: 0, cancelled: 0, running: 0 }),
    buildFilterOptions: () => ({ actions: [], identities: [] }),
  }

  function _formatDate(iso) {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  const PILL_CLS = {
    created: 'oz-bh-pill-created',
    running: 'oz-bh-pill-running',
    cancelling: 'oz-bh-pill-running',
    completed: 'oz-bh-pill-completed',
    failed: 'oz-bh-pill-failed',
    cancelled: 'oz-bh-pill-cancelled',
  }
  function _statusPill(status) {
    const cls = PILL_CLS[status] || ''
    const label = status ? t(`bulkHistory.status.${status}`) : '—'
    return `<span class="oz-bh-pill ${cls}">${_escapeHtml(label)}</span>`
  }

  const DEFAULT_LIMIT = 100

  class BulkHistoryUI {
    constructor() {
      this.$modal = document.getElementById('oz-bh-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/bulk-history', 'modal markup missing')
        }
        return
      }
      // DOM refs — names mirror the markup ids in webui.html. The 4.3
      // entries (retry*) and 4.5 entries (export*) live alongside the
      // 4.1 ones below.
      const $ = (id) => document.getElementById(id)
      this.$list = $('oz-bh-list')
      this.$detail = $('oz-bh-detail')
      this.$tableBody = $('oz-bh-table-body')
      this.$empty = $('oz-bh-empty')
      this.$statsBar = $('oz-bh-stats')
      this.$filterStatus = $('oz-bh-filter-status')
      this.$filterAction = $('oz-bh-filter-action')
      this.$filterIdentity = $('oz-bh-filter-identity')
      this.$filterDate = $('oz-bh-filter-date')
      this.$filterSearch = $('oz-bh-filter-search')
      this.$sort = $('oz-bh-sort')
      this.$refresh = $('oz-bh-refresh')
      this.$detailHeader = $('oz-bh-detail-header')
      this.$detailBody = $('oz-bh-detail-body')
      this.$detailBack = $('oz-bh-detail-back')
      this.$shownCount = $('oz-bh-shown-count')
      this.$retryBar = $('oz-bh-retry-bar')
      this.$retryFailed = $('oz-bh-retry-failed')
      this.$retrySelected = $('oz-bh-retry-selected')
      this.$retryHint = $('oz-bh-retry-hint')
      this.$retryError = $('oz-bh-retry-error')
      this.$checkAll = $('oz-bh-check-all')
      this.$exportList = $('oz-bh-export-list')
      this.$exportDetail = $('oz-bh-export-detail')

      this._currentDetailRun = null // {meta, items} of currently-rendered detail
      this._allRuns = [] // [{meta, items?}]
      this._enrichedItems = new Map() // runId → items[] cache
      this._filters = {
        status: 'all',
        actionId: 'all',
        identityId: 'all',
        dateRange: 'all',
        search: '',
      }
      this._sort = 'newest'
      this._unsubs = []

      this._wireEvents()
      this._wireLiveUpdates()

      window.OZ = window.OZ || {}
      window.OZ.bulkHistoryUI = this
    }

    _wireEvents() {
      this.$modal.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', () => this.close())
      })
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.$modal.hidden) this.close()
      })
      const onFilter = async () => {
        const prevIdentity = this._filters.identityId
        this._filters.status = this.$filterStatus.value
        this._filters.actionId = this.$filterAction.value
        this._filters.identityId = this.$filterIdentity.value
        this._filters.dateRange = this.$filterDate.value
        this._filters.search = this.$filterSearch.value || ''
        // Identity filter requires items to be hydrated. Lazy-load on switch.
        if (
          this._filters.identityId !== 'all' &&
          prevIdentity !== this._filters.identityId
        ) {
          await this._hydrateItemsForAll()
        }
        this._renderList()
      }
      ;[
        this.$filterStatus,
        this.$filterAction,
        this.$filterIdentity,
        this.$filterDate,
      ].forEach((el) => el && el.addEventListener('change', onFilter))
      if (this.$filterSearch) {
        this.$filterSearch.addEventListener('input', onFilter)
      }
      if (this.$sort) {
        this.$sort.addEventListener('change', () => {
          this._sort = this.$sort.value
          this._renderList()
        })
      }
      // Simple click → method bindings.
      const simpleClicks = [
        [this.$refresh, () => this.reload()],
        [this.$detailBack, () => this._showList()],
        [this.$retryFailed, () => this._retryFailedItems()],
        [this.$retrySelected, () => this._retrySelectedItems()],
        [this.$exportList, () => _actions().exportListCsv(this)],
        [this.$exportDetail, () => _actions().exportDetailCsv(this)],
      ]
      for (const [el, fn] of simpleClicks) {
        if (el) el.addEventListener('click', fn)
      }
      if (this.$tableBody) {
        // Row-retry must check BEFORE the View btn — both share the cell.
        this.$tableBody.addEventListener('click', (e) => {
          const retryBtn = e.target.closest('button[data-retry-runid]')
          if (retryBtn) {
            e.stopPropagation()
            this._retryRowFromList(retryBtn.getAttribute('data-retry-runid'))
            return
          }
          const btn = e.target.closest('button[data-runid]')
          if (btn) this._openDetail(btn.getAttribute('data-runid'))
        })
      }
      if (this.$checkAll) {
        this.$checkAll.addEventListener('change', () => {
          if (!this.$detailBody) return
          const checked = this.$checkAll.checked
          this.$detailBody
            .querySelectorAll('input[type="checkbox"][data-identity]')
            .forEach((cb) => {
              if (!cb.disabled) cb.checked = checked
            })
          this._updateRetrySelectedButton()
        })
      }
      if (this.$detailBody) {
        this.$detailBody.addEventListener('change', (e) => {
          if (e.target.closest('input[type="checkbox"][data-identity]')) {
            this._updateRetrySelectedButton()
          }
        })
      }
    }

    _wireLiveUpdates() {
      const bulk = window.oz && window.oz.bulk
      if (!bulk) return
      const onChange = () => {
        if (!this.$modal.hidden) this.reload({ silent: true })
      }
      for (const evt of ['onCreated', 'onStarted', 'onCompleted']) {
        if (bulk[evt]) this._unsubs.push(bulk[evt](onChange))
      }
    }

    async open() {
      this.$modal.hidden = false
      this._showList()
      await this.reload()
    }

    close() {
      this.$modal.hidden = true
    }

    async reload({ silent = false } = {}) {
      if (!window.oz || !window.oz.bulk || !window.oz.bulk.list) {
        if (!silent && this.$empty) {
          this.$empty.textContent = t('bulkHistory.noBackend')
          this.$empty.hidden = false
        }
        return
      }
      const rows = await Promise.resolve(window.oz.bulk.list()).catch(() => [])
      this._allRuns = (rows || []).map((meta) => {
        const cached = this._enrichedItems.get(meta.runId)
        return { meta, items: cached || null }
      })
      if (this._filters.identityId && this._filters.identityId !== 'all') {
        await this._hydrateItemsForAll()
      }
      this._populateFilterDropdowns()
      this._renderList()
    }

    async _hydrateItemsForAll() {
      const tasks = this._allRuns
        .filter((r) => !r.items)
        .map(async (r) => {
          if (this._enrichedItems.has(r.meta.runId)) {
            r.items = this._enrichedItems.get(r.meta.runId)
            return
          }
          const full = await Promise.resolve(window.oz.bulk.get(r.meta.runId)).catch(
            () => null,
          )
          const items = (full && full.items) || []
          this._enrichedItems.set(r.meta.runId, items)
          r.items = items
        })
      await Promise.all(tasks)
    }

    _populateFilterDropdowns() {
      if (!this.$filterAction || !this.$filterIdentity) return
      const { actions, identities } = helpers.buildFilterOptions(this._allRuns)
      const renderOpts = (sel, items, getId, getLabel) => {
        const current = sel.value
        sel.innerHTML = ''
        const allOpt = document.createElement('option')
        allOpt.value = 'all'
        allOpt.textContent = t('bulkHistory.filterAllOption')
        sel.appendChild(allOpt)
        for (const it of items) {
          const opt = document.createElement('option')
          opt.value = getId(it)
          opt.textContent = getLabel(it)
          sel.appendChild(opt)
        }
        sel.value = items.some((it) => getId(it) === current) ? current : 'all'
      }
      renderOpts(
        this.$filterAction,
        actions,
        (a) => a.id,
        (a) => a.label,
      )
      renderOpts(
        this.$filterIdentity,
        identities,
        (i) => i.id,
        (i) => i.name,
      )
    }

    _renderList() {
      const filtered = helpers.filterRuns(this._allRuns, this._filters)
      const sorted = helpers.sortRuns(filtered, this._sort)
      const stats = helpers.buildStats(this._allRuns)
      if (this.$statsBar) {
        this.$statsBar.textContent = t('bulkHistory.statsLine', {
          total: stats.total,
          completed: stats.completed,
          failed: stats.failed,
          cancelled: stats.cancelled,
          running: stats.running,
        })
      }
      const shown = sorted.slice(0, DEFAULT_LIMIT)
      if (this.$shownCount) {
        if (sorted.length > DEFAULT_LIMIT) {
          this.$shownCount.textContent = t('bulkHistory.showingCount', {
            shown: shown.length,
            total: sorted.length,
          })
          this.$shownCount.hidden = false
        } else {
          this.$shownCount.hidden = true
        }
      }
      if (shown.length === 0) {
        this.$tableBody.innerHTML = ''
        if (this.$empty) {
          this.$empty.textContent =
            this._allRuns.length === 0
              ? t('bulkHistory.emptyNoRuns')
              : t('bulkHistory.emptyFiltered')
          this.$empty.hidden = false
        }
        return
      }
      if (this.$empty) this.$empty.hidden = true
      this.$tableBody.innerHTML = shown.map((row) => this._renderRow(row)).join('')
    }

    _renderRow(row) {
      const meta = row.meta
      const s = meta.stats || { done: 0, failed: 0, skipped: 0, cancelled: 0 }
      const statsInline =
        `<span class="oz-bh-mini oz-bh-mini-done">${s.done || 0}✓</span>` +
        `<span class="oz-bh-mini oz-bh-mini-failed">${s.failed || 0}✗</span>` +
        `<span class="oz-bh-mini oz-bh-mini-skipped">${s.skipped || 0}⤲</span>` +
        `<span class="oz-bh-mini oz-bh-mini-cancelled">${s.cancelled || 0}⊘</span>`
      const dateCell = _formatDate(meta.createdAt)
      const actionCell = _escapeHtml(meta.actionLabel || meta.actionId || '—')
      const countCell = meta.identityCount != null ? meta.identityCount : '—'
      const viewLabel = _escapeHtml(t('bulkHistory.viewBtn'))
      // Row-level retry button (Etapa 4.3): only shown for terminal runs
      // with at least one failed item.
      const TERMINAL = helpers.TERMINAL_RUN_STATUSES || new Set()
      const canRetry = (s.failed || 0) > 0 && TERMINAL.has(meta.status)
      const retryBtn = canRetry
        ? `<button type="button" class="oz-bh-row-retry" data-retry-runid="${_escapeHtml(meta.runId)}" title="${_escapeHtml(t('bulkHistory.retry.rowTitle'))}">${_escapeHtml(t('bulkHistory.retry.rowBtn'))}</button>`
        : ''
      return (
        `<tr>` +
        `<td class="oz-bh-cell-date">${_escapeHtml(dateCell)}</td>` +
        `<td>${actionCell}</td>` +
        `<td class="oz-bh-cell-count">${countCell}</td>` +
        `<td>${_statusPill(meta.status)}</td>` +
        `<td class="oz-bh-cell-stats">${statsInline}</td>` +
        `<td class="oz-bh-cell-actions">` +
        retryBtn +
        `<button type="button" data-runid="${_escapeHtml(meta.runId)}">${viewLabel}</button>` +
        `</td>` +
        `</tr>`
      )
    }

    _showList() {
      if (this.$list) this.$list.hidden = false
      if (this.$detail) this.$detail.hidden = true
    }

    async _openDetail(runId) {
      if (!runId || !window.oz || !window.oz.bulk) return
      const full = await Promise.resolve(window.oz.bulk.get(runId)).catch(() => null)
      if (!full) return
      this._enrichedItems.set(runId, full.items || [])
      if (this.$list) this.$list.hidden = true
      if (this.$detail) this.$detail.hidden = false
      this._renderDetail(full)
    }

    _renderDetail(full) {
      this._currentDetailRun = full
      const meta = full.meta || {}
      const items = full.items || []
      if (this.$detailHeader) {
        const parts = [
          `<strong>${_escapeHtml(meta.actionLabel || meta.actionId || '—')}</strong>`,
          `<span class="oz-bh-detail-meta-line">${_escapeHtml(t('bulkHistory.detail.runId'))}: <code>${_escapeHtml(meta.runId || '')}</code></span>`,
          `<span class="oz-bh-detail-meta-line">${_escapeHtml(t('bulkHistory.detail.createdAt'))}: ${_escapeHtml(_formatDate(meta.createdAt))}</span>`,
          meta.finishedAt
            ? `<span class="oz-bh-detail-meta-line">${_escapeHtml(t('bulkHistory.detail.finishedAt'))}: ${_escapeHtml(_formatDate(meta.finishedAt))}</span>`
            : '',
          `<span class="oz-bh-detail-meta-line">${_escapeHtml(t('bulkHistory.detail.status'))}: ${_statusPill(meta.status)}</span>`,
        ]
        this.$detailHeader.innerHTML = parts.filter(Boolean).join(' • ')
      }
      if (this.$detailBody) {
        this.$detailBody.innerHTML = items.map((it) => this._renderDetailRow(it)).join('')
      }
      this._updateRetryBar()
    }

    // Retry actions live in bulk-history-actions.js (ADR 0005 LOC split).
    _updateRetryBar() {
      _actions().updateRetryBar(this)
    }
    _updateRetrySelectedButton() {
      _actions().updateRetrySelectedButton(this)
    }

    _renderDetailRow(it) {
      const STATUS_CHAR = {
        pending: '⏳',
        running: '▶︎',
        done: '✓',
        failed: '✗',
        cancelled: '⊘',
        skipped: '⤲',
      }
      const statusChar = STATUS_CHAR[it.status] || _escapeHtml(it.status || '—')
      const RETRYABLE = helpers.RETRYABLE_ITEM_STATUSES || new Set()
      const isRetryable = RETRYABLE.has(it.status) && it.identityId
      const checkboxCell = isRetryable
        ? `<input type="checkbox" data-identity="${_escapeHtml(it.identityId)}" aria-label="${_escapeHtml(t('bulkHistory.retry.itemCheckAria', { name: it.identityName || it.identityId }))}" />`
        : `<input type="checkbox" disabled aria-hidden="true" />`
      let resultCell = '—'
      if (it.result) {
        try {
          const r = typeof it.result === 'string' ? it.result : JSON.stringify(it.result)
          resultCell = `<code class="oz-bh-result-ok">${_escapeHtml(r.length > 120 ? r.slice(0, 120) + '…' : r)}</code>`
        } catch {
          resultCell = '✓'
        }
      } else if (it.error) {
        const code = it.error.code || 'ERROR'
        const explain = ERROR_CODE_EXPLAIN[code]
        const title = explain ? ` title="${_escapeHtml(explain)}"` : ''
        const msg = it.error.message || ''
        resultCell = `<code class="oz-bh-result-err"${title}>${_escapeHtml(code)}</code> <span class="oz-bh-result-msg">${_escapeHtml(msg)}</span>`
      }
      return (
        `<tr>` +
        `<td class="oz-bh-col-check">${checkboxCell}</td>` +
        `<td>${_escapeHtml(it.identityName || it.identityId || '—')}</td>` +
        `<td>${statusChar}</td>` +
        `<td>${resultCell}</td>` +
        `</tr>`
      )
    }

    _retryFailedItems() {
      return _actions().retryFailedItems(this)
    }
    _retrySelectedItems() {
      return _actions().retrySelectedItems(this)
    }
    _retryRowFromList(runId) {
      return _actions().retryRowFromList(this, runId)
    }
  }

  function _actions() {
    return (
      (window.OZ && window.OZ.bulkHistoryActions) || {
        updateRetryBar() {},
        updateRetrySelectedButton() {},
        retryFailedItems() {},
        retrySelectedItems() {},
        retryRowFromList() {},
      }
    )
  }

  function _boot() {
    if (window.OZ && window.OZ.bulkHistoryUI) return
    new BulkHistoryUI()
    // 4.1/4.2/4.4 open-intent listeners live in bulk-history-actions.js.
    _actions().wireOpenIntents(() => window.OZ && window.OZ.bulkHistoryUI)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true })
  } else {
    _boot()
  }
})()
