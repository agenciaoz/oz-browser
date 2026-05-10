// OZ Browser — Account Manager render helpers (1.5f).
//
// Helpers puros (sin estado del modal) usados por account-manager.js:
//   - renderRow(account, idMap, wsMap, callbacks) → HTMLElement
//   - applyFilters(accounts, query) → filtered array
//   - populateSelect(selectEl, options, currentValue) → void
//
// Doc: docs/modules/ui-account-manager.md (extracción ADR 0005, <500 LOC).

;(function () {
  function chip(label, color) {
    const el = document.createElement('span')
    el.className = 'am-chip'
    const dot = document.createElement('span')
    dot.className = 'am-chip-dot'
    dot.style.background = color || '#8a8a8a'
    el.appendChild(dot)
    const txt = document.createElement('span')
    txt.textContent = label
    el.appendChild(txt)
    return el
  }

  function cell(klass, content) {
    const el = document.createElement('div')
    el.className = 'am-cell' + (klass ? ' ' + klass : '')
    if (content instanceof Node) el.appendChild(content)
    else if (content != null) el.textContent = String(content)
    return el
  }

  function statusBadge(status) {
    const s = status || 'active'
    const el = document.createElement('span')
    el.className = `am-status ${s}`
    el.textContent = s.replace('_', ' ')
    return el
  }

  function actionsCell(account, callbacks) {
    const wrap = document.createElement('div')
    wrap.className = 'am-row-actions'
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.title = 'Edit'
    editBtn.textContent = '✎'
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      callbacks.onEdit(account)
    })
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'danger'
    delBtn.title = 'Delete'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      callbacks.onDelete(account)
    })
    wrap.appendChild(editBtn)
    wrap.appendChild(delBtn)
    const c = cell()
    c.appendChild(wrap)
    return c
  }

  /**
   * Build a single account row (table-row layout).
   * callbacks: { onEdit(account), onDelete(account), onClick(account) }
   */
  function renderRow(account, idMap, wsMap, callbacks) {
    const row = document.createElement('div')
    row.className = 'am-row'
    row.dataset.id = account.id

    row.appendChild(cell('am-cell-site', account.site || ''))
    row.appendChild(cell('am-cell-username', account.username || ''))

    const ident = idMap[account.identityId]
    row.appendChild(
      cell(null, ident ? chip(ident.name, ident.color) : account.identityId || '—'),
    )

    const ws = account.workspaceId ? wsMap[account.workspaceId] : null
    row.appendChild(cell(null, ws ? chip(ws.name, ws.color) : '—'))

    row.appendChild(cell(null, statusBadge(account.status)))
    row.appendChild(actionsCell(account, callbacks))

    row.addEventListener('click', () => callbacks.onClick(account))
    return row
  }

  /**
   * Filter an account list by search query + identity/workspace/status.
   */
  function applyFilters(accounts, { query, identityId, workspaceId, status }) {
    const q = (query || '').trim().toLowerCase()
    return accounts.filter((a) => {
      if (identityId && a.identityId !== identityId) return false
      if (workspaceId && a.workspaceId !== workspaceId) return false
      if (status && (a.status || 'active') !== status) return false
      if (q) {
        const hay = `${a.site || ''} ${a.username || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }

  /**
   * Populate <select> with options [{value, label}], preserving currentValue.
   */
  function populateSelect(selectEl, items, currentValue, placeholder) {
    const cur = currentValue != null ? currentValue : selectEl.value
    selectEl.innerHTML = ''
    if (placeholder !== undefined) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = placeholder
      selectEl.appendChild(opt)
    }
    for (const it of items) {
      const opt = document.createElement('option')
      opt.value = it.value
      opt.textContent = it.label
      selectEl.appendChild(opt)
    }
    selectEl.value = cur
  }

  window.OZ = window.OZ || {}
  window.OZ.AccountManagerRender = { renderRow, applyFilters, populateSelect }
})()
