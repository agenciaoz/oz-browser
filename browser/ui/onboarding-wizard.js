// OZ Browser — Onboarding action wizard 5-step (K1-extras / v1.4.6).
//
// Doc: docs/modules/onboarding-wizard.md (TODO al cerrar)
//
// 5 pasos guiados que arman el setup core de OZ para un new user:
//   1. Workspace — crea un workspace con nombre + color.
//   2. Proxies — paste/import N proxies en bulk.
//   3. Identities — crea N identities dentro del workspace.
//   4. Asignar — 1:1 pairing de proxies a identities (auto si counts match).
//   5. Test — corre proxyHealth.testAll() sobre los proxies recién agregados.
//
// Diferencia con `onboarding.js` (welcome 3-screen info): este wizard ES
// action-oriented — cada paso CREA recursos en OZ. El welcome es solo info.
//
// Trigger: botón "Setup my workspace" en el último step del welcome, OR
// programáticamente via `window.OZ.OnboardingWizard.open()` desde Settings.
//
// State: setSettings('onboardingWizard.completed' = true) en finish OR skip.
// Idempotent — abrir un wizard cerrado retoma desde el step 0 con form fresh
// (no preserva form data mid-wizard — Jose's setup es one-shot per install).

;(function () {
  const { safe } = window.OZ && window.OZ.utils ? window.OZ.utils : { safe: (p) => p }

  const STEP_COUNT = 5
  const DEFAULT_WORKSPACE_COLOR = '#5b8def'

  class OnboardingWizard {
    constructor() {
      this.$modal = document.getElementById('oz-wiz-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/onboarding-wizard', 'modal markup missing')
        }
        return
      }
      this.$body = this.$modal.querySelector('.wiz-body')
      this.$next = this.$modal.querySelector('.wiz-next')
      this.$back = this.$modal.querySelector('.wiz-back')
      this.$skip = this.$modal.querySelector('.wiz-skip')
      this.$skipX = this.$modal.querySelector('.wiz-skip-x')
      this.$dots = this.$modal.querySelectorAll('.wiz-dot')
      this.current = 0
      this.state = {
        workspaceId: null,
        workspaceName: '',
        proxyIds: [],
        identityIds: [],
        assignedPairs: [],
        testResults: null,
      }
      this._wire()
    }

    _wire() {
      this.$next.addEventListener('click', () => this.onNext())
      this.$back.addEventListener('click', () => this.onBack())
      this.$skip.addEventListener('click', () => this.handleSkip())
      this.$skipX.addEventListener('click', () => this.handleSkip())
    }

    open() {
      this.$modal.hidden = false
      safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      this.current = 0
      this.state = {
        workspaceId: null,
        workspaceName: '',
        proxyIds: [],
        identityIds: [],
        assignedPairs: [],
        testResults: null,
      }
      this.render()
    }

    close() {
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
    }

    render() {
      this.$dots.forEach((d, i) => {
        d.classList.toggle('active', i === this.current)
        d.classList.toggle('done', i < this.current)
      })
      this.$back.hidden = this.current === 0
      this.$next.textContent = this.current === STEP_COUNT - 1 ? 'Finish' : 'Continue'
      this.$body.innerHTML = this._renderStep(this.current)
      // Re-wire any inputs in the freshly rendered step.
      this._wireStep(this.current)
    }

    _renderStep(idx) {
      if (idx === 0) return this._renderWorkspaceStep()
      if (idx === 1) return this._renderProxiesStep()
      if (idx === 2) return this._renderIdentitiesStep()
      if (idx === 3) return this._renderAssignStep()
      if (idx === 4) return this._renderTestStep()
      return ''
    }

    _wireStep(idx) {
      if (idx === 1) {
        const ta = this.$body.querySelector('#wiz-proxy-text')
        if (ta) ta.focus()
      }
    }

    // ---- Step 0: workspace ----
    _renderWorkspaceStep() {
      return `
        <div class="wiz-step">
          <div class="onb-emoji">🗂️</div>
          <h2>Step 1 — Create a workspace</h2>
          <p class="onb-tagline">Workspaces group identities per project. Name it after the project or client.</p>
          <label class="wiz-field">
            <span>Workspace name</span>
            <input type="text" id="wiz-ws-name" placeholder="e.g. Client Alpha — Instagram" value="${escapeHtml(this.state.workspaceName || '')}" />
          </label>
          <label class="wiz-field">
            <span>Color</span>
            <input type="color" id="wiz-ws-color" value="${DEFAULT_WORKSPACE_COLOR}" />
          </label>
          <div class="wiz-status" id="wiz-ws-status"></div>
        </div>
      `
    }

    async _doWorkspaceStep() {
      const nameEl = this.$body.querySelector('#wiz-ws-name')
      const colorEl = this.$body.querySelector('#wiz-ws-color')
      const status = this.$body.querySelector('#wiz-ws-status')
      const name = (nameEl && nameEl.value.trim()) || ''
      const color = (colorEl && colorEl.value) || DEFAULT_WORKSPACE_COLOR
      if (!name) {
        if (status) status.textContent = 'Name is required.'
        return false
      }
      try {
        const ws = await window.oz.workspaces.create({ name, color })
        if (!ws || !ws.id) {
          if (status) status.textContent = 'Failed to create workspace.'
          return false
        }
        this.state.workspaceId = ws.id
        this.state.workspaceName = ws.name
        return true
      } catch (err) {
        if (status) status.textContent = 'Error: ' + (err.message || 'unknown')
        return false
      }
    }

    // ---- Step 1: proxies ----
    _renderProxiesStep() {
      return `
        <div class="wiz-step">
          <div class="onb-emoji">🌐</div>
          <h2>Step 2 — Add proxies</h2>
          <p class="onb-tagline">One per line: <code>host:port:user:pass</code> or <code>user:pass@host:port</code>.</p>
          <textarea id="wiz-proxy-text" class="wiz-textarea" placeholder="us-pr.oxylabs.io:10001:customer-foo:secret&#10;mx.example.com:8080:user:pass" rows="6"></textarea>
          <p class="wiz-hint">Tip: skip this step if you already have proxies configured — you can add more from the Proxy Dashboard later.</p>
          <div class="wiz-status" id="wiz-proxy-status"></div>
        </div>
      `
    }

    async _doProxiesStep() {
      const ta = this.$body.querySelector('#wiz-proxy-text')
      const status = this.$body.querySelector('#wiz-proxy-status')
      const text = (ta && ta.value.trim()) || ''
      if (!text) {
        // Skipping proxies is allowed — user can add later.
        this.state.proxyIds = []
        return true
      }
      try {
        const parsed = await window.oz.proxyImporter.parse(text)
        if (!parsed || !parsed.rows) {
          if (status) status.textContent = 'Could not parse any proxies.'
          return false
        }
        const valid = parsed.rows.filter((r) => r.ok)
        if (valid.length === 0) {
          if (status) {
            status.textContent = `0 valid proxies (${parsed.summary.invalid} invalid). Fix and retry.`
          }
          return false
        }
        const result = await window.oz.proxyImporter.import(valid.map((r) => r.proxy))
        if (!result || !result.ok) {
          if (status) {
            status.textContent =
              'Import failed: ' +
              (result && result.failed && result.failed[0] && result.failed[0].reason)
          }
          return false
        }
        this.state.proxyIds = result.addedIds || []
        if (status) status.textContent = `✓ Added ${result.added} proxies.`
        return true
      } catch (err) {
        if (status) status.textContent = 'Error: ' + (err.message || 'unknown')
        return false
      }
    }

    // ---- Step 2: identities ----
    _renderIdentitiesStep() {
      const proxyCount = this.state.proxyIds.length
      const suggestion = proxyCount > 0 ? proxyCount : 3
      return `
        <div class="wiz-step">
          <div class="onb-emoji">👤</div>
          <h2>Step 3 — Create identities</h2>
          <p class="onb-tagline">Each identity is a fully isolated session (cookies, storage, login). Common: 1 per social media account.</p>
          <label class="wiz-field">
            <span>How many?</span>
            <input type="number" id="wiz-id-count" min="1" max="50" value="${suggestion}" />
          </label>
          <label class="wiz-field">
            <span>Name prefix</span>
            <input type="text" id="wiz-id-prefix" value="${escapeHtml(this.state.workspaceName || 'Account')}" />
          </label>
          <p class="wiz-hint">Identities will be named "<span id="wiz-id-preview">${escapeHtml(this.state.workspaceName || 'Account')} 1</span>", "${escapeHtml(this.state.workspaceName || 'Account')} 2", … and live inside <strong>${escapeHtml(this.state.workspaceName || 'this workspace')}</strong>.</p>
          <div class="wiz-status" id="wiz-id-status"></div>
        </div>
      `
    }

    async _doIdentitiesStep() {
      const countEl = this.$body.querySelector('#wiz-id-count')
      const prefixEl = this.$body.querySelector('#wiz-id-prefix')
      const status = this.$body.querySelector('#wiz-id-status')
      const count = Math.max(
        1,
        Math.min(50, parseInt((countEl && countEl.value) || '0', 10)),
      )
      const prefix = (prefixEl && prefixEl.value.trim()) || 'Account'
      if (!this.state.workspaceId) {
        if (status) status.textContent = 'No workspace created — go back to step 1.'
        return false
      }
      const created = []
      for (let i = 1; i <= count; i++) {
        try {
          const ident = await window.oz.identities.create({
            name: `${prefix} ${i}`,
            workspaceId: this.state.workspaceId,
          })
          if (ident && ident.id) created.push(ident.id)
        } catch (err) {
          if (status) {
            status.textContent = `Created ${created.length} of ${count} before error: ${err.message || 'unknown'}`
          }
          this.state.identityIds = created
          return created.length > 0
        }
      }
      this.state.identityIds = created
      if (status) status.textContent = `✓ Created ${created.length} identities.`
      return created.length > 0
    }

    // ---- Step 3: assign ----
    _renderAssignStep() {
      const pCount = this.state.proxyIds.length
      const iCount = this.state.identityIds.length
      const canPair = pCount > 0 && iCount > 0
      const pairCount = Math.min(pCount, iCount)
      return `
        <div class="wiz-step">
          <div class="onb-emoji">🔗</div>
          <h2>Step 4 — Pair proxies to identities</h2>
          <p class="onb-tagline">1:1 mapping — each identity gets its own proxy.</p>
          <ul class="wiz-summary">
            <li><strong>${pCount}</strong> proxies in pool</li>
            <li><strong>${iCount}</strong> identities created</li>
            <li><strong>${pairCount}</strong> pairs will be assigned</li>
            ${pCount > iCount ? `<li>${pCount - iCount} extra proxies stay unassigned (use later)</li>` : ''}
            ${iCount > pCount ? `<li>${iCount - pCount} identities will use no proxy (direct)</li>` : ''}
          </ul>
          ${canPair ? '' : '<p class="wiz-hint">Nothing to pair. You can skip this step and assign later from the Proxy Dashboard.</p>'}
          <div class="wiz-status" id="wiz-assign-status"></div>
        </div>
      `
    }

    async _doAssignStep() {
      const status = this.$body.querySelector('#wiz-assign-status')
      const pCount = this.state.proxyIds.length
      const iCount = this.state.identityIds.length
      if (pCount === 0 || iCount === 0) {
        // Allow advancing — nothing to pair.
        this.state.assignedPairs = []
        return true
      }
      try {
        const preview = await window.oz.proxyBulkAssign.preview(
          this.state.proxyIds,
          this.state.identityIds,
        )
        if (!preview || !preview.pairings || preview.pairings.length === 0) {
          if (status) status.textContent = 'No pairings to apply.'
          this.state.assignedPairs = []
          return true
        }
        const result = await window.oz.proxyBulkAssign.execute(preview.pairings)
        this.state.assignedPairs = preview.pairings
        if (status) {
          status.textContent = `✓ Assigned ${preview.pairings.length} pairs${result && result.failed > 0 ? ` (${result.failed} failed)` : ''}.`
        }
        return true
      } catch (err) {
        if (status) status.textContent = 'Error: ' + (err.message || 'unknown')
        return false
      }
    }

    // ---- Step 4: test ----
    _renderTestStep() {
      const tested = this.state.testResults
      if (!tested) {
        return `
          <div class="wiz-step">
            <div class="onb-emoji">🩺</div>
            <h2>Step 5 — Test the setup</h2>
            <p class="onb-tagline">We'll ping all assigned proxies and confirm they're reachable.</p>
            <p class="wiz-hint">Click <strong>Finish</strong> below to run the tests. This takes 5–30s depending on proxy count.</p>
          </div>
        `
      }
      const ok = tested.ok || 0
      const fail = tested.fail || 0
      const total = tested.total || 0
      return `
        <div class="wiz-step">
          <div class="onb-emoji">${fail === 0 ? '✅' : '⚠️'}</div>
          <h2>Setup complete</h2>
          <p class="onb-tagline">Tested ${total} proxies: <strong>${ok}</strong> ok, <strong>${fail}</strong> failed.</p>
          ${fail > 0 ? '<p class="wiz-hint">Some proxies failed — check the Proxy Dashboard to inspect. They are auto-disabled after 3 failures.</p>' : '<p class="wiz-hint">All systems green. You can start opening tabs in your new identities from the sidebar.</p>'}
          <p class="wiz-hint">Workspace <strong>${escapeHtml(this.state.workspaceName || '')}</strong> · ${this.state.identityIds.length} identities · ${this.state.proxyIds.length} proxies</p>
        </div>
      `
    }

    async _doTestStep() {
      const status = this.$body.querySelector('#wiz-status') // unused but defensive
      void status
      try {
        const r =
          this.state.proxyIds.length > 0
            ? await window.oz.proxyHealth.testAllAndStatus()
            : { counts: { total: 0, ok: 0, fail: 0 } }
        const counts = (r && r.counts) || { total: 0, ok: 0, fail: 0 }
        this.state.testResults = {
          total: counts.total || 0,
          ok: counts.ok || 0,
          fail: counts.fail || 0,
        }
      } catch (_err) {
        this.state.testResults = { total: 0, ok: 0, fail: 0 }
      }
      // Re-render to show results.
      this.render()
      return true
    }

    // ---- Nav ----
    async onNext() {
      this.$next.disabled = true
      try {
        const ok = await this._executeStep(this.current)
        if (!ok) return
        if (this.current < STEP_COUNT - 1) {
          this.current += 1
          this.render()
        } else {
          await this.handleComplete()
        }
      } finally {
        this.$next.disabled = false
      }
    }

    _executeStep(idx) {
      if (idx === 0) return this._doWorkspaceStep()
      if (idx === 1) return this._doProxiesStep()
      if (idx === 2) return this._doIdentitiesStep()
      if (idx === 3) return this._doAssignStep()
      if (idx === 4) return this._doTestStep()
      return Promise.resolve(true)
    }

    onBack() {
      if (this.current > 0) {
        this.current -= 1
        this.render()
      }
    }

    async handleComplete() {
      await safe(
        window.oz.settings.set('onboardingWizard', { completed: true }),
        'settings.set onboardingWizard',
      )
      this.close()
    }

    async handleSkip() {
      await safe(
        window.oz.settings.set('onboardingWizard', {
          completed: true,
          skippedAt: Date.now(),
          skippedAtStep: this.current,
        }),
        'settings.set onboardingWizard skipped',
      )
      this.close()
    }
  }

  function escapeHtml(s) {
    if (s == null) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  window.OZ = window.OZ || {}
  window.OZ.OnboardingWizard = OnboardingWizard
  window.OZ.OnboardingWizardStepCount = STEP_COUNT
})()
