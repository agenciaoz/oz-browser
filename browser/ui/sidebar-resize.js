// OZ Browser — Sidebar collapse + resize (alpha.35, Ghost parity).
//
// Ghost lets you resize the sidebar by dragging its right edge and collapse it
// to a minimal width (support art. 323). This module adds both to OZ:
//   - drag the right edge to resize (clamped MIN..MAX), width persisted.
//   - a ⟨ / ⟩ button toggles collapsed (hides content), state persisted.
//
// Self-initializing, no backend. Width is applied to the --sidebar-width CSS
// var which #oz-sidebar already consumes.

;(function () {
  'use strict'

  const MIN_W = 160
  const MAX_W = 420
  const WIDTH_KEY = 'oz-sidebar-width'
  const COLLAPSED_KEY = 'oz-sidebar-collapsed'

  function setWidth(px) {
    document.documentElement.style.setProperty('--sidebar-width', px + 'px')
  }

  function init() {
    const sidebar = document.getElementById('oz-sidebar')
    if (!sidebar || sidebar.dataset.resizeWired) return
    sidebar.dataset.resizeWired = '1'

    // Restore persisted width + collapsed state.
    const savedW = parseInt(localStorage.getItem(WIDTH_KEY), 10)
    if (savedW >= MIN_W && savedW <= MAX_W) setWidth(savedW)
    if (localStorage.getItem(COLLAPSED_KEY) === '1') sidebar.classList.add('collapsed')

    // Collapse / expand button.
    const btn = document.createElement('button')
    btn.id = 'oz-sidebar-collapse'
    btn.type = 'button'
    btn.title = 'Collapse / expand sidebar'
    const sync = () => {
      btn.textContent = sidebar.classList.contains('collapsed') ? '⟩' : '⟨'
    }
    btn.addEventListener('click', () => {
      const collapsed = sidebar.classList.toggle('collapsed')
      try {
        localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
      } catch (_e) {
        /* ignore */
      }
      sync()
    })
    sync()
    sidebar.appendChild(btn)

    // Drag-to-resize handle on the right edge.
    const handle = document.createElement('div')
    handle.id = 'oz-sidebar-resize'
    sidebar.appendChild(handle)

    let dragging = false
    handle.addEventListener('mousedown', (e) => {
      if (sidebar.classList.contains('collapsed')) return
      e.preventDefault()
      dragging = true
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      const left = sidebar.getBoundingClientRect().left
      const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(e.clientX - left)))
      setWidth(w)
    })
    window.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const cur = parseInt(
        getComputedStyle(document.documentElement)
          .getPropertyValue('--sidebar-width')
          .trim(),
        10,
      )
      if (cur) {
        try {
          localStorage.setItem(WIDTH_KEY, String(cur))
        } catch (_e) {
          /* ignore */
        }
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
