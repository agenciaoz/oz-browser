// OZ Browser — In-page identity HUD setup (K1-extras / v1.4.3).
//
// Wirea el HUD widget end-to-end al ciclo de vida del browser.
//
// IMPORTANTE — pivot 2026-05-15: la versión inicial usaba el patrón
// `session.registerPreloadScript` (mismo que preload-fingerprint.js), pero
// resultó que en este build (Electron 42 + electron-forge webpack dev) los
// preloads sandboxeados fallan silenciosamente — la consola muestra el
// error sólo del primer preload (preload-content.js) y los demás
// (FP, HUD) parecen no cargar. Smoke visual 2026-05-15 confirmó que el
// preload NO ejecutaba (no había `[OZ HUD] preload loaded` log a pesar de
// que el archivo no tenía require relativos). Pivot: usamos
// `webContents.executeJavaScript()` desde main process al did-finish-load.
// Bypasea el sandbox, NO requiere preload registration, y el HUD es 100%
// data-injection (sin IPC desde la página).
//
// Trade-offs del pivot:
//   - Collapse state ya no se persiste per-identity al main (se guarda en
//     localStorage del site). Es un soft regression para v1.4.3 — el último
//     K1-extra (onboarding wizard) puede agregar persistencia full si Jose
//     lo pide.
//   - Click toggles necesitan re-execute desde main porque el page world no
//     puede llamar IPC. Por ahora collapse hace el toggle local (in-page)
//     sin notificar main. Click re-expand también local.
//   - Live updates siguen via webContents.send NO — usan re-execute.
//     Cada change broadcast trigger un nuevo executeJavaScript con la data
//     fresca.
//
// Doc: docs/modules/hud-widget.md (TODO al cerrar)
//
// Exports:
//   setupHud(browser, opts)     — wirea web-contents-created listener + broadcast wrap.
//   refreshHudOnTab(tab, browser) — exportado para callers que quieran forzar refresh.
//   broadcastHudUpdate(browser) — re-execute HUD en todos los tabs materializados.
//   HUD_REFRESH_CHANNELS         — Set inspeccionable para tests.

const log = require('./logger')

const HUD_REFRESH_CHANNELS = new Set([
  'oz:identities:changed',
  'oz:workspaces:changed',
  'oz:accounts:changed',
  'oz:proxies:changed',
  'oz:proxyAssignment:changed',
  'oz:proxyHealth:changed',
])

// Skip protocols where HUD doesn't make sense or would break the UI.
function shouldSkipUrl(url) {
  if (!url) return true
  return (
    url.startsWith('chrome-extension://') ||
    url.startsWith('chrome://') ||
    url.startsWith('devtools://') ||
    url === 'about:blank' ||
    url.startsWith('about:srcdoc')
  )
}

// Build the in-page injection script. Pure string-builder; takes the context
// blob (built by hud-handlers) and returns a JS source string to be passed
// to webContents.executeJavaScript(). All identity data is inlined as a
// JSON literal so the page world doesn't need IPC.
//
// The injected script is idempotent: if oz-hud-root already exists, it just
// updates the contents. No accumulation of multiple HUDs on re-execute.
function buildInjectionScript(ctx) {
  const builders = require('./preload-hud-script')
  if (!ctx || !ctx.identity) {
    // Remove any existing HUD (e.g. identity reassigned to default).
    return `(function(){
      var el = document.getElementById('oz-hud-root');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    })();`
  }
  const styles = builders.buildHudStyles()
  const expandedHtml = builders.buildExpandedHtml(ctx)
  const collapsedHtml = builders.buildCollapsedHtml(ctx)
  // Serialize as JSON for safe interpolation. JSON.stringify escapes quotes
  // and slashes properly, so we can inline into a script string.
  const payload = JSON.stringify({
    identityId: ctx.identity.id,
    styles,
    expandedHtml,
    collapsedHtml,
  })
  return `(function(){
    try {
      var data = ${payload};
      var KEY = '__oz_hud_collapsed_' + data.identityId;
      function ensureRoot() {
        var host = document.getElementById('oz-hud-root');
        if (host && host.__ozHud) return host;
        if (!document.body) return null;
        if (host && host.parentNode) host.parentNode.removeChild(host);
        host = document.createElement('div');
        host.id = 'oz-hud-root';
        host.style.all = 'initial';
        host.style.position = 'fixed';
        host.style.top = '0';
        host.style.right = '0';
        host.style.zIndex = '2147483647';
        host.style.pointerEvents = 'auto';
        document.body.appendChild(host);
        var shadow = host.attachShadow({ mode: 'closed' });
        var style = document.createElement('style');
        style.textContent = data.styles;
        shadow.appendChild(style);
        var container = document.createElement('div');
        container.id = 'container';
        shadow.appendChild(container);
        host.__ozHud = { shadow: shadow, container: container };
        container.addEventListener('click', function(ev) {
          var t = ev.composedPath && ev.composedPath()[0];
          if (!t || !t.dataset) return;
          var act = t.dataset.action;
          if (act === 'collapse') {
            ev.stopPropagation();
            try { window.localStorage.setItem(KEY, '1'); } catch (_e) {}
            container.innerHTML = data.collapsedHtml;
          } else if (act === 'expand') {
            ev.stopPropagation();
            try { window.localStorage.removeItem(KEY); } catch (_e) {}
            container.innerHTML = data.expandedHtml;
          }
        });
        return host;
      }
      var collapsed = false;
      try { collapsed = window.localStorage.getItem(KEY) === '1'; } catch (_e) {}
      function tryInject() {
        var host = ensureRoot();
        if (!host) {
          setTimeout(tryInject, 100);
          return;
        }
        host.__ozHud.container.innerHTML = collapsed ? data.collapsedHtml : data.expandedHtml;
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInject, { once: true });
      } else {
        tryInject();
      }
    } catch (_err) {
      // best-effort — never break the page
    }
  })();`
}

// Find the OZ identity for an Electron webContents.
// Strategy:
//   1) Match the wc against tabs[].webContents in browser.windows — this is
//      authoritative because Tab carries identityId explicitly.
//   2) Fall back to identityManager.identityIdForSession(wc.session) — may
//      return null if the session object isn't strict-equal to what's cached.
//   3) Final fallback to browser.activeIdentityId so the HUD at least shows
//      something on default-session pages.
function _identityIdForWebContents(browser, wc) {
  if (!browser || !wc) return null
  // Strategy 1: tab lookup by webContents reference.
  try {
    for (const win of browser.windows || []) {
      for (const tab of (win.tabs && win.tabs.tabList) || []) {
        if (tab && tab.webContents === wc) return tab.identityId || null
      }
    }
  } catch (_err) {
    /* defensive */
  }
  // Strategy 2: session-based lookup (legacy path).
  if (browser.identityManager) {
    try {
      const id = browser.identityManager.identityIdForSession(wc.session)
      if (id) return id
    } catch (_err) {
      /* defensive */
    }
  }
  // Strategy 3: active identity fallback.
  return browser.activeIdentityId || null
}

function refreshHudOnTab(browser, wc) {
  if (!wc || wc.isDestroyed()) return false
  const url = (() => {
    try {
      return wc.getURL()
    } catch (_e) {
      return ''
    }
  })()
  if (shouldSkipUrl(url)) return false
  const identityId = _identityIdForWebContents(browser, wc)
  if (!identityId) return false
  if (!browser.handlers || !browser.handlers.hud) return false
  let ctx
  try {
    ctx = browser.handlers.hud.getContext(identityId)
  } catch (err) {
    log.warn('hud-setup', 'getContext failed', { identityId, message: err.message })
    return false
  }
  const script = buildInjectionScript(ctx)
  try {
    wc.executeJavaScript(script, true).catch((err) => {
      log.debug('hud-setup', 'executeJavaScript rejected', {
        url,
        message: err.message,
      })
    })
    return true
  } catch (err) {
    log.warn('hud-setup', 'executeJavaScript threw', { url, message: err.message })
    return false
  }
}

function broadcastHudUpdate(browser) {
  if (!browser || !Array.isArray(browser.windows)) return 0
  let count = 0
  for (const win of browser.windows) {
    const tabs = (win && win.tabs && win.tabs.tabList) || []
    for (const tab of tabs) {
      if (tab && tab.materialized && tab.webContents && !tab.webContents.isDestroyed()) {
        if (refreshHudOnTab(browser, tab.webContents)) count++
      }
    }
  }
  return count
}

function setupHud(browser, _opts = {}) {
  if (!browser) return false
  if (browser._hudInstalled) {
    log.debug('hud-setup', 'setupHud called twice — skipping')
    return false
  }

  // 1) Inject HUD on every new webContents after its first navigation finishes.
  // We don't filter by getType() because materialized tabs report as 'remote'
  // in some Electron versions — filtering by URL (chrome-extension://, etc.)
  // inside refreshHudOnTab handles non-page contexts safely.
  const { app } = require('electron')
  app.on('web-contents-created', (_event, wc) => {
    if (!wc) return
    let type = 'unknown'
    try {
      type = wc.getType()
    } catch (_e) {
      /* defensive */
    }
    log.debug('hud-setup', 'web-contents-created', { type })
    const onFinish = () => {
      setTimeout(() => refreshHudOnTab(browser, wc), 50)
    }
    wc.on('did-finish-load', onFinish)
    wc.on('did-navigate-in-page', onFinish)
    // Also try immediately in case the page has already loaded (e.g. restored
    // tab whose webContents already fired did-finish-load before our listener).
    setTimeout(() => refreshHudOnTab(browser, wc), 200)
  })

  // 1.5) Also refresh ALL existing materialized tabs in 2s — covers the case
  // where windows were restored from snapshot BEFORE the web-contents-created
  // listener was attached.
  setTimeout(() => {
    try {
      const count = broadcastHudUpdate(browser)
      log.info('hud-setup', 'initial HUD refresh', { tabsHit: count })
    } catch (err) {
      log.warn('hud-setup', 'initial HUD refresh failed', { message: err.message })
    }
  }, 2000)

  // 2) Broadcast wrap — channel del whitelist → re-execute en todos los tabs.
  if (typeof browser.broadcastToWebUI === 'function') {
    const original = browser.broadcastToWebUI.bind(browser)
    browser.broadcastToWebUI = function (channel, ...args) {
      const result = original(channel, ...args)
      if (HUD_REFRESH_CHANNELS.has(channel)) {
        try {
          broadcastHudUpdate(browser)
        } catch (err) {
          log.warn('hud-setup', 'HUD broadcast failed', {
            channel,
            message: err.message,
          })
        }
      }
      return result
    }
    browser._broadcastHudUpdate = () => broadcastHudUpdate(browser)
  }

  browser._hudInstalled = true
  log.info('hud-setup', 'HUD installed (executeJavaScript injection mode)', {
    refreshChannels: Array.from(HUD_REFRESH_CHANNELS),
  })
  return true
}

module.exports = {
  setupHud,
  broadcastHudUpdate,
  refreshHudOnTab,
  buildInjectionScript,
  shouldSkipUrl,
  HUD_REFRESH_CHANNELS,
}
