// OZ Browser — Publishing Studio target selector (v2 Etapa 1).
//
// Workspace filter + identity multi-select with anti-detect health badges.
// Health gating itself (red = blocked, yellow = warned) is computed by
// publishing-helpers.partitionTargetsByHealth at publish time.
//
// Exposes window.OZ.PublishingTargets. Loaded as a <script> in
// publishing-studio.html.

;(function () {
  'use strict'

  const H = (window.OZ && window.OZ.publishingHelpers) || {}
  const t = (key, params) => (window.OZ && window.OZ.t ? window.OZ.t(key, params) : key)

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

  class PublishingTargets {
    constructor({ container, onChange } = {}) {
      this.container = container
      this.onChange = onChange || (() => {})
      this.workspaces = []
      this.identities = []
      this.healthMap = new Map()
      this.filterWs = '' // '' = all
      this.selected = new Set()
      this.$filter = null
      this.$list = null
      this.$summary = null
    }

    mount() {
      this.container.innerHTML = ''
      const filterRow = el('div', { class: 'pub-row' }, [
        el('label', {
          class: 'pub-label',
          text: t('publishingStudio.workspaceLabel', 'Workspace'),
        }),
        (this.$filter = el('select', { class: 'pub-input' })),
      ])
      this.$filter.addEventListener('change', () => {
        this.filterWs = this.$filter.value
        this._renderList()
      })
      const toolbar = el('div', { class: 'pub-targets-toolbar' }, [
        el('button', {
          class: 'pub-link',
          'data-act': 'all',
          text: t('publishingStudio.selectAll', 'Select all'),
        }),
        el('button', {
          class: 'pub-link',
          'data-act': 'none',
          text: t('publishingStudio.selectNone', 'Clear'),
        }),
        (this.$summary = el('span', { class: 'pub-targets-summary' })),
      ])
      toolbar.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute('data-act')
        if (act === 'all') this._selectAllVisible(true)
        else if (act === 'none') this._selectAllVisible(false)
      })
      this.$list = el('div', { class: 'pub-targets-list' })
      this.container.appendChild(filterRow)
      this.container.appendChild(toolbar)
      this.container.appendChild(this.$list)
    }

    async load() {
      const [ws, ids, health] = await Promise.all([
        safe(window.oz.workspaces.list(), []),
        safe(window.oz.identities.list(), []),
        safe(window.oz.health.list(), []),
      ])
      this.workspaces = Array.isArray(ws) ? ws : []
      this.identities = Array.isArray(ids) ? ids : []
      this.healthMap = H.normalizeHealthMap(health)
      this._renderFilter()
      this._renderList()
    }

    _renderFilter() {
      this.$filter.innerHTML = ''
      this.$filter.appendChild(
        el('option', {
          value: '',
          text: t('publishingStudio.allWorkspaces', 'All workspaces'),
        }),
      )
      for (const w of this.workspaces) {
        this.$filter.appendChild(el('option', { value: w.id, text: w.name || w.id }))
      }
    }

    _visibleIdentities() {
      if (!this.filterWs) return this.identities
      return this.identities.filter((i) => i.workspaceId === this.filterWs)
    }

    _renderList() {
      this.$list.innerHTML = ''
      const visible = this._visibleIdentities()
      if (!visible.length) {
        this.$list.appendChild(
          el('div', {
            class: 'pub-empty',
            text: t('publishingStudio.noIdentities', 'No identities in this workspace'),
          }),
        )
        this._updateSummary()
        return
      }
      for (const ident of visible) {
        this.$list.appendChild(this._renderRow(ident))
      }
      this._updateSummary()
    }

    _renderRow(ident) {
      const status = this.healthMap.get(ident.id) || 'unknown'
      const dotStatus = ['green', 'yellow', 'red'].includes(status) ? status : 'gray'
      const cb = el('input', { type: 'checkbox', class: 'pub-cb' })
      cb.checked = this.selected.has(ident.id)
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(ident.id)
        else this.selected.delete(ident.id)
        this._updateSummary()
        this.onChange()
      })
      const dot = el('span', { class: 'pub-dot', 'data-status': dotStatus })
      const name = el('span', { class: 'pub-id-name', text: ident.name || ident.id })
      const row = el('label', { class: 'pub-id-row', 'data-health': status }, [
        cb,
        dot,
        name,
      ])
      if (status === 'red') {
        row.appendChild(
          el('span', {
            class: 'pub-id-flag',
            text: t('publishingStudio.healthBlocked', 'blocked'),
          }),
        )
      } else if (status === 'yellow') {
        row.appendChild(
          el('span', {
            class: 'pub-id-warn',
            text: t('publishingStudio.healthWarn', 'check'),
          }),
        )
      }
      return row
    }

    _selectAllVisible(on) {
      for (const ident of this._visibleIdentities()) {
        if (on) this.selected.add(ident.id)
        else this.selected.delete(ident.id)
      }
      this._renderList()
      this.onChange()
    }

    _updateSummary() {
      const part = this.getPartition()
      this.$summary.textContent = t('publishingStudio.targetsSummary', {
        allowed: part.allowed.length,
        blocked: part.blocked.length,
      })
    }

    getSelectedIds() {
      return Array.from(this.selected)
    }

    // Selected identities as {id, name} objects (for variation preview).
    getSelectedIdentityObjects() {
      const byId = new Map(this.identities.map((i) => [i.id, i]))
      return this.getSelectedIds().map((id) => byId.get(id) || { id, name: id })
    }

    getPartition() {
      return H.partitionTargetsByHealth(this.getSelectedIds(), this.healthMap)
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingTargets = PublishingTargets
})()
