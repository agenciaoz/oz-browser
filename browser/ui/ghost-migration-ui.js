// OZ Browser — Ghost Browser Migration Settings UI (G-3, v1).
//
// Renderiza la sección "Migration" del modal Settings. Flow simplificado
// (3 estados) vs el plan G-0 de 5 steps — el contenido es chico (counts,
// checkboxes, button) y no justifica un wizard multi-pantalla:
//
//   1. detectDone     — muestra "Found Ghost Browser at X" + counts +
//                       checkboxes + Import button
//   2. importing      — botón disabled, mensaje "Importing…", Keychain
//                       popup explainer (macOS) ya visible en el desc
//   3. done           — summary "Imported N identities, M workspaces, ..."
//                       + "Forget import history" button reappears
//
// Backend: window.oz.ghostMigration.* (preload bindings de G-3).
//
// Pattern: IIFE wrap, instance auto-inicializada al cargar settings.js
// (refresh() llamado cuando showSection('migration')).

;(function () {
  class GhostMigrationUI {
    constructor() {
      this.$section = document.querySelector('section[data-section="migration"]')
      if (!this.$section) return // markup no presente — modal viejo

      this.$detectPill = document.getElementById('oz-mig-detectPill')
      this.$detectDesc = document.getElementById('oz-mig-detectDesc')
      this.$stateRow = document.getElementById('oz-mig-stateRow')
      this.$stateDesc = document.getElementById('oz-mig-stateDesc')
      this.$clearStateBtn = document.getElementById('oz-mig-clearStateBtn')
      this.$err = document.getElementById('oz-mig-error')
      this.$preview = document.getElementById('oz-mig-preview')
      this.$importBtn = document.getElementById('oz-mig-importBtn')
      this.$progress = document.getElementById('oz-mig-progress')
      this.$progressTitle = document.getElementById('oz-mig-progressTitle')
      this.$progressDesc = document.getElementById('oz-mig-progressDesc')
      this.$summary = document.getElementById('oz-mig-summary')

      this.$opts = {
        importIdentities: document.getElementById('oz-mig-optIdentities'),
        importWorkspaces: document.getElementById('oz-mig-optWorkspaces'),
        importCookies: document.getElementById('oz-mig-optCookies'),
        importBookmarks: document.getElementById('oz-mig-optBookmarks'),
        importPasswords: document.getElementById('oz-mig-optPasswords'),
      }
      this.$cnt = {
        identities: document.getElementById('oz-mig-cntIdentities'),
        workspaces: document.getElementById('oz-mig-cntWorkspaces'),
        cookies: document.getElementById('oz-mig-cntCookies'),
        bookmarks: document.getElementById('oz-mig-cntBookmarks'),
        passwords: document.getElementById('oz-mig-cntPasswords'),
      }

      // G-5: import mode controls (merge|replace) — only visible when a
      // previous import exists.
      this.$modeBox = document.getElementById('oz-mig-modeBox')
      this.$modeMerge = document.getElementById('oz-mig-modeMerge')
      this.$modeReplace = document.getElementById('oz-mig-modeReplace')
      this.$modePrevCount = document.getElementById('oz-mig-modePrevCount')

      this._wireEvents()
    }

    _wireEvents() {
      if (this.$importBtn) {
        this.$importBtn.addEventListener('click', () => this._onImportClick())
      }
      if (this.$clearStateBtn) {
        this.$clearStateBtn.addEventListener('click', () => this._onClearStateClick())
      }
    }

    _setError(msg) {
      if (!this.$err) return
      if (msg) {
        this.$err.textContent = msg
        this.$err.hidden = false
      } else {
        this.$err.textContent = ''
        this.$err.hidden = true
      }
    }

    _setPill(text, kind) {
      if (!this.$detectPill) return
      this.$detectPill.textContent = text
      this.$detectPill.classList.remove(
        'oz-sync-pill-stopped',
        'oz-sync-pill-ok',
        'oz-sync-pill-running',
      )
      this.$detectPill.classList.add(
        kind === 'ok'
          ? 'oz-sync-pill-ok'
          : kind === 'running'
            ? 'oz-sync-pill-running'
            : 'oz-sync-pill-stopped',
      )
    }

    // Called by settings.js when user activates the Migration section.
    async refresh() {
      this._setError(null)
      if (!window.oz || !window.oz.ghostMigration) {
        this.$detectDesc.textContent = 'Migration backend not available.'
        this._setPill('—', 'stopped')
        return
      }

      // 1. Detect install
      let det
      try {
        det = await window.oz.ghostMigration.detect()
      } catch (err) {
        this._setError('Detection failed: ' + err.message)
        return
      }
      if (!det.found) {
        this.$detectDesc.textContent =
          'Ghost Browser is not installed in the standard location.'
        this._setPill('Not found', 'stopped')
        this.$preview.hidden = true
        this.$importBtn.hidden = true
        return
      }
      this.$detectDesc.textContent =
        `Found at ${det.dataDir}` + (det.version ? ` (v${det.version})` : '')
      this._setPill('Detected', 'ok')

      // 2. Sidecar state (already imported?)
      try {
        const state = await window.oz.ghostMigration.getState()
        this._renderState(state)
      } catch (_err) {
        // non-fatal
      }

      // 3. Dry-run counts
      try {
        const plan = await window.oz.ghostMigration.dryRun({})
        if (plan && plan.__error) {
          this._setError('Preview failed: ' + plan.__error.message)
          this.$preview.hidden = true
          this.$importBtn.hidden = true
          return
        }
        this._renderCounts(plan.counts)
        this.$preview.hidden = false
        this.$importBtn.hidden = false
      } catch (err) {
        this._setError('Preview failed: ' + err.message)
      }
    }

    _renderState(state) {
      if (!state) {
        this.$stateRow.hidden = true
        if (this.$modeBox) this.$modeBox.hidden = true
        // No previous import → force merge (replace makes no sense).
        if (this.$modeMerge) this.$modeMerge.checked = true
        return
      }
      const when = state.lastImportAt ? new Date(state.lastImportAt) : null
      const cnts = state.counts || {}
      const summary = `${cnts.identities || 0} identities, ${cnts.cookies || 0} cookies, ${cnts.passwords || 0} passwords`
      this.$stateDesc.textContent = when
        ? `${when.toLocaleString()} — imported ${summary}`
        : summary
      this.$stateRow.hidden = false
      // G-5: previous import exists — show mode chooser.
      if (this.$modeBox) {
        this.$modeBox.hidden = false
        if (this.$modePrevCount) {
          const idMapCount = Object.keys(state.identityMap || {}).length
          const wsMapCount = Object.keys(state.workspaceMap || {}).length
          this.$modePrevCount.textContent = `${idMapCount} identities and ${wsMapCount} workspaces`
        }
      }
    }

    _renderCounts(c) {
      if (!c) return
      this.$cnt.identities.textContent = c.identities || 0
      this.$cnt.workspaces.textContent = c.workspaces || 0
      this.$cnt.cookies.textContent = c.cookies || 0
      this.$cnt.bookmarks.textContent = c.bookmarks || 0
      this.$cnt.passwords.textContent = c.passwords || 0
    }

    _collectOptions() {
      // G-5: mode is 'replace' only if the replace radio is checked AND visible.
      // Default 'merge' covers all other cases (no previous import, or user
      // kept the default radio).
      const mode =
        this.$modeReplace && this.$modeReplace.checked && !this.$modeBox.hidden
          ? 'replace'
          : 'merge'
      return {
        importIdentities: !!this.$opts.importIdentities.checked,
        importWorkspaces: !!this.$opts.importWorkspaces.checked,
        importCookies: !!this.$opts.importCookies.checked,
        importBookmarks: !!this.$opts.importBookmarks.checked,
        importPasswords: !!this.$opts.importPasswords.checked,
        mode,
      }
    }

    async _onImportClick() {
      const opts = this._collectOptions()
      // G-5: confirm replace mode — it's destructive.
      if (opts.mode === 'replace') {
        const ok = window.confirm(
          'This will DELETE the identities and workspaces from your previous Ghost import, then re-import them fresh.\n\nExisting OZ identities/workspaces that were NOT imported from Ghost are not affected.\n\nContinue?',
        )
        if (!ok) return
      }
      this._setError(null)
      this.$importBtn.disabled = true
      this.$importBtn.textContent = 'Importing…'
      this.$progress.hidden = false
      this.$progressTitle.textContent = 'Importing…'
      this.$progressDesc.textContent =
        'macOS may show a Keychain dialog asking for access to "Ghost Browser Safe Storage". Click Always Allow.'
      this.$summary.hidden = true

      let summary
      try {
        summary = await window.oz.ghostMigration.runImport(opts)
      } catch (err) {
        this._setError('Import failed: ' + err.message)
        this._resetButton()
        return
      }
      if (summary && summary.__error) {
        this._setError(
          `Import failed (${summary.__error.code}): ${summary.__error.message}`,
        )
        this._resetButton()
        return
      }
      this._renderSummary(summary)
      this._resetButton()
      // Refresh sidecar state row
      try {
        const state = await window.oz.ghostMigration.getState()
        this._renderState(state)
      } catch (_err) {
        // ignore
      }
    }

    _renderSummary(summary) {
      this.$progressTitle.textContent = summary.ok
        ? '✓ Import complete'
        : '⚠ Import finished with issues'
      this.$progressDesc.textContent = ''
      const c = summary.counts || {}
      const lines = [
        `Mode: ${summary.mode || 'merge'}`,
        `Identities: ${c.identities || 0}`,
        `Workspaces: ${c.workspaces || 0}`,
        `Cookies: ${c.cookies || 0}`,
        `Bookmarks: ${c.bookmarks || 0}`,
        `Passwords: ${c.passwords || 0}`,
      ]
      // G-5: surface reused/removed counts so users see merge/replace effects.
      if (summary.reused) {
        const r = summary.reused
        if (r.identities || r.workspaces) {
          lines.push(
            `Reused: ${r.identities || 0} identities, ${r.workspaces || 0} workspaces`,
          )
        }
      }
      if (summary.removed) {
        const r = summary.removed
        if (r.identities || r.workspaces) {
          lines.push(
            `Removed (replace): ${r.identities || 0} identities, ${r.workspaces || 0} workspaces`,
          )
        }
      }
      if (summary.skipped) {
        const skip = []
        if (summary.skipped.cookies) skip.push(`${summary.skipped.cookies} cookies`)
        if (summary.skipped.passwords) skip.push(`${summary.skipped.passwords} passwords`)
        if (skip.length) lines.push(`Skipped: ${skip.join(', ')}`)
      }
      if (summary.keychainError) {
        lines.push(`Keychain: ${summary.keychainError} (cookies/passwords not imported)`)
      }
      if (summary.error) {
        lines.push(`Error: ${summary.error.code} — ${summary.error.message}`)
      }
      if (summary.rolledBack) {
        lines.push('Snapshot restored.')
      }
      this.$summary.innerHTML = lines.map((l) => `<div>${l}</div>`).join('')
      this.$summary.hidden = false
    }

    _resetButton() {
      this.$importBtn.disabled = false
      this.$importBtn.textContent = 'Import from Ghost Browser'
    }

    async _onClearStateClick() {
      try {
        await window.oz.ghostMigration.clearState()
        this.$stateRow.hidden = true
      } catch (err) {
        this._setError('Could not clear state: ' + err.message)
      }
    }
  }

  // Auto-instantiate when DOM is ready. Registers under window.OZ so
  // settings.js can call refresh() on section activation (same pattern
  // as window.OZ.scheduledActionsUI from F-4b).
  function init() {
    window.OZ = window.OZ || {}
    if (window.OZ.ghostMigrationUI) return
    window.OZ.ghostMigrationUI = new GhostMigrationUI()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
