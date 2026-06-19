// OZ Browser — Publishing Studio "When" control (v2 Etapa 3).
//
// Lets the user choose Publish now vs Schedule (recurring: daily / weekly /
// every-N-minutes) and an optional drip spacing between accounts. Pure
// schedule/drip building lives in publishing-helpers (tested). One-shot date
// scheduling ('once') needs an engine change — tracked as Etapa 3-B.
//
// Exposes window.OZ.PublishingSchedule. Loaded as a <script> in
// publishing-studio.html.

;(function () {
  'use strict'

  const H = (window.OZ && window.OZ.publishingHelpers) || {}
  const t = (key, params) => (window.OZ && window.OZ.t ? window.OZ.t(key, params) : key)

  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

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

  class PublishingSchedule {
    constructor({ container, onChange } = {}) {
      this.container = container
      this.onChange = onChange || (() => {})
      this.mode = 'now' // 'now' | 'schedule'
      this.$schedFields = null
      this.$mode = null
      this.$time = null
      this.$day = null
      this.$minutes = null
      this.$spacing = null
    }

    mount() {
      this.container.innerHTML = ''

      // When: now / schedule
      const whenRow = el('div', { class: 'pub-row' }, [
        el('label', {
          class: 'pub-label',
          text: t('publishingStudio.sched.when', 'When'),
        }),
      ])
      const seg = el('div', { class: 'pub-seg' })
      this._nowBtn = el('button', {
        class: 'pub-seg-btn active',
        'data-mode': 'now',
        type: 'button',
        text: t('publishingStudio.sched.now', 'Publish now'),
      })
      this._schedBtn = el('button', {
        class: 'pub-seg-btn',
        'data-mode': 'schedule',
        type: 'button',
        text: t('publishingStudio.sched.schedule', 'Schedule'),
      })
      seg.appendChild(this._nowBtn)
      seg.appendChild(this._schedBtn)
      seg.addEventListener('click', (e) => {
        const m = e.target && e.target.getAttribute('data-mode')
        if (m) this._setMode(m)
      })
      whenRow.appendChild(seg)
      this.container.appendChild(whenRow)

      // Schedule sub-fields (hidden unless mode=schedule)
      this.$schedFields = el('div', { class: 'pub-sched-fields' })
      this.$schedFields.style.display = 'none'

      this.$mode = el('select', { class: 'pub-input' })
      ;[
        ['daily', t('publishingStudio.sched.daily', 'Daily')],
        ['weekly', t('publishingStudio.sched.weekly', 'Weekly')],
        ['everyMinutes', t('publishingStudio.sched.everyMinutes', 'Every N minutes')],
      ].forEach(([v, label]) =>
        this.$mode.appendChild(el('option', { value: v, text: label })),
      )
      this.$mode.addEventListener('change', () => {
        this._renderModeFields()
        this.onChange()
      })

      this.$day = el('select', { class: 'pub-input' })
      DAYS.forEach((d) =>
        this.$day.appendChild(
          el('option', { value: d, text: t('publishingStudio.day.' + d, d) }),
        ),
      )
      this.$time = el('input', { class: 'pub-input', type: 'time', value: '09:00' })
      this.$time.addEventListener('input', () => this.onChange())
      this.$minutes = el('input', {
        class: 'pub-input',
        type: 'number',
        min: '1',
        max: '1440',
        value: '60',
      })
      this.$minutes.addEventListener('input', () => this.onChange())

      this._modeFieldsBox = el('div', { class: 'pub-sched-mode-fields' })
      this.$schedFields.appendChild(
        el('div', { class: 'pub-row' }, [
          el('label', {
            class: 'pub-label',
            text: t('publishingStudio.sched.frequency', 'Frequency'),
          }),
          this.$mode,
        ]),
      )
      this.$schedFields.appendChild(this._modeFieldsBox)
      this.container.appendChild(this.$schedFields)

      // Drip spacing (applies to both modes)
      this.$spacing = el('input', {
        class: 'pub-input',
        type: 'number',
        min: '0',
        placeholder: '0',
      })
      this.$spacing.addEventListener('input', () => this.onChange())
      this.container.appendChild(
        el('div', { class: 'pub-row' }, [
          el('label', {
            class: 'pub-label',
            text: t('publishingStudio.sched.drip', 'Spacing between accounts (seconds)'),
          }),
          this.$spacing,
        ]),
      )

      this._renderModeFields()
    }

    _setMode(mode) {
      this.mode = mode
      this._nowBtn.classList.toggle('active', mode === 'now')
      this._schedBtn.classList.toggle('active', mode === 'schedule')
      this.$schedFields.style.display = mode === 'schedule' ? '' : 'none'
      this.onChange()
    }

    _renderModeFields() {
      this._modeFieldsBox.innerHTML = ''
      const mode = this.$mode.value
      if (mode === 'weekly') {
        this._modeFieldsBox.appendChild(
          el('div', { class: 'pub-row' }, [
            el('label', {
              class: 'pub-label',
              text: t('publishingStudio.sched.day', 'Day'),
            }),
            this.$day,
          ]),
        )
      }
      if (mode === 'everyMinutes') {
        this._modeFieldsBox.appendChild(
          el('div', { class: 'pub-row' }, [
            el('label', {
              class: 'pub-label',
              text: t('publishingStudio.sched.minutes', 'Minutes'),
            }),
            this.$minutes,
          ]),
        )
      } else {
        this._modeFieldsBox.appendChild(
          el('div', { class: 'pub-row' }, [
            el('label', {
              class: 'pub-label',
              text: t('publishingStudio.sched.time', 'Time'),
            }),
            this.$time,
          ]),
        )
      }
    }

    getMode() {
      return this.mode
    }

    // Returns a schedule object or null (invalid). Only meaningful when
    // mode === 'schedule'.
    getSchedule() {
      return H.buildSchedule({
        mode: this.$mode.value,
        time: this.$time.value,
        day: this.$day.value,
        minutes: this.$minutes.value,
      })
    }

    getDripOptions() {
      return H.dripOptions(this.$spacing.value)
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingSchedule = PublishingSchedule
})()
