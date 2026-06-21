// OZ Browser — Publishing Studio history/queue panel (v2 Etapa 2-A).
//
// Embedded list of recent publish runs (ig_post / x_post) with live status,
// per-identity drill-down, and "retry failed". Reuses the engine
// (window.oz.bulk.list/get/run) and the tested bulk-history pure helpers —
// no new backend. ADR: docs/architecture/0038-publishing-studio.md.
//
// Exposes window.OZ.PublishingHistory. Loaded as a <script> in
// publishing-studio.html AFTER bulk-history-helpers.js + publishing-helpers.js.

;(function () {
  'use strict'

  const H = (window.OZ && window.OZ.publishingHelpers) || {}
  const BH = (window.OZ && window.OZ.bulkHistoryHelpers) || {}
  const t = (key, params) => (window.OZ && window.OZ.t ? window.OZ.t(key, params) : key)

  const MAX_ROWS = 25
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'partial'])

  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = v
        else node.setAttribute(k, v)
      }
    }
    for (const c of children || []) if (c) node.appendChild(c)
    return node
  }

  async function safe(p, fallback) {
    try {
      return await p
    } catch (_e) {
      return fallback
    }
  }

  function fmtAgo(ts) {
    if (!ts) return ''
    const ms = typeof ts === 'number' ? ts : Date.parse(ts)
    if (Number.isNaN(ms)) return ''
    const diff = Date.now() - ms
    const m = Math.round(diff / 60000)
    if (m < 1) return t('publishingStudio.hist.justNow', 'just now')
    if (m < 60) return `${m}m`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h`
    return `${Math.round(h / 24)}d`
  }

  class PublishingHistory {
    constructor({ container, onRetry } = {}) {
      this.container = container
      this.onRetry = onRetry || (() => {})
      this.$list = null
      this._hydrated = new Map() // runId -> { meta, items }
      this._expanded = new Set()
    }

    mount() {
      this.container.innerHTML = ''
      this.$list = el('div', { class: 'pub-hist-list' })
      this.container.appendChild(this.$list)
    }

    async load() {
      // MCP-first: main filters publish runs + hydrates them with counts /
      // network label / failed ids (oz.publishing.runs). Fall back to the local
      // bulk.list + pure helpers if the new API isn't present.
      if (window.oz.publishing && window.oz.publishing.runs) {
        const hydrated = (await safe(window.oz.publishing.runs(MAX_ROWS), [])) || []
        this._render(hydrated)
        return
      }
      const rows = (await safe(window.oz.bulk.list(), [])) || []
      const publish = H.filterPublishRuns(rows).slice(0, MAX_ROWS)
      await Promise.all(
        publish.map(async (r) => {
          const id = r.meta.runId
          if (
            this._hydrated.has(id) &&
            TERMINAL.has(this._hydrated.get(id).meta.status)
          ) {
            return
          }
          const full = await safe(window.oz.bulk.get(id), null)
          if (full) this._hydrated.set(id, full)
        }),
      )
      this._render(publish.map((r) => this._hydrated.get(r.meta.runId) || r))
    }

    _render(runs) {
      this.$list.innerHTML = ''
      if (!runs.length) {
        this.$list.appendChild(
          el('div', {
            class: 'pub-empty',
            text: t('publishingStudio.hist.empty', 'No publications yet'),
          }),
        )
        return
      }
      for (const run of runs) {
        this.$list.appendChild(this._renderRow(run))
        if (this._expanded.has(run.meta.runId)) {
          this.$list.appendChild(this._renderDetail(run))
        }
      }
    }

    _renderRow(run) {
      const meta = run.meta || {}
      // Prefer the fields main precomputed (oz.publishing.runs); fall back to
      // the local pure helpers when rendering a raw bulk run.
      const counts = run.counts || H.countItems(run.items)
      const platform =
        run.platformLabel != null ? run.platformLabel : H.runPlatformLabel(meta)
      const failedIds =
        run.failedIds || (BH.getFailedIdentityIds ? BH.getFailedIdentityIds(run) : [])
      const canRetry = failedIds.length > 0 && TERMINAL.has(meta.status)

      const head = el('span', { class: 'pub-hist-platform', text: platform })
      const pill = el('span', {
        class: 'pub-hist-pill',
        'data-status': meta.status || 'unknown',
        text: t(
          'publishingStudio.runStatus.' + (meta.status || 'unknown'),
          meta.status || '—',
        ),
      })
      const tally = el('span', {
        class: 'pub-hist-tally',
        text: t('publishingStudio.hist.tally', {
          ok: counts.success,
          failed: counts.failed,
          total: counts.total || meta.identityCount || 0,
        }),
      })
      const ago = el('span', {
        class: 'pub-hist-ago',
        text: fmtAgo(meta.finishedAt || meta.startedAt || meta.createdAt),
      })

      const viewBtn = el('button', {
        class: 'pub-link',
        'data-act': 'view',
        text: this._expanded.has(meta.runId)
          ? t('publishingStudio.hist.hide', 'Hide')
          : t('publishingStudio.hist.view', 'View'),
      })
      viewBtn.addEventListener('click', () => {
        if (this._expanded.has(meta.runId)) this._expanded.delete(meta.runId)
        else this._expanded.add(meta.runId)
        this.load()
      })

      const actions = el('span', { class: 'pub-hist-actions' }, [viewBtn])
      if (canRetry) {
        const retryBtn = el('button', {
          class: 'pub-link pub-hist-retry',
          text: t('publishingStudio.hist.retry', { n: failedIds.length }),
        })
        retryBtn.addEventListener('click', () => this._retry(meta, failedIds))
        actions.appendChild(retryBtn)
      }

      return el(
        'div',
        { class: 'pub-hist-row', 'data-status': meta.status || 'unknown' },
        [el('span', { class: 'pub-hist-dot' }), head, pill, tally, ago, actions],
      )
    }

    _renderDetail(run) {
      const items = (run && run.items) || []
      const box = el('div', { class: 'pub-hist-detail' })
      if (!items.length) {
        box.appendChild(
          el('div', {
            class: 'pub-empty',
            text: t('publishingStudio.hist.noItems', 'No items'),
          }),
        )
        return box
      }
      for (const it of items) {
        box.appendChild(
          el('div', { class: 'pub-hist-item', 'data-status': it.status || 'pending' }, [
            el('span', { class: 'pub-hist-dot' }),
            el('span', {
              class: 'pub-hist-item-name',
              text: it.identityName || it.identityId || '—',
            }),
            el('span', {
              class: 'pub-hist-item-status',
              text: t(
                'publishingStudio.status.' + (it.status || 'pending'),
                it.status || '',
              ),
            }),
          ]),
        )
      }
      return box
    }

    async _retry(meta, failedIds) {
      // MCP-first: main builds the retry spec + dispatches (oz.publishing.retry).
      // Fall back to building the spec locally + bulk.run.
      if (window.oz.publishing && window.oz.publishing.retryRun) {
        await safe(window.oz.publishing.retryRun(meta.runId), null)
      } else {
        let spec
        try {
          spec = BH.buildRetrySpec(meta, failedIds)
        } catch (_e) {
          return
        }
        await safe(window.oz.bulk.run(spec), null)
      }
      this.onRetry()
      // Give the engine a tick, then refresh.
      setTimeout(() => this.load(), 400)
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingHistory = PublishingHistory
})()
