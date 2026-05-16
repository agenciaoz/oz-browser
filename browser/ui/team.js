// OZ Browser — Team modal (Bloque E-7).
//
// Doc: docs/modules/ui-team.md
// ADR: docs/architecture/0027-team-mode.md
//
// Mismo patrón que time-machine.js / cloud-backup.js. Vistas:
//   1) disconnected   — Vault locked (rare here, but defensive)
//   2) standalone     — Create team / Join existing buttons
//   3) owner          — members list + Invite button + Disband
//   4) member         — joined banner + Leave button
//   5) not-configured — Team mode disabled at build time
//
// Exports: window.OZ.Team singleton with open() / close().
// IPC: window.oz.team.*

;(function () {
  const { safe } = window.OZ.utils
  // v1.5.10: i18n — lazy lookup via window.OZ.i18n.t(). team.js loads BEFORE
  // i18n.js per webui.html script order, but every t() call sits inside a
  // user-triggered async path that runs after the catalog fetch completes.
  // Fallback to the key string is defensive only.
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  function fmt(iso) {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
    } catch (_) {
      return iso || '—'
    }
  }

  class TeamModal {
    constructor() {
      this.$modal = document.getElementById('oz-team-modal')
      if (!this.$modal) {
        window.oz?.log?.warn('webui/team', 'modal markup missing')
        return
      }
      this.$openBtn = document.getElementById('oz-team-button')
      this.$err = document.getElementById('oz-team-error')
      this.$views = {
        standalone: document.getElementById('oz-team-standalone-view'),
        owner: document.getElementById('oz-team-owner-view'),
        member: document.getElementById('oz-team-member-view'),
        notConfigured: document.getElementById('oz-team-not-configured-view'),
      }
      this.$createBtn = document.getElementById('oz-team-create-btn')
      this.$joinBtn = document.getElementById('oz-team-join-btn')
      this.$joinInput = document.getElementById('oz-team-join-input')
      this.$inviteBtn = document.getElementById('oz-team-invite-btn')
      this.$inviteDisplay = document.getElementById('oz-team-invite-display')
      this.$inviteUrl = document.getElementById('oz-team-invite-url')
      this.$inviteCopy = document.getElementById('oz-team-invite-copy')
      this.$disbandBtn = document.getElementById('oz-team-disband-btn')
      this.$leaveBtn = document.getElementById('oz-team-leave-btn')
      this.$refreshBtn = document.getElementById('oz-team-refresh-btn')
      this.$membersList = document.getElementById('oz-team-members')
      this.$ownerMeta = document.getElementById('oz-team-owner-meta')
      this.$memberMeta = document.getElementById('oz-team-member-meta')
      // v1.5.10: the standalone-view description has inline HTML (<br />, <code>)
      // so it can't use plain data-i18n textContent. We render it via innerHTML
      // here on init + on locale switch.
      this.$standaloneDesc = document.getElementById('oz-team-standalone-desc')

      this.status = null
      this._wire()
      this._applyStandaloneDesc()
      if (window.oz?.team?.onChanged) {
        window.oz.team.onChanged(() => {
          if (!this.$modal.hidden) this._refresh()
        })
      }
      if (window.oz?.team?.onJoined) {
        window.oz.team.onJoined((payload) => {
          window.alert(
            t('team.joinedAlert', { preJoinSnapshotId: payload.preJoinSnapshotId }),
          )
        })
      }

      // v1.5.10: re-render dynamic content on locale switch. translatePage()
      // covers static markup (titles, button labels, section titles), but
      // the standalone-view <code>-bearing description, the owner / member
      // meta lines (with {{teamId}}/{{when}}/{{ownerMemberId}} interpolation),
      // and the JS-built members list need a manual refresh.
      if (window.OZ?.i18n?.onChange) {
        window.OZ.i18n.onChange(() => {
          this._applyStandaloneDesc()
          if (this.$modal.hidden) return
          this._refresh().catch(() => {
            // swallow — locale switch must never throw out of i18n callback
          })
        })
      }
    }

    _applyStandaloneDesc() {
      if (!this.$standaloneDesc) return
      this.$standaloneDesc.innerHTML = t('team.standalone.descHtml')
    }

    _wire() {
      if (this.$openBtn) this.$openBtn.addEventListener('click', () => this.open())
      this.$modal.querySelectorAll('[data-close]').forEach((el) => {
        el.addEventListener('click', () => this.close())
      })
      document.addEventListener('keydown', (e) => {
        if (!this.$modal.hidden && e.key === 'Escape') this.close()
      })
      this.$createBtn?.addEventListener('click', () => this._doCreateTeam())
      this.$joinBtn?.addEventListener('click', () => this._doJoin())
      this.$inviteBtn?.addEventListener('click', () => this._doInvite())
      this.$inviteCopy?.addEventListener('click', () => this._copyInvite())
      this.$disbandBtn?.addEventListener('click', () => this._doDisband())
      this.$leaveBtn?.addEventListener('click', () => this._doLeave())
      this.$refreshBtn?.addEventListener('click', () => this._refresh())
    }

    async open() {
      this._clearError()
      this.$modal.hidden = false
      if (window.oz?.ui) window.oz.ui.setContentVisible(false).catch(() => {})
      await this._refresh()
    }
    close() {
      this.$modal.hidden = true
      if (window.oz?.ui) window.oz.ui.setContentVisible(true).catch(() => {})
    }

    _showView(name) {
      for (const k of Object.keys(this.$views)) {
        if (this.$views[k]) this.$views[k].hidden = k !== name
      }
      this._clearError()
    }
    _clearError() {
      if (this.$err) {
        this.$err.hidden = true
        this.$err.textContent = ''
      }
    }
    _showError(msg) {
      if (this.$err) {
        this.$err.textContent = msg
        this.$err.hidden = false
      }
    }
    _showInfo(msg) {
      if (this.$err) {
        this.$err.textContent = msg
        this.$err.className = 'oz-modal-error info'
        this.$err.hidden = false
      }
    }

    async _refresh() {
      const s = await safe(window.oz.team.status(), 'team.status')
      if (!s || s.__error) {
        this._showError(t('team.errorStatus'))
        return
      }
      this.status = s
      if (s.notConfigured) {
        this._showView('notConfigured')
        return
      }
      if (s.role === 'standalone') {
        this._showView('standalone')
        return
      }
      if (s.role === 'owner') {
        if (this.$ownerMeta) {
          this.$ownerMeta.textContent = t('team.owner.metaLine', {
            teamId: s.teamId,
            myMemberId: s.myMemberId,
          })
        }
        await this._loadMembers()
        this._showView('owner')
        return
      }
      if (s.role === 'member') {
        if (this.$memberMeta) {
          this.$memberMeta.textContent = t('team.member.metaLine', {
            teamId: s.teamId,
            when: fmt(s.joinedAt),
            ownerMemberId: s.ownerMemberId,
          })
        }
        this._showView('member')
      }
    }

    async _loadMembers() {
      const items = await safe(window.oz.team.listMembers(), 'team.listMembers')
      if (!items || items.__error) {
        this._showError(t('team.errorLoadMembers'))
        return
      }
      this.$membersList.innerHTML = ''
      if (items.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'team-empty'
        empty.textContent = t('team.members.empty')
        this.$membersList.appendChild(empty)
        return
      }
      for (const m of items) this.$membersList.appendChild(this._renderMember(m))
    }

    _renderMember(m) {
      const row = document.createElement('div')
      row.className = 'team-member' + (m.isMe ? ' me' : '')
      const name = document.createElement('div')
      name.className = 'team-member-id'
      name.textContent =
        (m.isOwner ? '👑 ' : '👤 ') +
        m.memberId +
        (m.isMe ? t('team.members.meSuffix') : '')
      row.appendChild(name)
      const status = document.createElement('div')
      status.className = 'team-member-status'
      status.textContent = m.hasWrappedKey
        ? t('team.members.keyShared')
        : t('team.members.waitingForKey')
      row.appendChild(status)
      if (!m.isOwner && !m.isMe) {
        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.className = 'danger'
        removeBtn.textContent = t('team.members.removeBtn')
        removeBtn.addEventListener('click', () => this._doRemoveMember(m.memberId))
        row.appendChild(removeBtn)
      }
      return row
    }

    async _doCreateTeam() {
      if (!window.confirm(t('team.confirmCreate'))) {
        return
      }
      this.$createBtn.disabled = true
      this.$createBtn.textContent = t('team.standalone.creatingBtn')
      const r = await safe(window.oz.team.createTeam(), 'team.createTeam')
      this.$createBtn.disabled = false
      this.$createBtn.textContent = t('team.standalone.createBtn')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('team.errorCreate'))
        return
      }
      await this._refresh()
    }

    async _doInvite() {
      const r = await safe(window.oz.team.generateInvite(), 'team.generateInvite')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('team.errorInvite'))
        return
      }
      this.$inviteUrl.value = r.url
      this.$inviteDisplay.hidden = false
      // Also kick the wrap-key daemon so new members get their key faster
      window.oz.team.wrapKeyForPendingMembers().catch(() => {})
    }

    _copyInvite() {
      if (!this.$inviteUrl || !this.$inviteUrl.value) return
      this.$inviteUrl.select()
      try {
        document.execCommand('copy')
        this._showInfo(t('team.inviteCopiedInfo'))
      } catch (_) {
        // ignore
      }
    }

    async _doJoin() {
      const tokenOrUrl = this.$joinInput?.value?.trim()
      if (!tokenOrUrl) {
        this._showError(t('team.errorJoinNoToken'))
        return
      }
      if (!window.confirm(t('team.confirmJoin'))) {
        return
      }
      this.$joinBtn.disabled = true
      this.$joinBtn.textContent = t('team.standalone.joiningBtn')
      const r = await safe(
        window.oz.team.acceptInvite({ tokenOrUrl, pollTimeoutMs: 90_000 }),
        'team.acceptInvite',
      )
      this.$joinBtn.disabled = false
      this.$joinBtn.textContent = t('team.standalone.joinBtn')
      if (!r || r.__error) {
        const code = r && r.__error?.code
        const msg = (r && r.__error?.message) || t('team.errorJoinDefault')
        if (code === 'PENDING') {
          this._showInfo(t('team.pendingInviteInfo', { msg }))
        } else {
          this._showError(msg)
        }
        return
      }
      // Joined event will trigger the alert via onJoined.
    }

    async _doLeave() {
      if (!window.confirm(t('team.confirmLeave'))) {
        return
      }
      const r = await safe(window.oz.team.leaveTeam(), 'team.leaveTeam')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('team.errorLeave'))
        return
      }
      await this._refresh()
    }

    async _doDisband() {
      if (!window.confirm(t('team.confirmDisband'))) {
        return
      }
      const r = await safe(window.oz.team.disbandTeam(), 'team.disbandTeam')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('team.errorDisband'))
        return
      }
      await this._refresh()
    }

    async _doRemoveMember(memberId) {
      if (!window.confirm(t('team.confirmRemoveMember', { memberId }))) {
        return
      }
      const r = await safe(window.oz.team.removeMember(memberId), 'team.removeMember')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || t('team.errorRemoveMember'))
        return
      }
      await this._refresh()
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.Team = new TeamModal()
})()
