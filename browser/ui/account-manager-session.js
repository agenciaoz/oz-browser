// OZ Browser — Account Manager · Session-token import view (1.7.1).
//
// Qué hace: maneja la 5ta vista del Account Manager modal (oz-am-session-view).
// Permite pegar un cookie request header string (name=value; name=value; ...)
// + domain + identity y bindearlo al cookie jar de Chromium per-identity via
// window.oz.cookies.importContent(id, 'header', str, {defaultDomain}).
//
// Sibling de account-manager.js (split por ADR 0005 — 500 LOC budget).
//
// Exports: window.OZ.AccountManagerSession.attach(am)
//   donde `am` es la instancia AccountManager. Lee de am.$session*, am.state,
//   am._showView. Llama am.$btnSessionImport para feedback de busy state.
//
// IPC: window.oz.cookies.importContent (1.7.0+ con 4to options.defaultDomain).

;(function () {
  const t = (key, params) =>
    window.OZ && window.OZ.i18n ? window.OZ.i18n.t(key, params) : key
  const safe = window.OZ && window.OZ.utils && window.OZ.utils.safe

  function attach(am) {
    if (!am || !am.$viewSession || !am.$btnSession) return

    am.$btnSession.addEventListener('click', () => openView(am))
    am.$btnSessionCancel.addEventListener('click', () => am._showView('list'))
    am.$btnSessionImport.addEventListener('click', () => doImport(am))
  }

  function openView(am) {
    // Populate identity dropdown with current identities. Accept all
    // (user picks); future iteration could filter archived/locked.
    am.$sessionIdentity.innerHTML = ''
    for (const id of am.state.identities || []) {
      const opt = document.createElement('option')
      opt.value = id.id
      opt.textContent = id.isDefault ? `${id.name} (Default)` : id.name || id.id
      am.$sessionIdentity.appendChild(opt)
    }
    // Reset form state on each open — don't leak previous attempt's values.
    am.$sessionDomain.value = ''
    am.$sessionCookies.value = ''
    am.$sessionResult.hidden = true
    am.$sessionResult.textContent = ''
    am.$sessionResult.removeAttribute('data-kind')
    am._showView('session')
    // UX nicety — focus domain field so paste flow is keyboard-only.
    setTimeout(() => am.$sessionDomain && am.$sessionDomain.focus(), 30)
  }

  async function doImport(am) {
    const identityId = am.$sessionIdentity.value
    const domain = (am.$sessionDomain.value || '').trim()
    const cookieString = (am.$sessionCookies.value || '').trim()

    if (!identityId || !domain || !cookieString) {
      renderResult(am, 'error', t('accountManager.session.errorRequired'))
      return
    }

    am.$btnSessionImport.disabled = true
    const original = am.$btnSessionImport.textContent
    am.$btnSessionImport.textContent = t('accountManager.session.importingBtn')

    const r = await safe(
      window.oz.cookies.importContent(identityId, 'header', cookieString, {
        defaultDomain: domain,
      }),
      'cookies.importContent',
    )

    am.$btnSessionImport.disabled = false
    am.$btnSessionImport.textContent = original

    if (!r || r.ok === false) {
      const reason = (r && r.reason) || 'unknown'
      const msg =
        reason === 'missing-default-domain'
          ? t('accountManager.session.errorMissingDomain')
          : t('accountManager.session.errorFailed', { reason })
      renderResult(am, 'error', msg)
      return
    }

    renderResult(
      am,
      'ok',
      t('accountManager.session.successCount', {
        n: r.written || 0,
        total: r.parsedCount || 0,
        errors: (r.errors && r.errors.length) || 0,
      }),
    )
  }

  function renderResult(am, kind, msg) {
    am.$sessionResult.dataset.kind = kind
    am.$sessionResult.textContent = msg
    am.$sessionResult.style.color =
      kind === 'ok' ? 'var(--green, #2a8f4b)' : 'var(--red, #c04444)'
    am.$sessionResult.hidden = false
  }

  window.OZ = window.OZ || {}
  window.OZ.AccountManagerSession = { attach }
})()
