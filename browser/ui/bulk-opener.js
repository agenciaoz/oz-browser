// OZ Browser — Bulk multi-account opener UI (C-4).
//
// Modal con 2 modos:
//   • From existing — multi-select de identities ya creadas + URL pattern.
//   • Create new   — count + name pattern + URL pattern + color.
//
// Target workspace: dropdown con "Current WS" / "New WS (Bulk Open — timestamp)".
// Locked identities aparecen disabled en la lista (visualmente con 🔒) y NO
// se mueven a otro workspace (D5/ADR 0023).
//
// Markup: oz-bo-* ids en webui.html. Triggers (3 wired by webui.js / menu.js /
// command-palette.js): sidebar button, ⌥⇧O accelerator, Cmd+K palette entry.
//
// IIFE-wrapped — ver oz-utils.js comment.

;(function () {
  const { safe } = window.OZ.utils
  // v1.5.11: i18n — lazy lookup via window.OZ.i18n.t() so locale switches
  // pick up automatically. bulk-opener.js loads AFTER i18n.js per webui.html
  // script order, so window.OZ.i18n is available at constructor time.
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key

  class BulkOpenerUI {
    constructor() {
      this.$modal = document.getElementById('oz-bo-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/bulk-opener', 'modal markup missing')
        }
        return
      }
      this.$mode = this.$modal.querySelector('[data-bo-mode]')
      this.$btnExisting = document.getElementById('oz-bo-mode-existing')
      this.$btnCreate = document.getElementById('oz-bo-mode-create')

      this.$existingList = document.getElementById('oz-bo-existing-list')
      this.$existingSearch = document.getElementById('oz-bo-existing-search')
      this.$existingSelectAll = document.getElementById('oz-bo-existing-select-all')
      this.$existingCount = document.getElementById('oz-bo-existing-count')
      this.$urlExisting = document.getElementById('oz-bo-url-existing')

      this.$count = document.getElementById('oz-bo-count')
      this.$namePattern = document.getElementById('oz-bo-name-pattern')
      this.$urlCreate = document.getElementById('oz-bo-url-create')
      this.$color = document.getElementById('oz-bo-color')
      this.$preview = document.getElementById('oz-bo-preview')

      this.$wsTarget = document.getElementById('oz-bo-ws-target')
      this.$newWsName = document.getElementById('oz-bo-new-ws-name')
      this.$newWsRow = document.getElementById('oz-bo-new-ws-row')

      this.$submit = document.getElementById('oz-bo-submit')
      this.$cancel = document.getElementById('oz-bo-cancel')
      this.$error = document.getElementById('oz-bo-error')
      this.$result = document.getElementById('oz-bo-result')
      this.$openBtn = document.getElementById('oz-bo-button')
      // v1.5.11: hint <small> with inline <code> rendered via innerHTML
      // (data-i18n textContent would strip the <code> children).
      this.$urlHintExisting = document.getElementById('oz-bo-url-hint-existing')

      this.mode = 'existing'
      this.identities = []
      this.workspaces = []
      this.activeWorkspaceId = null
      this.selected = new Set()
      this.searchTerm = ''
      this.isOpen = false

      this._wire()
      this._applyUrlHint()
      // v1.5.11: locale-aware default for the name pattern input. We set this
      // ONCE at init time so a Spanish user sees "Cuenta {n}" instead of
      // "Account {n}". Subsequent opens preserve user edits (no overwrite).
      // The HTML value="Account {n}" attribute stays as a defensive English
      // fallback in case i18n fails to load.
      if (this.$namePattern && window.OZ?.i18n) {
        this.$namePattern.value = t('bulkOpener.create.namePatternDefault')
      }

      // v1.5.11: re-render dynamic content on locale switch. translatePage()
      // covers static markup (title, mode buttons, labels, hint placeholders).
      // The url-hint <code>-bearing <small>, the JS-rendered identity list,
      // the count pill, the target <option>s, the submit button text, the
      // preview list, and the result block all need manual refresh.
      if (window.OZ?.i18n?.onChange) {
        window.OZ.i18n.onChange(() => {
          this._applyUrlHint()
          if (!this.isOpen) return
          this._setMode(this.mode) // re-renders submit button text
          this._renderTargetOptions()
          this._renderExistingList()
          this._renderPreview()
          // _showResult re-rendering: result might be stale from previous
          // submit; clear it instead of trying to re-render without the
          // original payload (avoids cross-locale drift).
          this.$result.hidden = true
        })
      }
    }

    _applyUrlHint() {
      if (!this.$urlHintExisting) return
      this.$urlHintExisting.innerHTML = t('bulkOpener.existing.urlHintHtml')
    }

    _wire() {
      if (window.oz?.bulkOpen?.onOpen) {
        // K1-extras (v1.4.0): broadcast can carry a pre-fill payload from
        // the workspace context-menu "Open all identities" entry.
        window.oz.bulkOpen.onOpen((payload) => this.open(payload))
      }
      if (this.$openBtn) {
        this.$openBtn.addEventListener('click', () => this.open())
      }
      this.$btnExisting.addEventListener('click', () => this._setMode('existing'))
      this.$btnCreate.addEventListener('click', () => this._setMode('create'))

      this.$existingSearch.addEventListener('input', () => {
        this.searchTerm = this.$existingSearch.value.trim().toLowerCase()
        this._renderExistingList()
      })
      this.$existingSelectAll.addEventListener('change', () => {
        if (this.$existingSelectAll.checked) {
          for (const i of this._visibleIdentities()) {
            if (!i.locked) this.selected.add(i.id)
          }
        } else {
          this.selected.clear()
        }
        this._renderExistingList()
        this._updateCount()
      })

      this.$count.addEventListener('input', () => this._renderPreview())
      this.$namePattern.addEventListener('input', () => this._renderPreview())
      this.$urlCreate.addEventListener('input', () => this._renderPreview())

      this.$wsTarget.addEventListener('change', () => this._onTargetChange())

      this.$submit.addEventListener('click', () => this._submit())
      this.$cancel.addEventListener('click', () => this.close())
      this.$modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) this.close()
      })
      document.addEventListener('keydown', (e) => {
        if (!this.isOpen) return
        if (e.key === 'Escape') {
          e.preventDefault()
          this.close()
        }
      })
    }

    async open(payload) {
      this.isOpen = true
      this.$modal.hidden = false
      await safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      this.$error.hidden = true
      this.$result.hidden = true

      // Fetch identities + workspaces fresh on every open.
      const [identities, workspaces, activeWs] = await Promise.all([
        safe(window.oz.identities.list(), 'identities.list'),
        safe(window.oz.workspaces.list(), 'workspaces.list'),
        safe(window.oz.workspaces.getActive(), 'workspaces.getActive'),
      ])
      this.identities = (identities || []).filter((i) => !!i.id)
      this.workspaces = (workspaces || []).filter((w) => !w.isArchived)
      this.activeWorkspaceId = activeWs ? activeWs.id : null

      // K1-extras (v1.4.0): apply pre-fill payload from workspace context-
      // menu. We set mode + target workspace + select all named identities.
      // Defensive: ignore unknown identityIds (workspace may have changed
      // between right-click and modal opening).
      if (payload && typeof payload === 'object') {
        if (payload.mode === 'existing' || payload.mode === 'create') {
          this.mode = payload.mode
        }
        this.selected = new Set()
        if (Array.isArray(payload.identityIds)) {
          const validIds = new Set(this.identities.map((i) => i.id))
          for (const id of payload.identityIds) {
            if (validIds.has(id)) this.selected.add(id)
          }
        }
        // Target workspace pre-select handled by _renderTargetOptions below
        // — set the active so the option is selected.
        if (payload.workspaceId) {
          this.activeWorkspaceId = payload.workspaceId
        }
      }

      this._renderTargetOptions()
      this._setMode(this.mode)
      this._renderExistingList()
      this._renderPreview()
    }

    close() {
      if (!this.isOpen) return
      this.isOpen = false
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
    }

    _setMode(mode) {
      this.mode = mode
      this.$btnExisting.classList.toggle('active', mode === 'existing')
      this.$btnCreate.classList.toggle('active', mode === 'create')
      this.$modal
        .querySelectorAll('[data-mode]')
        .forEach((el) => (el.hidden = el.getAttribute('data-mode') !== mode))
      this.$submit.textContent =
        mode === 'existing'
          ? t('bulkOpener.submitExisting')
          : t('bulkOpener.submitCreate')
      this._updateCount()
    }

    _onTargetChange() {
      const v = this.$wsTarget.value
      this.$newWsRow.hidden = v !== '__new__'
    }

    _visibleIdentities() {
      if (!this.searchTerm) return this.identities
      return this.identities.filter(
        (i) =>
          (i.name || '').toLowerCase().includes(this.searchTerm) ||
          (i.id || '').toLowerCase().includes(this.searchTerm),
      )
    }

    _renderExistingList() {
      const visible = this._visibleIdentities()
      if (visible.length === 0) {
        this.$existingList.innerHTML = `<li class="bo-empty">${escapeHtml(t('bulkOpener.existing.emptySearch'))}</li>`
      } else {
        this.$existingList.innerHTML = visible
          .map((i) => {
            const checked = this.selected.has(i.id) ? 'checked' : ''
            const disabled = i.locked ? 'disabled' : ''
            const lock = i.locked ? '<span class="bo-lock">🔒</span>' : ''
            const swatch = `<span class="bo-swatch" style="background:${escapeAttr(i.color || '#888')}"></span>`
            return `
              <li class="bo-id-row ${i.locked ? 'locked' : ''}">
                <label>
                  <input type="checkbox" data-id="${escapeAttr(i.id)}" ${checked} ${disabled} />
                  ${swatch}
                  <span class="bo-id-name">${escapeHtml(i.name || i.id)}</span>
                  ${lock}
                </label>
              </li>`
          })
          .join('')
        this.$existingList.querySelectorAll('input[type=checkbox]').forEach((cb) => {
          cb.addEventListener('change', () => {
            const id = cb.getAttribute('data-id')
            if (cb.checked) this.selected.add(id)
            else this.selected.delete(id)
            this._updateCount()
          })
        })
      }
      this._updateCount()
    }

    _renderTargetOptions() {
      const opts = []
      if (this.activeWorkspaceId) {
        const cur = this.workspaces.find((w) => w.id === this.activeWorkspaceId)
        const curLabel = t('bulkOpener.currentWsOption', {
          name: cur ? cur.name : this.activeWorkspaceId,
        })
        opts.push(
          `<option value="${escapeAttr(this.activeWorkspaceId)}">${escapeHtml(curLabel)}</option>`,
        )
      }
      // Then any other non-active, non-archived workspaces.
      for (const w of this.workspaces) {
        if (w.id === this.activeWorkspaceId) continue
        opts.push(`<option value="${escapeAttr(w.id)}">${escapeHtml(w.name)}</option>`)
      }
      opts.push(
        `<option value="__new__">${escapeHtml(t('bulkOpener.newWsOption'))}</option>`,
      )
      this.$wsTarget.innerHTML = opts.join('')
      // Default to "New workspace…" — the typical bulk-open use case.
      this.$wsTarget.value = '__new__'
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      this.$newWsName.value = t('bulkOpener.newWorkspaceDefault', { stamp })
      this._onTargetChange()
    }

    _updateCount() {
      if (this.mode === 'existing') {
        this.$existingCount.textContent = t('bulkOpener.existing.countSelected', {
          n: this.selected.size,
        })
        this.$submit.disabled = this.selected.size === 0
      } else {
        this.$submit.disabled = false
      }
    }

    _renderPreview() {
      if (this.mode !== 'create') return
      const count = Math.min(Math.max(Number(this.$count.value) || 0, 0), 50)
      if (count === 0) {
        this.$preview.innerHTML = `<li class="bo-empty">${escapeHtml(t('bulkOpener.create.previewEmpty'))}</li>`
        return
      }
      const namePattern = this.$namePattern.value || ''
      const urlPattern = this.$urlCreate.value || ''
      const rows = []
      for (let i = 1; i <= count; i++) {
        const name = resolveTemplate(namePattern, i)
        const url = resolveTemplate(urlPattern, i)
        rows.push(
          `<li><span class="bo-id-name">${escapeHtml(name)}</span><span class="bo-id-url">${escapeHtml(url || 'about:blank')}</span></li>`,
        )
      }
      this.$preview.innerHTML = rows.join('')
    }

    _readTarget() {
      const v = this.$wsTarget.value
      if (v === '__new__') {
        return { kind: 'new', name: this.$newWsName.value.trim() || undefined }
      }
      return { kind: 'current', workspaceId: v }
    }

    async _submit() {
      this.$error.hidden = true
      this.$result.hidden = true
      this.$submit.disabled = true

      const target = this._readTarget()
      let res
      if (this.mode === 'existing') {
        res = await safe(
          window.oz.bulkOpen.fromExisting({
            identityIds: Array.from(this.selected),
            urlPattern: this.$urlExisting.value || '',
            target,
          }),
          'bulkOpen.fromExisting',
        )
      } else {
        const count = Number(this.$count.value)
        if (!count || count < 1) {
          this._showError(t('bulkOpener.errorCountRange'))
          this.$submit.disabled = false
          return
        }
        res = await safe(
          window.oz.bulkOpen.createNew({
            count,
            namePattern:
              this.$namePattern.value || t('bulkOpener.create.namePatternDefault'),
            urlPattern: this.$urlCreate.value || '',
            color: this.$color.value || '#6b8e9f',
            target,
          }),
          'bulkOpen.createNew',
        )
      }

      this.$submit.disabled = false
      if (!res || res.ok === false) {
        this._showError(
          (res && (res.reason || res.message)) || t('bulkOpener.errorGeneric'),
        )
        return
      }
      this._showResult(res)
    }

    _showError(msg) {
      this.$error.textContent = msg
      this.$error.hidden = false
    }

    _showResult(res) {
      const opened = (res.opened || res.created || []).length
      const errors = (res.errors || []).length
      const wsLine = res.workspaceCreated
        ? t('bulkOpener.result.wsCreated', { id: res.workspaceId })
        : res.workspaceId
          ? t('bulkOpener.result.wsUsed', { id: res.workspaceId })
          : t('bulkOpener.result.wsCurrent')
      const openedLabel =
        opened === 1
          ? t('bulkOpener.result.openedSingular')
          : t('bulkOpener.result.openedPlural', { n: opened })
      const skippedLabel = !errors
        ? ''
        : errors === 1
          ? t('bulkOpener.result.skippedSingular')
          : t('bulkOpener.result.skippedPlural', { n: errors })
      let html = `<strong>${escapeHtml(openedLabel)}</strong>${skippedLabel ? `<span class="bo-warn">${escapeHtml(skippedLabel)}</span>` : ''}<br />${escapeHtml(wsLine)}`
      if (errors) {
        html += '<ul class="bo-error-list">'
        for (const e of res.errors.slice(0, 10)) {
          const fallback = t('bulkOpener.result.errorRowFallback', { n: e.n })
          html += `<li>${escapeHtml(e.name || e.identityId || fallback)} — ${escapeHtml(e.reason)}</li>`
        }
        if (res.errors.length > 10) {
          html += `<li>${escapeHtml(t('bulkOpener.result.moreErrors', { n: res.errors.length - 10 }))}</li>`
        }
        html += '</ul>'
      }
      this.$result.innerHTML = html
      this.$result.hidden = false
    }
  }

  // Mirror of bulk-opener.resolveUrlPattern (used in the preview rows only).
  function resolveTemplate(tpl, n) {
    if (typeof tpl !== 'string') return ''
    return tpl.replace(/\{n\}/g, String(n)).replace(/\{i\}/g, String(n - 1))
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&':
          return '&amp;'
        case '<':
          return '&lt;'
        case '>':
          return '&gt;'
        case '"':
          return '&quot;'
        case "'":
          return '&#39;'
      }
      return m
    })
  }
  function escapeAttr(s) {
    return escapeHtml(s)
  }

  window.OZ = window.OZ || {}
  window.OZ.BulkOpenerUI = BulkOpenerUI
})()
