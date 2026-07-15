// OZ Browser — Publishing Studio E5 UI: content-plan import + approval board.
//
// La pantalla que faltaba para E5. Reusa TODO lo que ya existe:
//   - window.oz.publishing.importPlanFile()  → pick .xlsx + import (main)
//   - window.oz.publishing.listPlan(status)  → publicaciones por estado
//   - window.oz.publishing.setPlanStatus(id, action) → draft→review→approved→published
//   - window.oz.publishing.removePlan/publishPlan/dryRun
//   - window.OZ.PublishingPlan (lógica pura: STATUSES + labels de transición)
//
// Sin backend nuevo. Expone window.OZ.PublishingPlanUI. Cargado como <script>
// en publishing-studio.html DESPUÉS de publishing-plan.js.
//
// ADR: 0038 (publishing-studio) · 0005 (modular).

;(function () {
  'use strict'

  const t = (key, fallback) =>
    window.OZ && window.OZ.t ? window.OZ.t(key, fallback) : fallback
  const PP = () => (window.OZ && window.OZ.PublishingPlan) || null

  // Estado → acciones del workflow disponibles desde ese estado (label + acción).
  const ACTIONS_BY_STATUS = {
    draft: [{ action: 'submit', label: 'Enviar a revisión' }],
    review: [
      { action: 'approve', label: 'Aprobar' },
      { action: 'reject', label: 'Rechazar' },
    ],
    approved: [
      { action: 'publish', label: 'Publicar' },
      { action: 'edit', label: 'Volver a borrador' },
    ],
    published: [],
  }
  const STATUS_LABEL = {
    draft: 'Borrador',
    review: 'En revisión',
    approved: 'Aprobado',
    published: 'Publicado',
  }

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

  class PublishingPlanUI {
    constructor(opts) {
      this.container = opts && opts.container
      this.onChange = (opts && opts.onChange) || (() => {})
      this.plan = []
    }

    mount() {
      if (!this.container) return
      this.container.innerHTML = ''

      const toolbar = el('div', { class: 'pub-plan-toolbar' })
      const importBtn = el('button', {
        class: 'btn',
        text: t('publishingStudio.plan.import', '📥 Importar Excel'),
      })
      importBtn.addEventListener('click', () => this._import())
      const refresh = el('button', {
        class: 'btn secondary',
        text: t('publishingStudio.plan.refresh', 'Actualizar'),
      })
      refresh.addEventListener('click', () => this.load())
      this._msg = el('span', { class: 'pub-plan-msg', 'data-tone': 'gray' })
      toolbar.appendChild(importBtn)
      toolbar.appendChild(refresh)
      toolbar.appendChild(this._msg)
      this.container.appendChild(toolbar)

      this._board = el('div', { class: 'pub-plan-board' })
      this.container.appendChild(this._board)
    }

    async load() {
      if (!window.oz || !window.oz.publishing || !window.oz.publishing.listPlan) return
      const list = (await safe(window.oz.publishing.listPlan(), [])) || []
      this.plan = Array.isArray(list) ? list : []
      this._render()
    }

    async _import() {
      if (!window.oz.publishing.importPlanFile) return
      this._setMsg(t('publishingStudio.plan.importing', 'Importando…'), 'yellow')
      const res = await safe(window.oz.publishing.importPlanFile(), {
        __error: { message: 'import failed' },
      })
      if (!res || res.canceled) {
        this._setMsg('', 'gray')
        return
      }
      if (res.__error) {
        this._setMsg(res.__error.message || 'Error al importar', 'red')
        return
      }
      const errs = (res.errors && res.errors.length) || 0
      this._setMsg(
        `${res.added || 0} importadas${errs ? `, ${errs} con error` : ''}`,
        errs ? 'yellow' : 'green',
      )
      await this.load()
      this.onChange()
    }

    async _act(id, action) {
      const res = await safe(window.oz.publishing.setPlanStatus(id, action), null)
      if (res && res.__error) {
        this._setMsg(res.__error.message || res.__error.code, 'red')
        return
      }
      await this.load()
      this.onChange()
    }

    async _publish(id) {
      this._setMsg(t('publishingStudio.plan.publishing', 'Publicando…'), 'yellow')
      const res = await safe(window.oz.publishing.publishPlan(id), null)
      if (res && res.__error) {
        this._setMsg(res.__error.message || res.__error.code, 'red')
        return
      }
      this._setMsg(t('publishingStudio.plan.published', 'Publicado'), 'green')
      await this.load()
      this.onChange()
    }

    async _remove(id) {
      const ok = window.OZ.ui
        ? await window.OZ.ui.confirm(
            t('publishingStudio.plan.confirmDel', '¿Borrar esta publicación?'),
          )
        : true
      if (!ok) return
      await safe(window.oz.publishing.removePlan(id), null)
      await this.load()
      this.onChange()
    }

    _setMsg(text, tone) {
      if (!this._msg) return
      this._msg.textContent = text || ''
      this._msg.setAttribute('data-tone', tone || 'gray')
    }

    _render() {
      if (!this._board) return
      this._board.innerHTML = ''
      const statuses = (PP() && PP().STATUSES) || [
        'draft',
        'review',
        'approved',
        'published',
      ]
      if (this.plan.length === 0) {
        this._board.appendChild(
          el('div', {
            class: 'pub-plan-empty',
            text: t(
              'publishingStudio.plan.empty',
              'Sin plan cargado. Importá un Excel con columnas: date, platform, caption, media, identities.',
            ),
          }),
        )
        return
      }
      for (const status of statuses) {
        const items = this.plan.filter((p) => p.status === status)
        const col = el('div', { class: 'pub-plan-col' })
        col.appendChild(
          el('div', {
            class: 'pub-plan-col-head',
            text: `${STATUS_LABEL[status] || status} (${items.length})`,
          }),
        )
        for (const p of items) col.appendChild(this._card(p))
        this._board.appendChild(col)
      }
    }

    _card(p) {
      const card = el('div', { class: 'pub-plan-card' })
      card.appendChild(
        el('div', { class: 'pub-plan-plat', text: (p.platform || '').toUpperCase() }),
      )
      const cap = (p.caption || '').slice(0, 120)
      card.appendChild(el('div', { class: 'pub-plan-cap', text: cap || '(sin caption)' }))
      const meta = []
      if (p.scheduledAt) meta.push(`📅 ${p.scheduledAt}`)
      const nIds = (Array.isArray(p.identities) ? p.identities : []).length
      meta.push(`👤 ${nIds}`)
      const nMedia = (Array.isArray(p.media) ? p.media : []).length
      if (nMedia) meta.push(`🖼 ${nMedia}`)
      card.appendChild(el('div', { class: 'pub-plan-meta', text: meta.join('  ·  ') }))

      const actions = el('div', { class: 'pub-plan-actions' })
      for (const a of ACTIONS_BY_STATUS[p.status] || []) {
        const btn = el('button', { class: 'pub-plan-btn', text: a.label })
        if (a.action === 'publish') {
          btn.addEventListener('click', () => this._publish(p.id))
        } else {
          btn.addEventListener('click', () => this._act(p.id, a.action))
        }
        actions.appendChild(btn)
      }
      // E2 (alpha.105): dry-run / pre-flight sin publicar.
      if (p.status !== 'published' && window.oz.publishing.dryRun) {
        const dry = el('button', { class: 'pub-plan-btn', text: '🔎 Dry-run' })
        dry.title = 'Validar sin publicar'
        dry.addEventListener('click', () => this._dryRun(p.id, card))
        actions.appendChild(dry)
      }
      if (p.status !== 'published') {
        const del = el('button', { class: 'pub-plan-btn danger', text: '✕' })
        del.title = 'Borrar'
        del.addEventListener('click', () => this._remove(p.id))
        actions.appendChild(del)
      }
      card.appendChild(actions)
      return card
    }

    async _dryRun(id, card) {
      const rep = await safe(window.oz.publishing.dryRun(id), null)
      const old = card.querySelector('.pub-plan-dry')
      if (old) old.remove()
      const box = el('div', { class: 'pub-plan-dry' })
      if (!rep || rep.__error) {
        box.setAttribute('data-tone', 'red')
        box.textContent =
          (rep && rep.__error && rep.__error.message) || 'Error en dry-run'
        card.appendChild(box)
        return
      }
      box.setAttribute('data-tone', rep.ok ? 'green' : 'red')
      const lines = []
      lines.push(rep.ok ? '✓ Listo para publicar' : '✕ Con problemas')
      for (const iss of rep.issues || []) lines.push(`· ${iss.message}`)
      for (const idn of rep.identities || []) {
        const mark = idn.willPublish ? '✓' : '✕'
        lines.push(`${mark} ${idn.name || idn.identityId} (${idn.health})`)
      }
      box.textContent = lines.join('\n')
      card.appendChild(box)
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingPlanUI = PublishingPlanUI
})()
