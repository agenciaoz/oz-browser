// OZ Browser — Sidebar tab-row renderer (alpha.40).
//
// Extracted from sidebar.js (ADR 0005 LOC budget — sidebar.js was at 500/500
// and needed room for identity tag chips). Pure DOM builder that takes the
// sidebar instance for its callbacks/state. Behaviour unchanged.

;(function () {
  'use strict'
  const { safe } = window.OZ.utils

  function render(sidebar, tab, identity) {
    const row = document.createElement('div')
    row.className = 'tree-row tab-row'
    row.dataset.tabId = tab.id
    if (!tab.isLoaded) row.classList.add('lazy')
    if (tab.id === sidebar.activeOzTabId) row.classList.add('active')

    row.draggable = true
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/oz-tab-id', tab.id)
      ev.dataTransfer.effectAllowed = 'move'
      row.classList.add('dragging')
    })
    row.addEventListener('dragend', () => row.classList.remove('dragging'))

    const fav = document.createElement('span')
    fav.className = 'tree-favicon'
    if (tab.favicon) {
      const img = document.createElement('img')
      img.src = tab.favicon
      img.style.width = '12px'
      img.style.height = '12px'
      fav.appendChild(img)
    } else {
      fav.classList.add('lazy')
      fav.style.background = identity.color
    }
    row.appendChild(fav)

    const title = document.createElement('span')
    title.className = 'tree-name'
    const baseTitle = tab.title || tab.url || 'New Tab'
    title.textContent = tab.locked ? `🔒 ${baseTitle}` : baseTitle
    title.title = tab.url || ''
    row.appendChild(title)

    if (!tab.locked) {
      const close = document.createElement('button')
      close.className = 'oz-close'
      close.textContent = '✕'
      close.addEventListener('click', (e) => sidebar.handleCloseTab(tab.id, e))
      row.appendChild(close)
    }

    row.addEventListener('click', () => sidebar.handleSelectTab(tab.id))
    row.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (window.oz.tabs.contextMenu) {
        await safe(
          window.oz.tabs.contextMenu(tab.id, { x: ev.clientX, y: ev.clientY }),
          'tabs.contextMenu',
        )
      }
    })
    return row
  }

  window.OZ = window.OZ || {}
  window.OZ.SidebarTabRow = { render }
})()
