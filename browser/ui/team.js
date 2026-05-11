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

      this.status = null
      this._wire()
      if (window.oz?.team?.onChanged) {
        window.oz.team.onChanged(() => {
          if (!this.$modal.hidden) this._refresh()
        })
      }
      if (window.oz?.team?.onJoined) {
        window.oz.team.onJoined((payload) => {
          window.alert(
            `✓ Joined team.\n\nPre-join snapshot saved as ${payload.preJoinSnapshotId}.\n` +
              `Your previous OZ data was archived. Restart OZ Browser now so the new state takes effect.`,
          )
        })
      }
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
        this._showError('Team status query failed.')
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
          this.$ownerMeta.textContent = `Team ID: ${s.teamId} · You are the owner (${s.myMemberId})`
        }
        await this._loadMembers()
        this._showView('owner')
        return
      }
      if (s.role === 'member') {
        if (this.$memberMeta) {
          this.$memberMeta.textContent = `Team ID: ${s.teamId} · Joined ${fmt(s.joinedAt)} · Owner: ${s.ownerMemberId}`
        }
        this._showView('member')
      }
    }

    async _loadMembers() {
      const items = await safe(window.oz.team.listMembers(), 'team.listMembers')
      if (!items || items.__error) {
        this._showError('Failed to load members.')
        return
      }
      this.$membersList.innerHTML = ''
      if (items.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'team-empty'
        empty.textContent = 'No members yet. Share an invite to get started.'
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
        (m.isOwner ? '👑 ' : '👤 ') + m.memberId + (m.isMe ? ' (me)' : '')
      row.appendChild(name)
      const status = document.createElement('div')
      status.className = 'team-member-status'
      status.textContent = m.hasWrappedKey
        ? '✓ Key shared'
        : '⏳ Waiting for owner to wrap key'
      row.appendChild(status)
      if (!m.isOwner && !m.isMe) {
        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.className = 'danger'
        removeBtn.textContent = 'Remove'
        removeBtn.addEventListener('click', () => this._doRemoveMember(m.memberId))
        row.appendChild(removeBtn)
      }
      return row
    }

    async _doCreateTeam() {
      if (
        !window.confirm(
          'Create a new team using this OZ install as owner? You can invite members afterwards.',
        )
      ) {
        return
      }
      this.$createBtn.disabled = true
      this.$createBtn.textContent = 'Creating…'
      const r = await safe(window.oz.team.createTeam(), 'team.createTeam')
      this.$createBtn.disabled = false
      this.$createBtn.textContent = 'Create team'
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Create team failed.')
        return
      }
      await this._refresh()
    }

    async _doInvite() {
      const r = await safe(window.oz.team.generateInvite(), 'team.generateInvite')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Generate invite failed.')
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
        this._showInfo(
          'Invite URL copied. Send it to your team member via secure channel.',
        )
      } catch (_) {
        // ignore
      }
    }

    async _doJoin() {
      const tokenOrUrl = this.$joinInput?.value?.trim()
      if (!tokenOrUrl) {
        this._showError('Paste an oz://team/invite link or token.')
        return
      }
      if (
        !window.confirm(
          "Joining a team REPLACES your current OZ data with the team owner's data.\n\n" +
            'A pre-join snapshot will be saved + your current master key archived\n' +
            '(recoverable later via Time Machine). Restart will be required.\n\n' +
            'Continue?',
        )
      ) {
        return
      }
      this.$joinBtn.disabled = true
      this.$joinBtn.textContent = 'Joining…'
      const r = await safe(
        window.oz.team.acceptInvite({ tokenOrUrl, pollTimeoutMs: 90_000 }),
        'team.acceptInvite',
      )
      this.$joinBtn.disabled = false
      this.$joinBtn.textContent = 'Join team'
      if (!r || r.__error) {
        const code = r && r.__error?.code
        const msg = (r && r.__error?.message) || 'Accept invite failed.'
        if (code === 'PENDING') {
          this._showInfo(
            `${msg}\n\nThe team owner needs to open their OZ Browser while you wait. You can retry from this modal.`,
          )
        } else {
          this._showError(msg)
        }
        return
      }
      // Joined event will trigger the alert via onJoined.
    }

    async _doLeave() {
      if (
        !window.confirm(
          'Leave the team? Your local copy of the team master key remains so you can still access local snapshots, but you stop receiving updates.',
        )
      ) {
        return
      }
      const r = await safe(window.oz.team.leaveTeam(), 'team.leaveTeam')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Leave team failed.')
        return
      }
      await this._refresh()
    }

    async _doDisband() {
      if (
        !window.confirm(
          'Disband the team? This deletes the team folder in Dropbox and all member access. Your local data stays. Continue?',
        )
      ) {
        return
      }
      const r = await safe(window.oz.team.disbandTeam(), 'team.disbandTeam')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Disband team failed.')
        return
      }
      await this._refresh()
    }

    async _doRemoveMember(memberId) {
      if (
        !window.confirm(
          `Remove member ${memberId} from team? They will lose access to new snapshots.`,
        )
      ) {
        return
      }
      const r = await safe(window.oz.team.removeMember(memberId), 'team.removeMember')
      if (!r || r.__error) {
        this._showError((r && r.__error?.message) || 'Remove member failed.')
        return
      }
      await this._refresh()
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.Team = new TeamModal()
})()
