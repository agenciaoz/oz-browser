// OZ Browser — Publishing Studio variation & templates panel (v2 Etapa 4-A).
//
// Authoring tools that work today: caption templates, hashtag groups, and a
// per-identity variation PREVIEW (spintax + hashtag subset + media rotation).
// Per-identity EXECUTION needs engine support (Etapa 4-B); this panel proves
// the variation and stores reusable copy meanwhile.
//
// Exposes window.OZ.PublishingVariationUI. Loaded AFTER publishing-variation.js
// + publishing-store.js + ui-prompt.js.

;(function () {
  'use strict'

  const V = (window.OZ && window.OZ.publishingVariation) || {}
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

  function parseTags(str) {
    return String(str || '')
      .split(/[\s,]+/)
      .map((x) => x.trim().replace(/^#+/, ''))
      .filter(Boolean)
  }

  async function promptName(message) {
    if (window.OZ && window.OZ.ui && window.OZ.ui.prompt) {
      return window.OZ.ui.prompt(message)
    }
    return null
  }

  class PublishingVariationUI {
    constructor({ container, getCaption, setCaption, getIdentities, store } = {}) {
      this.container = container
      this.getCaption = getCaption || (() => '')
      this.setCaption = setCaption || (() => {})
      this.getIdentities = getIdentities || (() => [])
      this.store = store || (window.OZ && window.OZ.publishingStore) || null
    }

    mount() {
      this.container.innerHTML = ''

      // Hashtags
      this.$hashtags = el('input', {
        class: 'pub-input',
        type: 'text',
        placeholder: t('publishingStudio.var.hashtagsPh', '#travel #miami sun ...'),
      })
      this.$count = el('input', {
        class: 'pub-input pub-var-count',
        type: 'number',
        min: '0',
        placeholder: t('publishingStudio.var.allPh', 'all'),
      })
      this.$groups = el('select', { class: 'pub-input' })
      this.$groups.addEventListener('change', () => this._loadGroup(this.$groups.value))
      const saveGroup = el('button', {
        class: 'pub-link',
        type: 'button',
        text: t('publishingStudio.var.saveGroup', 'Save group'),
      })
      saveGroup.addEventListener('click', () => this._saveGroup())

      this.container.appendChild(
        el('div', { class: 'pub-row' }, [
          el('label', {
            class: 'pub-label',
            text: t(
              'publishingStudio.var.hashtags',
              'Hashtags (random subset per account)',
            ),
          }),
          el('div', { class: 'pub-var-line' }, [
            this.$hashtags,
            el('label', {
              class: 'pub-var-count-lbl',
              text: t('publishingStudio.var.useN', 'Use N:'),
            }),
            this.$count,
          ]),
          el('div', { class: 'pub-var-line' }, [this.$groups, saveGroup]),
        ]),
      )

      // Templates
      this.$templates = el('select', { class: 'pub-input' })
      this.$templates.addEventListener('change', () =>
        this._loadTemplate(this.$templates.value),
      )
      const saveTpl = el('button', {
        class: 'pub-link',
        type: 'button',
        text: t('publishingStudio.var.saveTemplate', 'Save as template'),
      })
      saveTpl.addEventListener('click', () => this._saveTemplate())
      this.container.appendChild(
        el('div', { class: 'pub-row' }, [
          el('label', {
            class: 'pub-label',
            text: t('publishingStudio.var.templates', 'Templates'),
          }),
          el('div', { class: 'pub-var-line' }, [this.$templates, saveTpl]),
        ]),
      )

      // Spintax hint + preview
      const hint = el('div', {
        class: 'pub-var-hint',
        text: t(
          'publishingStudio.var.spintaxHint',
          'Tip: use {hi|hey|hello} in the caption — each account gets a different variant. {{identity}} inserts the account name.',
        ),
      })
      const previewBtn = el('button', {
        class: 'btn secondary',
        type: 'button',
        text: t('publishingStudio.var.preview', 'Preview variations'),
      })
      previewBtn.addEventListener('click', () => this._preview())
      this.$preview = el('div', { class: 'pub-var-preview' })
      this.container.appendChild(hint)
      this.container.appendChild(previewBtn)
      this.container.appendChild(this.$preview)

      this._refreshGroups()
      this._refreshTemplates()
    }

    _spec() {
      const count = this.$count.value === '' ? null : Number(this.$count.value)
      return {
        caption: this.getCaption(),
        hashtags: parseTags(this.$hashtags.value),
        hashtagCount: count,
      }
    }

    async _preview() {
      this.$preview.innerHTML = ''
      const identities = this.getIdentities() || []
      if (!identities.length) {
        this.$preview.appendChild(
          el('div', {
            class: 'pub-empty',
            text: t('publishingStudio.var.noTargets', 'Select identities to preview'),
          }),
        )
        return
      }
      // MCP-first: main resolves the variation (same engine). Fall back to the
      // local engine if the new API isn't present.
      const spec = this._spec()
      const ids = identities.slice(0, 12)
      let rows
      if (window.oz && window.oz.publishing && window.oz.publishing.preview) {
        rows = await window.oz.publishing.preview(spec, ids)
      } else {
        rows = V.previewVariations(spec, ids)
      }
      for (const r of rows) {
        this.$preview.appendChild(
          el('div', { class: 'pub-var-row' }, [
            el('span', { class: 'pub-var-name', text: r.name }),
            el('span', { class: 'pub-var-text', text: r.caption || '—' }),
          ]),
        )
      }
    }

    _refreshGroups() {
      if (!this.store) return
      this.$groups.innerHTML = ''
      this.$groups.appendChild(
        el('option', {
          value: '',
          text: t('publishingStudio.var.insertGroup', 'Insert group…'),
        }),
      )
      for (const g of this.store.listHashtagGroups()) {
        this.$groups.appendChild(el('option', { value: g.id, text: g.name }))
      }
    }

    _refreshTemplates() {
      if (!this.store) return
      this.$templates.innerHTML = ''
      this.$templates.appendChild(
        el('option', {
          value: '',
          text: t('publishingStudio.var.loadTemplate', 'Load template…'),
        }),
      )
      for (const tpl of this.store.listTemplates()) {
        this.$templates.appendChild(el('option', { value: tpl.id, text: tpl.name }))
      }
    }

    _loadGroup(id) {
      if (!id || !this.store) return
      const g = this.store.listHashtagGroups().find((x) => x.id === id)
      if (!g) return
      const existing = parseTags(this.$hashtags.value)
      const merged = Array.from(new Set(existing.concat(g.tags)))
      this.$hashtags.value = merged.map((x) => '#' + x).join(' ')
      this.$groups.value = ''
    }

    _loadTemplate(id) {
      if (!id || !this.store) return
      const tpl = this.store.listTemplates().find((x) => x.id === id)
      if (!tpl) return
      this.setCaption(tpl.caption)
      if (Array.isArray(tpl.hashtags) && tpl.hashtags.length) {
        this.$hashtags.value = tpl.hashtags.map((x) => '#' + x).join(' ')
      }
      this.$templates.value = ''
    }

    async _saveGroup() {
      if (!this.store) return
      const tags = parseTags(this.$hashtags.value)
      if (!tags.length) return
      const name = await promptName(
        t('publishingStudio.var.groupName', 'Hashtag group name'),
      )
      if (!name) return
      this.store.saveHashtagGroup({ name, tags })
      this._refreshGroups()
    }

    async _saveTemplate() {
      if (!this.store) return
      const name = await promptName(
        t('publishingStudio.var.templateName', 'Template name'),
      )
      if (!name) return
      this.store.saveTemplate({
        name,
        caption: this.getCaption(),
        hashtags: parseTags(this.$hashtags.value),
      })
      this._refreshTemplates()
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingVariationUI = PublishingVariationUI
})()
