// OZ Browser — Publishing Studio scheduled-publications list (v2 Etapa 3).
//
// Lists scheduled publications (bulk ig_post/x_post) with enable/disable and
// remove. Reuses the existing scheduler via window.oz.scheduledActions — no
// new backend. ADR: docs/architecture/0038-publishing-studio.md.
//
// Exposes window.OZ.PublishingScheduledList. Loaded as a <script> in
// publishing-studio.html AFTER publishing-helpers.js.

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

  function describeSchedule(s) {
    if (!s || typeof s !== 'object') return ''
    if (s.type === 'daily') return t('publishingStudio.sched.descDaily', { time: s.time })
    if (s.type === 'weekly') {
      return t('publishingStudio.sched.descWeekly', {
        day: t('publishingStudio.day.' + s.day, s.day),
        time: s.time,
      })
    }
    if (s.type === 'every-minutes') {
      return t('publishingStudio.sched.descEvery', { minutes: s.minutes })
    }
    return ''
  }

  class PublishingScheduledList {
    constructor({ container } = {}) {
      this.container = container
      this.$list = null
    }

    mount() {
      this.container.innerHTML = ''
      this.$list = el('div', { class: 'pub-sched-list' })
      this.container.appendChild(this.$list)
    }

    async load() {
      if (!window.oz || !window.oz.scheduledActions) {
        this._render([])
        return
      }
      const all = (await safe(window.oz.scheduledActions.list(), [])) || []
      const publish = (Array.isArray(all) ? all : []).filter((a) =>
        H.isPublishScheduledAction(a),
      )
      this._render(publish)
    }

    _render(rows) {
      this.$list.innerHTML = ''
      if (!rows.length) {
        this.$list.appendChild(
          el('div', {
            class: 'pub-empty',
            text: t('publishingStudio.sched.empty', 'No scheduled publications'),
          }),
        )
        return
      }
      for (const a of rows) this.$list.appendChild(this._renderRow(a))
    }

    _renderRow(a) {
      const platform = H.scheduledPlatformLabel(a)
      const spec = (a.params && a.params.spec) || {}
      const count = Array.isArray(spec.identityIds) ? spec.identityIds.length : 0
      const enabled = a.enabled !== false

      const head = el('span', { class: 'pub-sched-platform', text: platform })
      const desc = el('span', {
        class: 'pub-sched-desc',
        text: describeSchedule(a.schedule),
      })
      const who = el('span', {
        class: 'pub-sched-who',
        text: t('publishingStudio.sched.accounts', { n: count }),
      })

      const toggle = el('button', {
        class: 'pub-link',
        text: enabled
          ? t('publishingStudio.sched.pause', 'Pause')
          : t('publishingStudio.sched.resume', 'Resume'),
      })
      toggle.addEventListener('click', async () => {
        await safe(window.oz.scheduledActions.setEnabled(a.id, !enabled), null)
        this.load()
      })

      const del = el('button', {
        class: 'pub-link pub-sched-del',
        text: t('common.delete', 'Delete'),
      })
      del.addEventListener('click', async () => {
        let okToDelete = true
        if (window.OZ && window.OZ.ui && window.OZ.ui.confirm) {
          okToDelete = await window.OZ.ui.confirm(
            t(
              'publishingStudio.sched.confirmDelete',
              'Delete this scheduled publication?',
            ),
            { okLabel: t('common.delete', 'Delete'), danger: true },
          )
        }
        if (!okToDelete) return
        await safe(window.oz.scheduledActions.remove(a.id), null)
        this.load()
      })

      return el('div', { class: 'pub-sched-row', 'data-enabled': String(enabled) }, [
        el('span', { class: 'pub-sched-dot', 'data-enabled': String(enabled) }),
        head,
        desc,
        who,
        el('span', { class: 'pub-sched-actions' }, [toggle, del]),
      ])
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.PublishingScheduledList = PublishingScheduledList
})()
