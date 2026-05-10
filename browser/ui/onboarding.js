// OZ Browser — First-run onboarding modal (1.10c).
//
// Doc: docs/modules/ui-onboarding.md
//
// 3 pantallas: Identities → Workspaces+Vault → Proxies+Fingerprint+MCP.
// Trigger: si settings.onboarding.completed === false al boot, abre el modal
// automáticamente. User puede Skip (marca completed=true con timestamp) o
// completar las 3 pantallas (marca completed=true sin timestamp).
//
// Idempotente: solo se muestra una vez por instalación. Si el user quiere
// re-verlo, debe resetSection('onboarding') desde Settings.

;(function () {
  const { safe } = window.OZ.utils

  class OnboardingUI {
    constructor() {
      this.$modal = document.getElementById('oz-onb-modal')
      if (!this.$modal) {
        if (window.oz && window.oz.log) {
          window.oz.log.warn('webui/onboarding', 'modal markup missing')
        }
        return
      }
      this.$next = document.getElementById('oz-onb-next')
      this.$back = document.getElementById('oz-onb-back')
      this.$skip = document.getElementById('oz-onb-skip')
      this.$skipX = document.getElementById('oz-onb-skip-x')
      this.$dots = this.$modal.querySelectorAll('.onb-dot')
      this.$screens = [
        document.getElementById('oz-onb-1'),
        document.getElementById('oz-onb-2'),
        document.getElementById('oz-onb-3'),
      ]
      this.current = 0
      this._wire()
    }

    _wire() {
      this.$next.addEventListener('click', () => this.next())
      this.$back.addEventListener('click', () => this.back())
      this.$skip.addEventListener('click', () => this.handleSkip())
      this.$skipX.addEventListener('click', () => this.handleSkip())
    }

    /** Called at boot — opens the modal only if onboarding hasn't been done. */
    async maybeOpen() {
      const onb = await safe(window.oz.settings.get('onboarding'), 'settings.get')
      if (onb && onb.completed) return false
      this.open()
      return true
    }

    open() {
      this.$modal.hidden = false
      safe(window.oz.ui.setContentVisible(false), 'ui.setContentVisible')
      this.current = 0
      this.render()
    }

    close() {
      this.$modal.hidden = true
      safe(window.oz.ui.setContentVisible(true), 'ui.setContentVisible')
    }

    render() {
      this.$screens.forEach((s, i) => {
        s.hidden = i !== this.current
      })
      this.$dots.forEach((d, i) => {
        d.classList.toggle('active', i === this.current)
      })
      this.$back.hidden = this.current === 0
      this.$next.textContent =
        this.current === this.$screens.length - 1 ? 'Get started' : 'Next'
    }

    next() {
      if (this.current < this.$screens.length - 1) {
        this.current += 1
        this.render()
      } else {
        this.handleComplete()
      }
    }

    back() {
      if (this.current > 0) {
        this.current -= 1
        this.render()
      }
    }

    async handleComplete() {
      await safe(
        window.oz.settings.set('onboarding', { completed: true }),
        'settings.set onboarding',
      )
      this.close()
    }

    async handleSkip() {
      await safe(
        window.oz.settings.set('onboarding', {
          completed: true,
          skippedAt: Date.now(),
        }),
        'settings.set onboarding skipped',
      )
      this.close()
    }
  }

  window.OZ = window.OZ || {}
  window.OZ.OnboardingUI = OnboardingUI
})()
