// OZ Browser — UI Prompt (v1.8.3).
//
// Qué hace: helper async window.OZ.ui.prompt(message, opts?) para reemplazar
// window.prompt() nativo. Chromium en chrome-extension pages de Electron
// deshabilita los native dialogs prompt/alert/confirm — `window.prompt()`
// retorna null sin mostrar UI. Esto causaba que botones como "New Workspace"
// en sidebar.js parecieran no hacer nada.
//
// API:
//   await window.OZ.ui.prompt('Workspace name')   // returns string | null
//   await window.OZ.ui.prompt('Identity name', {
//     defaultValue: '',
//     placeholder: 'e.g. IG Maria',
//     okLabel: 'Create',
//     cancelLabel: 'Cancel',
//   })
//
// Returns the user's input string on OK / Enter, null on Cancel / Escape /
// backdrop click. Trims trailing whitespace. Empty string after trim → null
// (caller can decide if that counts as cancel).
//
// Visual: small centered modal with backdrop. Matches OZ palette (dark
// elevated bg, white text, accent border on focus). Auto-focuses the input
// on open so the user can start typing immediately.
//
// Pattern: IIFE registers window.OZ.ui.prompt singleton. Idempotent.

;(function () {
  function ozPrompt(message, opts) {
    opts = opts || {}
    return new Promise((resolve) => {
      // v1.9.2: per ADR 0011 (modals hide content view), we MUST hide the
      // WebContentsView before showing any HTML modal — otherwise the
      // WebContentsView (which lives in a separate Chromium layer above
      // the HTML) covers the entire center of the window and the modal
      // is invisible regardless of z-index. Fire-and-forget; restore on
      // close. The .catch silences the (rare) IPC error so the prompt
      // still functions even if the IPC is briefly unavailable.
      if (window.oz && window.oz.ui && window.oz.ui.setContentVisible) {
        try {
          window.oz.ui.setContentVisible(false).catch(() => {})
        } catch (_e) {
          /* defensive */
        }
      }

      // Build modal DOM dynamically — no HTML markup required in webui.html.
      const backdrop = document.createElement('div')
      backdrop.className = 'oz-prompt-backdrop'
      Object.assign(backdrop.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        background: 'rgba(0, 0, 0, 0.55)',
        zIndex: '99999',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      })

      const modal = document.createElement('div')
      modal.className = 'oz-prompt-modal'
      Object.assign(modal.style, {
        background: 'var(--bg-elevated, #2a2a35)',
        color: 'var(--text-color, #fff)',
        borderRadius: '10px',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.6)',
        padding: '20px 22px',
        minWidth: '360px',
        maxWidth: '480px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        fontFamily: 'inherit',
      })

      const label = document.createElement('div')
      label.textContent = message || ''
      Object.assign(label.style, {
        fontSize: '14px',
        marginBottom: '12px',
        fontWeight: '500',
      })

      const input = document.createElement('input')
      input.type = 'text'
      input.value = opts.defaultValue || ''
      input.placeholder = opts.placeholder || ''
      Object.assign(input.style, {
        width: '100%',
        padding: '9px 12px',
        fontSize: '14px',
        background: 'rgba(0, 0, 0, 0.25)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: '6px',
        color: 'inherit',
        font: 'inherit',
        boxSizing: 'border-box',
        outline: 'none',
      })
      input.addEventListener('focus', () => {
        input.style.borderColor = 'var(--accent, #6488ff)'
      })
      input.addEventListener('blur', () => {
        input.style.borderColor = 'rgba(255, 255, 255, 0.15)'
      })

      const actions = document.createElement('div')
      Object.assign(actions.style, {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
        marginTop: '16px',
      })

      const btnCancel = document.createElement('button')
      btnCancel.type = 'button'
      btnCancel.textContent = opts.cancelLabel || 'Cancel'
      Object.assign(btnCancel.style, {
        padding: '7px 14px',
        background: 'transparent',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: '6px',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      })

      const btnOk = document.createElement('button')
      btnOk.type = 'button'
      btnOk.textContent = opts.okLabel || 'OK'
      Object.assign(btnOk.style, {
        padding: '7px 14px',
        background: 'var(--accent, #6488ff)',
        border: 'none',
        borderRadius: '6px',
        color: '#fff',
        font: 'inherit',
        fontWeight: '600',
        cursor: 'pointer',
      })

      actions.appendChild(btnCancel)
      actions.appendChild(btnOk)
      modal.appendChild(label)
      modal.appendChild(input)
      modal.appendChild(actions)
      backdrop.appendChild(modal)
      document.body.appendChild(backdrop)

      // Focus the input after the modal is in the DOM. setTimeout 0 lets
      // the browser finish appending before we focus.
      setTimeout(() => input.focus(), 0)

      let resolved = false
      function done(value) {
        if (resolved) return
        resolved = true
        document.removeEventListener('keydown', onKeyDown, true)
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop)
        // v1.9.2: restore the WebContentsView. Pairs with the hide call at
        // the top of ozPrompt — keeps the tab content visible again.
        if (window.oz && window.oz.ui && window.oz.ui.setContentVisible) {
          try {
            window.oz.ui.setContentVisible(true).catch(() => {})
          } catch (_e) {
            /* defensive */
          }
        }
        resolve(value)
      }

      function onKeyDown(ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          const v = (input.value || '').trim()
          done(v || null)
        } else if (ev.key === 'Escape') {
          ev.preventDefault()
          done(null)
        }
      }

      btnOk.addEventListener('click', () => {
        const v = (input.value || '').trim()
        done(v || null)
      })
      btnCancel.addEventListener('click', () => done(null))
      backdrop.addEventListener('click', (ev) => {
        // Click on backdrop (not modal itself) cancels.
        if (ev.target === backdrop) done(null)
      })
      document.addEventListener('keydown', onKeyDown, true)
    })
  }

  window.OZ = window.OZ || {}
  window.OZ.ui = window.OZ.ui || {}
  window.OZ.ui.prompt = ozPrompt
})()
