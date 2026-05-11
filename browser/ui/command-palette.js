// OZ Browser — Command Palette (C-1) renderer UI.
//
// Cmd+K opens a centered overlay with a text input and a result list. The
// input filters identities, workspaces, open tabs, and a set of static
// actions (New Tab, Lock, Snapshot, Open Settings, …). Enter executes the
// selected row's payload; Esc closes; ↑ ↓ navigate.
//
// Trigger: main emits `oz:command-palette:open` on Cmd+K (see browser/menu.js).
// Data:    `window.oz.commands.list()` returns a fresh command array built
//          from the current Identity/Workspace/Tab managers (main process).
// Match:   local copy of matchAndRank — mirrors browser/command-palette.js.
//          The canonical algorithm and tests live there; this is the renderer
//          fast path that runs on every keystroke without IPC.
//
// IIFE-wrapped — see oz-utils.js comment for the lexical-scope reasoning.

;(function () {
  const { safe } = window.OZ.utils

  // ─── MIRROR of browser/command-palette.js fuzzy matcher ──────────────────
  // Keep these constants and functions in sync with the main-process module
  // (tests live in tests/command-palette.smoketest.js). Renderer-side copy
  // exists to keep per-keystroke search local (no IPC roundtrip).
  const SCORE_EXACT = 100
  const SCORE_PREFIX = 60
  const SCORE_PER_CHAR = 8
  const BONUS_WORD_START = 12
  const BONUS_CAMEL = 8
  const BONUS_FIRST = 14
  const BONUS_CONSECUTIVE = 10
  const PENALTY_GAP = 1
  const TYPE_ORDER = { action: 0, tab: 1, identity: 2, workspace: 3 }

  function isBoundary(ch) {
    return ch === ' ' || ch === '-' || ch === '_' || ch === '/' || ch === '.'
  }
  function fuzzyMatch(query, text) {
    if (typeof query !== 'string' || typeof text !== 'string') return null
    if (query.length === 0) return { score: 0, indices: [] }
    const q = query.toLowerCase()
    const t = text.toLowerCase()
    if (q.length > t.length) return null
    const idx = t.indexOf(q)
    if (idx !== -1) {
      const indices = []
      for (let i = 0; i < q.length; i++) indices.push(idx + i)
      let score = SCORE_EXACT + q.length * SCORE_PER_CHAR
      if (idx === 0) score += SCORE_PREFIX + BONUS_FIRST
      else if (isBoundary(t[idx - 1])) score += BONUS_WORD_START
      return { score, indices }
    }
    const indices = []
    let ti = 0
    let qi = 0
    let prevMatched = false
    let score = 0
    while (qi < q.length && ti < t.length) {
      if (q[qi] === t[ti]) {
        indices.push(ti)
        score += SCORE_PER_CHAR
        if (ti === 0) score += BONUS_FIRST
        else {
          const prev = t[ti - 1]
          if (isBoundary(prev)) score += BONUS_WORD_START
          if (
            text[ti] >= 'A' &&
            text[ti] <= 'Z' &&
            text[ti - 1] >= 'a' &&
            text[ti - 1] <= 'z'
          ) {
            score += BONUS_CAMEL
          }
          if (prevMatched) score += BONUS_CONSECUTIVE
        }
        qi += 1
        prevMatched = true
      } else {
        if (prevMatched) score -= PENALTY_GAP
        prevMatched = false
      }
      ti += 1
    }
    if (qi < q.length) return null
    return { score, indices }
  }
  function scoreCommand(command, query) {
    if (!query) return { score: 0, indices: [], field: 'label' }
    const m = fuzzyMatch(query, command.label || '')
    let best = m ? { ...m, field: 'label' } : null
    if (command.keywords) {
      const k = fuzzyMatch(query, command.keywords)
      if (k) {
        const adjusted = { score: k.score * 0.8, indices: [], field: 'keywords' }
        if (!best || adjusted.score > best.score) best = adjusted
      }
    }
    if (command.subtitle) {
      const s = fuzzyMatch(query, command.subtitle)
      if (s) {
        const adjusted = { score: s.score * 0.6, indices: [], field: 'subtitle' }
        if (!best || adjusted.score > best.score) best = adjusted
      }
    }
    return best
  }
  function matchAndRank(commands, query, opts) {
    const limit = (opts && opts.limit) || 50
    const trimmed = typeof query === 'string' ? query.trim() : ''
    if (!trimmed) {
      return commands
        .slice(0, limit)
        .map((c, idx) => ({ command: c, score: -idx, indices: [] }))
    }
    const matched = []
    for (const c of commands) {
      const r = scoreCommand(c, trimmed)
      if (r && r.score > 0) {
        matched.push({ command: c, score: r.score, indices: r.indices })
      }
    }
    matched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ta = TYPE_ORDER[a.command.type] ?? 99
      const tb = TYPE_ORDER[b.command.type] ?? 99
      if (ta !== tb) return ta - tb
      return (a.command.label || '').localeCompare(b.command.label || '')
    })
    return matched.slice(0, limit)
  }
  // ─── End mirror ──────────────────────────────────────────────────────────

  // Build a label fragment with highlighted matched chars.
  function renderHighlighted(label, indices) {
    if (!indices || indices.length === 0) return escapeHtml(label)
    const set = new Set(indices)
    let out = ''
    for (let i = 0; i < label.length; i++) {
      const ch = escapeHtml(label[i])
      out += set.has(i) ? `<mark>${ch}</mark>` : ch
    }
    return out
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

  // Resolve a tab id from an action payload. Returns null if no candidate.
  // Falls back to the focused tab if the build-time bake didn't include one
  // (e.g. window had no tabs at palette-open time but one was created since).
  async function resolveTabId(payload) {
    if (payload && payload.tabId != null) return payload.tabId
    const tabs = (await safe(window.oz.tabs.list(), 'tabs.list')) || []
    // Pick the first tab in the focused window — best guess; the native
    // menu's accelerators also fall through to "first" when nothing focused.
    return tabs.length > 0 ? tabs[0].id : null
  }

  async function findTab(tabId) {
    const tabs = (await safe(window.oz.tabs.list(), 'tabs.list')) || []
    return tabs.find((t) => t.id === tabId) || null
  }

  // Maps payload.action → dispatcher. Each handler is async; returns true if
  // the palette should close after execution. Keeps the switch small.
  function makeExecutors() {
    return {
      'new-tab': async (payload) => {
        // Active identity is baked into payload at build time on main.
        const identityId = payload.identityId
        if (identityId) {
          await safe(
            window.oz.tabs.openInIdentity(identityId, 'about:blank'),
            'tabs.openInIdentity',
          )
        } else {
          // Fallback: ask main for the current active identity.
          const active = await safe(
            window.oz.identities.getActive(),
            'identities.getActive',
          )
          if (active && active.id) {
            await safe(
              window.oz.tabs.openInIdentity(active.id, 'about:blank'),
              'tabs.openInIdentity',
            )
          }
        }
        return true
      },
      'new-identity': async () => {
        const ident = await safe(
          window.oz.identities.create({ name: 'New Identity' }),
          'identities.create',
        )
        if (ident && ident.id) {
          await safe(
            window.oz.tabs.openInIdentity(ident.id, 'about:blank'),
            'tabs.openInIdentity',
          )
        }
        return true
      },
      'duplicate-tab': async (payload) => {
        const tabId = await resolveTabId(payload)
        if (tabId != null) await safe(window.oz.tabs.duplicate(tabId), 'tabs.duplicate')
        return true
      },
      'reopen-closed-tab': async () => {
        await safe(window.oz.tabs.reopenClosed(), 'tabs.reopenClosed')
        return true
      },
      'toggle-pin': async (payload) => {
        const tabId = await resolveTabId(payload)
        if (tabId == null) return true
        const tab = await findTab(tabId)
        if (!tab) return true
        if (tab.pinned) await safe(window.oz.tabs.unpin(tabId), 'tabs.unpin')
        else await safe(window.oz.tabs.pin(tabId), 'tabs.pin')
        return true
      },
      'toggle-lock': async (payload) => {
        const tabId = await resolveTabId(payload)
        if (tabId == null) return true
        const tab = await findTab(tabId)
        if (!tab) return true
        if (tab.locked) await safe(window.oz.tabs.unlock(tabId), 'tabs.unlock')
        else await safe(window.oz.tabs.lock(tabId), 'tabs.lock')
        return true
      },
      'move-to-new-window': async () => {
        // The renderer can't trigger the native menu's "Move to New Window"
        // directly (no IPC channel — main owns window orchestration). For
        // C-1 we close the palette silently so users at least know the
        // command exists; binding ⌥S triggers the real action via the
        // native Tab menu. Followup ticket: expose oz:tabs:moveToNewWindow.
        if (window.oz?.log) {
          window.oz.log.info(
            'webui/command-palette',
            'move-to-new-window from palette is a stub — use ⌥S from the tab',
          )
        }
        return true
      },
      'take-snapshot': async () => {
        await safe(
          window.oz.timemachine.create({ reason: 'manual' }),
          'timemachine.create',
        )
        return true
      },
      'open-modal': async (payload) => {
        // Two patterns coexist: some modals are constructed in webui.js as
        // `new XxxUI()` and stored on window.ozXxxUI; others (account-manager,
        // time-machine) self-instantiate as singletons on window.OZ.Xxx.
        // We probe both.
        const modalMap = {
          settings: window.ozSettingsUI,
          timeMachine: window.OZ && window.OZ.TimeMachine,
          accountManager: window.OZ && window.OZ.AccountManager,
          proxyManager: window.ozProxyManagerUI,
          browsingData: window.ozBrowsingDataUI,
          bulkOpener: window.ozBulkOpenerUI,
          identityClone: window.OZ && window.OZ.IdentityClone,
          notifications: window.OZ && window.OZ.Notifications,
          healthCheck: window.OZ && window.OZ.HealthCheck,
          extensionsManager: window.OZ && window.OZ.ExtensionsManager,
        }
        const ui = modalMap[payload.modal]
        if (ui && typeof ui.open === 'function') ui.open()
        return true
      },
      'toggle-devtools': async () => {
        // No IPC for active webContents devtools; the native menu has the
        // Cmd+Shift+J binding. Surfaced here for discoverability.
        return true
      },
      'switch-identity': async (payload) => {
        await safe(
          window.oz.identities.setActive(payload.identityId),
          'identities.setActive',
        )
        return true
      },
      'switch-workspace': async (payload) => {
        await safe(
          window.oz.workspaces.setActive(payload.workspaceId),
          'workspaces.setActive',
        )
        return true
      },
      'select-tab': async (payload) => {
        await safe(window.oz.tabs.select(payload.tabId), 'tabs.select')
        return true
      },
    }
  }

  class CommandPaletteUI {
    constructor() {
      this.$modal = document.getElementById('oz-cmdk-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/command-palette', 'modal markup missing')
        }
        return
      }
      this.$input = document.getElementById('oz-cmdk-input')
      this.$list = document.getElementById('oz-cmdk-list')
      this.$empty = document.getElementById('oz-cmdk-empty')
      this.executors = makeExecutors()
      this.commands = []
      this.results = []
      this.selectedIdx = 0
      this.isOpen = false
      this._wire()
    }

    _wire() {
      // Listen for the main-process trigger (Cmd+K).
      if (window.oz?.commands?.onOpen) {
        window.oz.commands.onOpen(() => this.toggle())
      }
      // Backstop: also listen for Cmd+K inside the renderer (some focus
      // states swallow native accelerators — e.g. when the WebContentsView
      // has focus, but the WebUI is below; this listener never fires there.
      // Still useful for keyboard testing inside the chrome).
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'k') {
          e.preventDefault()
          this.toggle()
        }
      })
      this.$input.addEventListener('input', () => this._refilter())
      this.$input.addEventListener('keydown', (e) => this._onInputKey(e))
      this.$modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) this.close()
      })
      this.$list.addEventListener('click', (e) => {
        const row = e.target.closest('[data-idx]')
        if (!row) return
        const idx = Number(row.getAttribute('data-idx'))
        if (!Number.isNaN(idx)) this._execute(idx)
      })
      this.$list.addEventListener('mousemove', (e) => {
        const row = e.target.closest('[data-idx]')
        if (!row) return
        const idx = Number(row.getAttribute('data-idx'))
        if (!Number.isNaN(idx) && idx !== this.selectedIdx) {
          this.selectedIdx = idx
          this._updateSelection()
        }
      })
    }

    async toggle() {
      if (this.isOpen) this.close()
      else await this.open()
    }

    async open() {
      this.isOpen = true
      this.$modal.hidden = false
      await safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      this.$input.value = ''
      this.commands = (await safe(window.oz.commands.list(), 'commands.list')) || []
      this._refilter()
      // Focus on next tick — DOM has to lay out the modal first.
      setTimeout(() => this.$input.focus(), 0)
    }

    close() {
      if (!this.isOpen) return
      this.isOpen = false
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
    }

    _refilter() {
      const q = this.$input.value
      this.results = matchAndRank(this.commands, q, { limit: 50 })
      this.selectedIdx = 0
      this._render()
    }

    _render() {
      if (this.results.length === 0) {
        this.$list.innerHTML = ''
        this.$empty.hidden = false
        return
      }
      this.$empty.hidden = true
      // Group rendered results visually by category, but only when the query
      // is empty. Filtered results stay in ranking order without category
      // headers (cleaner UX — Sublime/VS Code do this).
      const showHeaders = !this.$input.value.trim()
      let lastType = null
      const parts = []
      this.results.forEach((r, idx) => {
        if (showHeaders && r.command.type !== lastType) {
          parts.push(`<li class="cmdk-header">${categoryLabel(r.command.type)}</li>`)
          lastType = r.command.type
        }
        parts.push(renderRow(r, idx))
      })
      this.$list.innerHTML = parts.join('')
      this._updateSelection()
    }

    _updateSelection() {
      const rows = this.$list.querySelectorAll('[data-idx]')
      rows.forEach((el) => {
        const idx = Number(el.getAttribute('data-idx'))
        el.classList.toggle('selected', idx === this.selectedIdx)
        if (idx === this.selectedIdx) {
          el.scrollIntoView({ block: 'nearest' })
        }
      })
    }

    _onInputKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (this.results.length > 0) {
          this.selectedIdx = (this.selectedIdx + 1) % this.results.length
          this._updateSelection()
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (this.results.length > 0) {
          this.selectedIdx =
            (this.selectedIdx - 1 + this.results.length) % this.results.length
          this._updateSelection()
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this._execute(this.selectedIdx)
      }
    }

    async _execute(idx) {
      const item = this.results[idx]
      if (!item) return
      const payload = item.command.payload || {}
      const fn = this.executors[payload.action]
      if (!fn) {
        if (window.oz?.log) {
          window.oz.log.warn(
            'webui/command-palette',
            `no executor for action ${payload.action}`,
          )
        }
        return
      }
      const shouldClose = await fn(payload)
      if (shouldClose !== false) this.close()
    }
  }

  function categoryLabel(type) {
    switch (type) {
      case 'action':
        return 'Actions'
      case 'tab':
        return 'Tabs'
      case 'identity':
        return 'Identities'
      case 'workspace':
        return 'Workspaces'
      default:
        return 'Other'
    }
  }

  function renderRow(r, idx) {
    const c = r.command
    const accent = c.accent
      ? `<span class="cmdk-swatch" style="background:${escapeHtml(c.accent)}"></span>`
      : c.emoji
        ? `<span class="cmdk-emoji">${escapeHtml(c.emoji)}</span>`
        : '<span class="cmdk-swatch" style="background:transparent"></span>'
    const subtitle = c.subtitle
      ? `<div class="cmdk-subtitle">${escapeHtml(c.subtitle)}</div>`
      : ''
    const hint = c.hint ? `<div class="cmdk-hint">${escapeHtml(c.hint)}</div>` : ''
    const labelHtml = renderHighlighted(c.label, r.indices)
    return `
      <li class="cmdk-row" data-idx="${idx}">
        ${accent}
        <div class="cmdk-text">
          <div class="cmdk-label">${labelHtml}</div>
          ${subtitle}
        </div>
        ${hint}
      </li>`
  }

  window.OZ = window.OZ || {}
  window.OZ.CommandPaletteUI = CommandPaletteUI
})()
