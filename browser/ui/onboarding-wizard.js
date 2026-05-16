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

  // v1.5.0: i18n helper — falls back to the key itself if i18n not loaded.
  function t(key, params) {
    if (window.OZ && typeof window.OZ.t === 'function') return window.OZ.t(key, params)
    return key
  }

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
      this.$next.textContent =
        this.current === STEP_COUNT - 1 ? t('wizard.finish') : t('wizard.continue')
      this.$back.textContent = t('wizard.back')
      this.$skip.textContent = t('wizard.skip')
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
          <h2>${escapeHtml(t('wizard.step1.title'))}</h2>
          <p class="onb-tagline">${escapeHtml(t('wizard.step1.tagline'))}</p>
          <label class="wiz-field">
            <span>${escapeHtml(t('wizard.step1.nameLabel'))}</span>
            <input type="text" id="wiz-ws-name" placeholder="${escapeHtml(t('wizard.step1.namePlaceholder'))}" value="${escapeHtml(this.state.workspaceName || '')}" />
          </label>
          <label class="wiz-field">
            <span>${escapeHtml(t('wizard.step1.colorLabel'))}</span>
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
        if (status) status.textContent = t('wizard.step1.errNameRequired')
        return false
      }
      try {
        const ws = await window.oz.workspaces.create({ name, color })
        if (!ws || !ws.id) {
          if (status) status.textContent = t('wizard.step1.errFailed')
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
          <h2>${escapeHtml(t('wizard.step2.title'))}</h2>
          <p class="onb-tagline">${t('wizard.step2.tagline')}</p>
          <textarea id="wiz-proxy-text" class="wiz-textarea" placeholder="us-pr.oxylabs.io:10001:customer-foo:secret&#10;mx.example.com:8080:user:pass" rows="6"></textarea>
          <p class="wiz-hint">${escapeHtml(t('wizard.step2.hint'))}</p>
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
          if (status) status.textContent = t('wizard.step2.errParse')
          return false
        }
        const valid = parsed.rows.filter((r) => r.ok)
        if (valid.length === 0) {
          if (status) {
            status.textContent = t('wizard.step2.errZeroValid', {
              n: parsed.summary.invalid,
            })
          }
          return false
        }
        const result = await window.oz.proxyImporter.import(valid.map((r) => r.proxy))
        if (!result || !result.ok) {
          if (status) {
            status.textContent =
              t('wizard.step2.errImport') +
              ' ' +
              (result && result.failed && result.failed[0] && result.failed[0].reason)
          }
          return false
        }
        this.state.proxyIds = result.addedIds || []
        if (status)
          status.textContent = t('wizard.step2.successAdded', { n: result.added })
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
      const prefix = this.state.workspaceName || 'Account'
      return `
        <div class="wiz-step">
          <div class="onb-emoji">👤</div>
          <h2>${escapeHtml(t('wizard.step3.title'))}</h2>
          <p class="onb-tagline">${escapeHtml(t('wizard.step3.tagline'))}</p>
          <label class="wiz-field">
            <span>${escapeHtml(t('wizard.step3.countLabel'))}</span>
            <input type="number" id="wiz-id-count" min="1" max="50" value="${suggestion}" />
          </label>
          <label class="wiz-field">
            <span>${escapeHtml(t('wizard.step3.prefixLabel'))}</span>
            <input type="text" id="wiz-id-prefix" value="${escapeHtml(prefix)}" />
          </label>
          <p class="wiz-hint">${t('wizard.step3.previewHint', { prefix: escapeHtml(prefix), workspace: escapeHtml(this.state.workspaceName || 'this workspace') })}</p>
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
        if (status) status.textContent = t('wizard.step3.errNoWorkspace')
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
            status.textContent = t('wizard.step3.partial', {
              done: created.length,
              total: count,
              message: err.message || 'unknown',
            })
          }
          this.state.identityIds = created
          return created.length > 0
        }
      }
      this.state.identityIds = created
      if (status) {
        status.textContent = t('wizard.step3.successCreated', { n: created.length })
      }
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
          <h2>${escapeHtml(t('wizard.step4.title'))}</h2>
          <p class="onb-tagline">${escapeHtml(t('wizard.step4.tagline'))}</p>
          <ul class="wiz-summary">
            <li>${t('wizard.step4.proxiesInPool', { n: `<strong>${pCount}</strong>` })}</li>
            <li>${t('wizard.step4.identitiesCreated', { n: `<strong>${iCount}</strong>` })}</li>
            <li>${t('wizard.step4.pairsAssigned', { n: `<strong>${pairCount}</strong>` })}</li>
            ${pCount > iCount ? `<li>${t('wizard.step4.extraProxies', { n: pCount - iCount })}</li>` : ''}
            ${iCount > pCount ? `<li>${t('wizard.step4.noProxyIdentities', { n: iCount - pCount })}</li>` : ''}
          </ul>
          ${canPair ? '' : `<p class="wiz-hint">${escapeHtml(t('wizard.step4.nothingToPair'))}</p>`}
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
          this.state.assignedPairs = []
          return true
        }
        const result = await window.oz.proxyBulkAssign.execute(preview.pairings)
        this.state.assignedPairs = preview.pairings
        if (status) {
          status.textContent =
            result && result.failed > 0
              ? t('wizard.step4.successAssignedWithFails', {
                  n: preview.pairings.length,
                  f: result.failed,
                })
              : t('wizard.step4.successAssigned', { n: preview.pairings.length })
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
            <h2>${escapeHtml(t('wizard.step5.title'))}</h2>
            <p class="onb-tagline">${escapeHtml(t('wizard.step5.tagline'))}</p>
            <p class="wiz-hint">${t('wizard.step5.hint')}</p>
          </div>
        `
      }
      const ok = tested.ok || 0
      const fail = tested.fail || 0
      const total = tested.total || 0
      return `
        <div class="wiz-step">
          <div class="onb-emoji">${fail === 0 ? '✅' : '⚠️'}</div>
          <h2>${escapeHtml(t('wizard.step5.doneTitle'))}</h2>
          <p class="onb-tagline">${t('wizard.step5.doneTagline', { n: total, ok, fail })}</p>
          <p class="wiz-hint">${escapeHtml(t(fail > 0 ? 'wizard.step5.doneIssues' : 'wizard.step5.doneOk'))}</p>
          <p class="wiz-hint">${t('wizard.step5.summary', {
            ws: escapeHtml(this.state.workspaceName || ''),
            i: this.state.identityIds.length,
            p: this.state.proxyIds.length,
          })}</p>
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
