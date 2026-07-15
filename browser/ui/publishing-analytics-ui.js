// OZ Browser — Publishing Studio E7 UI: analytics panel.
//
// La pantalla que faltaba para E7. Reusa window.oz.publishing.stats() (main
// computa sobre el historial de bulk runs de publicar) — sin backend nuevo.
// Muestra: overall (tasa de éxito), por red, mejor hora, top identities.
//
// Expone window.OZ.PublishingAnalyticsUI. Cargado como <script> en
// publishing-studio.html.
//
// ADR: 0038 (publishing-studio) · 0005 (modular).

;(function () {
  'use strict'

  const t = (key, fallback) =>
    window.OZ && window.OZ.t ? window.OZ.t(key, fallback) : fallback

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

  function pct(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—'
    return `${Math.round(n * 100)}%`
  }

  function toneFor(rate) {
    if (typeof rate !== 'number') return 'gray'
    if (rate >= 0.8) return 'green'
    if (rate >= 0.5) return 'yellow'
    return 'red'
  }

  class PublishingAnalyticsUI {
    constructor(opts) {
      this.container = opts && opts.container
    }

    mount() {
      if (!this.container) return
      this.container.innerHTML = ''
      const bar = el('div', { class: 'pub-plan-toolbar' })
      const refresh = el('button', {
        class: 'btn secondary',
        text: t('publishingStudio.analytics.refresh', 'Actualizar métricas'),
      })
      refresh.addEventListener('click', () => this.load())
      bar.appendChild(refresh)
      this.container.appendChild(bar)
      this._body = el('div', { class: 'pub-analytics-body' })
      this.container.appendChild(this._body)
    }

    async load() {
      if (!window.oz || !window.oz.publishing || !window.oz.publishing.stats) return
      const a = await safe(window.oz.publishing.stats(), null)
      this._render(a)
    }

    _render(a) {
      if (!this._body) return
      this._body.innerHTML = ''
      if (!a || a.__error || !a.overall) {
        this._body.appendChild(
          el('div', {
            class: 'pub-plan-empty',
            text: t(
              'publishingStudio.analytics.empty',
              'Sin datos todavía. Publicá algo y volvé a esta pantalla.',
            ),
          }),
        )
        return
      }
      const o = a.overall
      // KPI row: overall success rate + attempts + runs.
      const kpis = el('div', { class: 'pub-analytics-kpis' })
      kpis.appendChild(this._kpi('Éxito', pct(o.successRate), toneFor(o.successRate)))
      kpis.appendChild(this._kpi('Intentos', String(o.items || 0), 'gray'))
      kpis.appendChild(this._kpi('OK', String(o.done || 0), 'green'))
      kpis.appendChild(
        this._kpi('Fallos', String(o.failed || 0), o.failed ? 'red' : 'gray'),
      )
      this._body.appendChild(kpis)

      // Por red.
      const nets = a.byNetwork || {}
      const netKeys = Object.keys(nets)
      if (netKeys.length) {
        this._body.appendChild(el('div', { class: 'pub-analytics-h', text: 'Por red' }))
        const grid = el('div', { class: 'pub-analytics-rows' })
        for (const k of netKeys) {
          grid.appendChild(this._row(k.toUpperCase(), nets[k]))
        }
        this._body.appendChild(grid)
      }

      // Mejor hora (UTC).
      const hrs = (a.byHour || []).filter((h) => h.items > 0)
      if (hrs.length) {
        let best = hrs[0]
        for (const h of hrs) if (h.successRate > best.successRate) best = h
        this._body.appendChild(
          el('div', {
            class: 'pub-analytics-note',
            text: `Mejor hora (UTC): ${String(best.hour).padStart(2, '0')}:00 · ${pct(best.successRate)} éxito`,
          }),
        )
      }
    }

    _kpi(label, value, tone) {
      return el('div', { class: 'pub-analytics-kpi', 'data-tone': tone || 'gray' }, [
        el('div', { class: 'pub-analytics-kpi-val', text: value }),
        el('div', { class: 'pub-analytics-kpi-lbl', text: label }),
      ])
    }

    _row(label, bucket) {
      const rate = bucket && bucket.successRate
      return el('div', { class: 'pub-analytics-row' }, [
        el('span', { class: 'pub-analytics-row-lbl', text: label }),
        el('span', {
          class: 'pub-analytics-row-val',
          'data-tone': toneFor(rate),
          text: `${pct(rate)} (${(bucket && bucket.done) || 0}/${(bucket && bucket.items) || 0})`,
        }),
      ])
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingAnalyticsUI = PublishingAnalyticsUI
})()
