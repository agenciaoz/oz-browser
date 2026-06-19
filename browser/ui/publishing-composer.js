// OZ Browser — Publishing Studio composer (v2 Etapa 1).
//
// Schema-driven post composer (ADR-B): the form fields are derived from each
// publish action's paramsSchema via publishing-helpers, so new actions
// (fb_post, tiktok_post in Etapa 6) render with zero code changes here.
//
// Exposes window.OZ.PublishingComposer. DOM-only; pure logic lives in
// publishing-helpers.js. Loaded as a <script> in publishing-studio.html.

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
        else if (k === 'html') node.innerHTML = v
        else node.setAttribute(k, v)
      }
    }
    for (const c of children || []) if (c) node.appendChild(c)
    return node
  }

  class PublishingComposer {
    constructor({ container, onChange } = {}) {
      this.container = container
      this.onChange = onChange || (() => {})
      this.actions = []
      this.current = null // { actionId, platform, paramsSchema, label }
      this.fields = []
      this._imagePaths = {} // fieldName -> absolute path chosen via file input
      this.$network = null
      this.$fields = null
    }

    mount() {
      this.container.innerHTML = ''
      const networkRow = el('div', { class: 'pub-row' }, [
        el('label', {
          class: 'pub-label',
          text: t('publishingStudio.networkLabel', 'Network'),
          for: 'pub-network',
        }),
        (this.$network = el('select', { id: 'pub-network', class: 'pub-input' })),
      ])
      this.$network.addEventListener('change', () => {
        this._selectByIndex(this.$network.value)
      })
      this.$fields = el('div', { class: 'pub-fields' })
      this.container.appendChild(networkRow)
      this.container.appendChild(this.$fields)
    }

    setActions(actions) {
      this.actions = Array.isArray(actions) ? actions : []
      this.$network.innerHTML = ''
      this.actions.forEach((a, i) => {
        const label = H.platformLabel ? H.platformLabel(a.platform) : a.platform
        this.$network.appendChild(el('option', { value: String(i), text: label }))
      })
      if (this.actions.length) this._selectByIndex('0')
      else this.$fields.innerHTML = ''
    }

    _selectByIndex(idx) {
      const i = Number(idx)
      this.current = this.actions[i] || null
      this.fields = this.current ? H.fieldsFromSchema(this.current) : []
      this._imagePaths = {}
      this._renderFields()
      this.onChange()
    }

    _renderFields() {
      this.$fields.innerHTML = ''
      for (const f of this.fields) {
        this.$fields.appendChild(this._renderField(f))
      }
    }

    _renderField(f) {
      const labelText = t(
        'publishingStudio.field.' + f.name,
        f.name + (f.required ? ' *' : ''),
      )
      const label = el('label', { class: 'pub-label', text: labelText })
      let control
      if (f.control === 'image') {
        control = this._renderImageField(f)
      } else if (f.control === 'textarea') {
        control = this._renderTextarea(f)
      } else {
        control = el('input', {
          class: 'pub-input',
          type: f.control === 'number' ? 'number' : 'text',
          'data-field': f.name,
        })
        control.addEventListener('input', () => this.onChange())
      }
      const wrap = el('div', { class: 'pub-row pub-field', 'data-field-row': f.name }, [
        label,
        control,
      ])
      const err = el('div', { class: 'pub-field-err', 'data-err': f.name })
      wrap.appendChild(err)
      return wrap
    }

    _renderTextarea(f) {
      const ta = el('textarea', {
        class: 'pub-input pub-textarea',
        'data-field': f.name,
        rows: '4',
      })
      const counter = el('div', { class: 'pub-counter', 'data-counter': f.name })
      const updateCounter = () => {
        const len = ta.value.length
        counter.textContent = f.maxLength ? `${len} / ${f.maxLength}` : String(len)
        counter.classList.toggle('over', !!f.maxLength && len > f.maxLength)
      }
      ta.addEventListener('input', () => {
        updateCounter()
        this.onChange()
      })
      updateCounter()
      const box = el('div', { class: 'pub-textarea-box' }, [ta, counter])
      return box
    }

    _renderImageField(f) {
      const input = el('input', {
        class: 'pub-file',
        type: 'file',
        accept: 'image/*',
        'data-file': f.name,
      })
      const chosen = el('div', {
        class: 'pub-file-name',
        text: t('publishingStudio.field.noFile', 'No image selected'),
      })
      input.addEventListener('change', () => {
        const file = input.files && input.files[0]
        // Electron exposes the absolute path on File objects; ig_post needs it.
        const path = file && (file.path || '')
        this._imagePaths[f.name] = path || ''
        chosen.textContent = file
          ? file.name
          : t('publishingStudio.field.noFile', 'No image selected')
        this.onChange()
      })
      return el('div', { class: 'pub-file-box' }, [input, chosen])
    }

    // Collect raw values from the DOM keyed by field name.
    _rawValues() {
      const raw = {}
      for (const f of this.fields) {
        if (f.control === 'image') {
          raw[f.name] = this._imagePaths[f.name] || ''
          continue
        }
        const node = this.$fields.querySelector(`[data-field="${f.name}"]`)
        raw[f.name] = node ? node.value : ''
      }
      return raw
    }

    getSelection() {
      if (!this.current) return null
      const params = H.coercePublishParams(this.fields, this._rawValues())
      return {
        actionId: this.current.actionId,
        platform: this.current.platform,
        fields: this.fields,
        params,
      }
    }

    // The main free-text field (caption / text) — used by the variation +
    // templates panel to read/fill copy.
    _textField() {
      const f = this.fields.find((x) => x.control === 'textarea')
      return f ? this.$fields.querySelector(`[data-field="${f.name}"]`) : null
    }

    getCaptionValue() {
      const n = this._textField()
      return n ? n.value : ''
    }

    setCaptionValue(text) {
      const n = this._textField()
      if (!n) return
      n.value = text == null ? '' : String(text)
      n.dispatchEvent(new Event('input'))
    }

    showErrors(errors) {
      // Clear previous.
      this.$fields.querySelectorAll('[data-err]').forEach((n) => (n.textContent = ''))
      for (const e of errors || []) {
        const node = this.$fields.querySelector(`[data-err="${e.field}"]`)
        if (node) {
          node.textContent = t(
            'publishingStudio.err.' + e.code,
            e.code === 'required' ? 'Required' : 'Too long',
          )
        }
      }
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingComposer = PublishingComposer
})()
