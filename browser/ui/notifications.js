// OZ Browser — Notifications panel UI (E2-C-5).
//
// Modal con lista cronológica reverse de alerts del log persistente
// (alerts.json). Inline action buttons cuando aplica. Badge contador
// unread en el botón sidebar 🔔.
//
// Triggered by:
//   - Sidebar 🔔 button
//   - Cmd+K palette → "Notifications"
//   - Programmatic: window.OZ.Notifications.open()
//
// IIFE-wrapped — ver oz-utils.js comment.

;(function () {
  if (!window.OZ) window.OZ = {}
  const { safe } = window.OZ.utils

  // v1.5.1: i18n helper — falls back to the key itself if i18n not loaded yet.
  function t(key, params) {
    if (window.OZ && typeof window.OZ.t === 'function') return window.OZ.t(key, params)
    return key
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') return ''
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function timeAgo(ts) {
    const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000))
    if (diffSec < 60) return t('notifications.timeAgo.justNow')
    const diffMin = Math.round(diffSec / 60)
    if (diffMin < 60) return t('notifications.timeAgo.minutes', { n: diffMin })
    const diffHr = Math.round(diffMin / 60)
    if (diffHr < 24) return t('notifications.timeAgo.hours', { n: diffHr })
    const diffDay = Math.round(diffHr / 24)
    if (diffDay < 30) return t('notifications.timeAgo.days', { n: diffDay })
    return new Date(ts).toLocaleDateString()
  }

  function actionLabel(action) {
    if (!action || !action.kind) return null
    if (action.kind === 'open-modal') {
      const modalLabelKeys = {
        accountManager: 'notifications.actions.openAccounts',
        timeMachine: 'notifications.actions.openTimeMachine',
        proxyManager: 'notifications.actions.openProxies',
        settings: 'notifications.actions.openSettings',
        browsingData: 'notifications.actions.openBrowsingData',
      }
      const m = action.payload && action.payload.modal
      return modalLabelKeys[m] ? t(modalLabelKeys[m]) : t('notifications.actions.open')
    }
    if (action.kind === 'open-identity') return t('notifications.actions.openIdentity')
    if (action.kind === 'select-tab') return t('notifications.actions.showTab')
    return t('notifications.actions.open')
  }

  function executeAction(action) {
    if (!action || !action.kind) return
    if (action.kind === 'open-modal') {
      const m = action.payload && action.payload.modal
      const modalMap = {
        accountManager: window.OZ && window.OZ.AccountManager,
        timeMachine: window.OZ && window.OZ.TimeMachine,
        proxyManager: window.ozProxyManagerUI,
        settings: window.ozSettingsUI,
        browsingData: window.ozBrowsingDataUI,
      }
      const ui = modalMap[m]
      if (ui && typeof ui.open === 'function') ui.open()
      return
    }
    if (action.kind === 'open-identity') {
      // Surface the identity in the sidebar via setActive (best-effort).
      const id = action.payload && action.payload.identityId
      if (id && window.oz && window.oz.identities) {
        safe(window.oz.identities.setActive(id), 'identities.setActive')
      }
    }
  }

  class NotificationsUI {
    constructor() {
      this.$modal = document.getElementById('oz-notif-modal')
      if (!this.$modal) return
      this.$list = document.getElementById('oz-notif-list')
      this.$empty = document.getElementById('oz-notif-empty')
      this.$markAll = document.getElementById('oz-notif-mark-all')
      this.$clearAll = document.getElementById('oz-notif-clear-all')
      this.$stats = document.getElementById('oz-notif-stats')
      this.$button = document.getElementById('oz-notif-button')
      this.$badge = document.getElementById('oz-notif-badge')

      this.isOpen = false
      this.alerts = []
      this._wire()
      this._refreshBadge()
    }

    _wire() {
      if (this.$button) {
        this.$button.addEventListener('click', () => this.open())
      }
      if (window.oz?.alerts?.onChanged) {
        window.oz.alerts.onChanged(() => {
          this._refreshBadge()
          if (this.isOpen) this._refresh()
        })
      }
      if (window.oz?.alerts?.onOpen) {
        window.oz.alerts.onOpen(() => this.open())
      }
      this.$markAll.addEventListener('click', async () => {
        await safe(window.oz.alerts.markAllRead(), 'alerts.markAllRead')
      })
      this.$clearAll.addEventListener('click', async () => {
        if (!confirm(t('notifications.clearAllConfirm'))) return
        await safe(window.oz.alerts.clear(), 'alerts.clear')
      })
      this.$modal.addEventListener('click', (e) => {
        if (e.target === this.$modal || e.target.dataset.close !== undefined) {
          this.close()
        }
      })
      document.addEventListener('keydown', (e) => {
        if (this.isOpen && e.key === 'Escape') {
          e.preventDefault()
          this.close()
        }
      })
    }

    async _refreshBadge() {
      const n = await safe(window.oz.alerts.unreadCount(), 'alerts.unreadCount')
      if (typeof n !== 'number') return
      if (n > 0) {
        this.$badge.textContent = n > 99 ? '99+' : String(n)
        this.$badge.removeAttribute('hidden')
      } else {
        this.$badge.setAttribute('hidden', '')
      }
    }

    async open() {
      this.$modal.removeAttribute('hidden')
      this.isOpen = true
      safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible(false)')
      await this._refresh()
      // Auto-mark all as read after a short delay so the user sees what's new
      // first, then the badge clears. Most notification UIs follow this pattern.
      setTimeout(() => {
        if (this.isOpen) {
          safe(window.oz.alerts.markAllRead(), 'alerts.markAllRead')
        }
      }, 800)
    }

    close() {
      this.$modal.setAttribute('hidden', '')
      this.isOpen = false
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible(true)')
    }

    async _refresh() {
      const list = await safe(window.oz.alerts.list({ limit: 200 }), 'alerts.list')
      this.alerts = Array.isArray(list) ? list : []
      this._render()
    }

    _render() {
      const total = this.alerts.length
      const unread = this.alerts.filter((a) => !a.read).length
      this.$stats.textContent = total ? t('notifications.stats', { total, unread }) : ''
      // Clear list (preserve empty placeholder).
      const rows = this.$list.querySelectorAll('.oz-notif-row')
      rows.forEach((r) => r.remove())

      if (total === 0) {
        this.$empty.removeAttribute('hidden')
        return
      }
      this.$empty.setAttribute('hidden', '')

      const frag = document.createDocumentFragment()
      for (const a of this.alerts) {
        frag.appendChild(this._renderRow(a))
      }
      this.$list.appendChild(frag)
    }

    _renderRow(alert) {
      const row = document.createElement('div')
      row.className = 'oz-notif-row' + (alert.read ? '' : ' unread')
      row.dataset.id = alert.id

      const sev = document.createElement('div')
      sev.className = 'oz-notif-sev ' + (alert.severity || 'info')
      row.appendChild(sev)

      const body = document.createElement('div')
      body.className = 'oz-notif-body'
      body.innerHTML = `
        <div class="oz-notif-title">${escapeHtml(alert.title)}</div>
        <div class="oz-notif-msg">${escapeHtml(alert.message || '')}</div>
        <div class="oz-notif-meta">
          <span>${escapeHtml(alert.type || '')}</span>
          <span>·</span>
          <span>${timeAgo(alert.ts)}</span>
        </div>
      `
      const actLabel = actionLabel(alert.action)
      if (actLabel) {
        const actions = document.createElement('div')
        actions.className = 'oz-notif-actions'
        const btn = document.createElement('button')
        btn.className = 'oz-notif-action'
        btn.type = 'button'
        btn.textContent = actLabel
        btn.addEventListener('click', () => {
          executeAction(alert.action)
          safe(window.oz.alerts.markRead(alert.id), 'alerts.markRead')
        })
        actions.appendChild(btn)
        body.appendChild(actions)
      }
      row.appendChild(body)

      const dismiss = document.createElement('button')
      dismiss.className = 'oz-notif-dismiss'
      dismiss.type = 'button'
      dismiss.title = 'Dismiss'
      dismiss.textContent = '×'
      dismiss.addEventListener('click', (e) => {
        e.stopPropagation()
        safe(window.oz.alerts.remove(alert.id), 'alerts.remove')
      })
      row.appendChild(dismiss)

      return row
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.OZ.Notifications = new NotificationsUI()
  })
})()
