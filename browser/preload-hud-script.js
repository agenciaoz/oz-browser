// OZ Browser — In-page identity HUD pure builder (K1-extras / v1.4.3).
//
// Funciones puras (cero deps Electron) para armar el HTML/CSS del HUD widget
// que el preload `preload-hud.js` inyecta en el shadow DOM de cada tab. Mismo
// patrón split que `preload-fingerprint-script.js` — el módulo "renderless" es
// testeable directo desde node sin Electron.
//
// Doc: docs/modules/hud-widget.md (TODO al cerrar)
//
// Exports:
//   countryToFlag(code)        — 'MX' → 🇲🇽 (Regional Indicator Symbols).
//   ipLastOctets(host)         — '186.32.144.18' → '·144.18' (ofusca pero da seña).
//   escapeHtml(s)              — defensivo: identity.name puede contener < > & " '.
//   buildHudStyles()           — string con TODO el CSS del HUD (shadow scope).
//   buildExpandedHtml(ctx)     — HTML del estado expanded.
//   buildCollapsedHtml(ctx)    — HTML del estado pill mini.
//   sessionPill(session)       — clase CSS (green|amber|red|gray) por status.
//   pillTitle(session)         — tooltip i18n-agnostic (EN canónico por ahora).
//
// El ctx blob viene del handler IPC `oz:hud:getContext` y tiene shape:
//   { identity: {id, name, color, isDefault} | null,
//     workspace: {id, name, color} | null,
//     proxy: {id, country, host, port, protocol, healthy} | null,
//     session: {status: 'green'|'amber'|'red'|'gray'|'locked'|'needs_relogin'|'unknown'} }

const REGIONAL_INDICATOR_A = 0x1f1e6 // 'A' regional indicator codepoint
const CHAR_A = 65

/**
 * 'MX' → 🇲🇽. Returns '' si code no es exactly 2 letters [A-Z]. Tolera
 * lowercase + whitespace antes de bailar.
 */
function countryToFlag(code) {
  if (!code) return ''
  const trimmed = String(code).trim().toUpperCase()
  if (trimmed.length !== 2) return ''
  if (!/^[A-Z]{2}$/.test(trimmed)) return ''
  const cp1 = REGIONAL_INDICATOR_A + (trimmed.charCodeAt(0) - CHAR_A)
  const cp2 = REGIONAL_INDICATOR_A + (trimmed.charCodeAt(1) - CHAR_A)
  return String.fromCodePoint(cp1, cp2)
}

/**
 * Para IPv4 retorna '·<last2octets>' (privacidad: no revelamos el /24). Para
 * hostname retorna el primer label clamped a 12 chars. Sin host → ''.
 */
function ipLastOctets(host) {
  if (!host) return ''
  const ipv4 = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/)
  if (ipv4) return `·${ipv4[3]}.${ipv4[4]}`
  const label = String(host).split('.')[0] || ''
  return label.length > 12 ? label.slice(0, 12) + '…' : label
}

/** Defensivo: identity.name puede contener < > & " ' que romperían el HTML. */
function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Resuelve status raw → clase CSS green|amber|red|gray. */
function sessionPill(session) {
  if (!session || !session.status) return 'gray'
  const s = session.status
  if (s === 'needs_relogin' || s === 'red') return 'red'
  if (s === 'warn' || s === 'amber') return 'amber'
  if (s === 'locked' || s === 'unknown' || s === 'gray') return 'gray'
  return 'green'
}

/** Tooltip humano (EN canónico — el HUD entra a i18n cobertura full en 1.5.0). */
function pillTitle(session) {
  if (!session || !session.status) return 'Session status unknown'
  const s = session.status
  if (s === 'needs_relogin') return 'Session needs re-login'
  if (s === 'locked') return 'Vault locked — session status hidden'
  if (s === 'unknown') return 'Session status unknown'
  if (s === 'warn' || s === 'amber') return 'Session warning'
  return 'Session healthy'
}

/** Genera las iniciales del badge (max 2 chars). Fallback '??' si no name. */
function badgeInitials(name) {
  if (!name) return '??'
  return String(name).trim().slice(0, 2).toUpperCase()
}

function buildHudStyles() {
  // Shadow DOM scope: :host garantiza aislamiento total del CSS del sitio.
  // z-index 2147483647 = INT32_MAX → siempre por encima.
  return `
    :host {
      all: initial;
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    .hud {
      background: rgba(20, 20, 20, 0.92);
      color: #fff;
      border-radius: 10px;
      padding: 8px 10px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      line-height: 1.2;
      min-width: 220px;
      max-width: 320px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      cursor: default;
      user-select: none;
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
    }
    .hud.collapsed {
      min-width: 0;
      padding: 6px 10px 6px 6px;
      border-radius: 16px;
      cursor: pointer;
    }
    .badge {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 500;
      font-size: 12px;
      flex-shrink: 0;
      color: #fff;
    }
    .hud.collapsed .badge {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      font-size: 11px;
    }
    .body {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .title {
      font-weight: 500;
      font-size: 12px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub {
      display: flex;
      gap: 6px;
      align-items: center;
      color: rgba(255, 255, 255, 0.7);
      font-size: 11px;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub .sep { opacity: 0.4; }
    .pill {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .hud.collapsed .pill {
      width: 6px;
      height: 6px;
    }
    .pill.green  { background: #639922; }
    .pill.amber  { background: #ef9f27; }
    .pill.red    { background: #e24b4a; }
    .pill.gray   { background: rgba(255, 255, 255, 0.4); }
    .toggle {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.5);
      cursor: pointer;
      padding: 2px 4px;
      font-size: 13px;
      line-height: 1;
    }
    .toggle:hover { color: #fff; }
  `
}

function buildExpandedHtml(ctx) {
  const identity = (ctx && ctx.identity) || {}
  const workspace = ctx && ctx.workspace
  const proxy = ctx && ctx.proxy
  const session = ctx && ctx.session
  const init = badgeInitials(identity.name)
  const color = identity.color || '#5b8def'
  const name = identity.name || 'Unknown identity'
  const flag = countryToFlag(proxy && proxy.country)
  const ip = ipLastOctets(proxy && proxy.host)
  const subParts = []
  if (workspace && workspace.name) {
    subParts.push(`<span>${escapeHtml(workspace.name)}</span>`)
  }
  if (flag) {
    if (subParts.length > 0) subParts.push('<span class="sep">·</span>')
    subParts.push(`<span>${flag}</span>`)
  }
  if (ip) {
    if (subParts.length > 0) subParts.push('<span class="sep">·</span>')
    subParts.push(`<span>${escapeHtml(ip)}</span>`)
  }
  const pillClass = sessionPill(session)
  const pillTip = pillTitle(session)
  return (
    `<div class="hud" data-state="expanded" role="status">` +
    `<div class="badge" style="background:${escapeHtml(color)}">${escapeHtml(init)}</div>` +
    `<div class="body">` +
    `<div class="title">${escapeHtml(name)}</div>` +
    `<div class="sub">${subParts.join('')}</div>` +
    `</div>` +
    `<div class="pill ${pillClass}" title="${escapeHtml(pillTip)}"></div>` +
    `<button class="toggle" data-action="collapse" aria-label="Collapse HUD">›</button>` +
    `</div>`
  )
}

function buildCollapsedHtml(ctx) {
  const identity = (ctx && ctx.identity) || {}
  const session = ctx && ctx.session
  const init = badgeInitials(identity.name)
  const color = identity.color || '#5b8def'
  const pillClass = sessionPill(session)
  const pillTip = pillTitle(session)
  return (
    `<div class="hud collapsed" data-state="collapsed" role="status" data-action="expand">` +
    `<div class="badge" style="background:${escapeHtml(color)}">${escapeHtml(init)}</div>` +
    `<div class="pill ${pillClass}" title="${escapeHtml(pillTip)}"></div>` +
    `</div>`
  )
}

module.exports = {
  countryToFlag,
  ipLastOctets,
  escapeHtml,
  badgeInitials,
  sessionPill,
  pillTitle,
  buildHudStyles,
  buildExpandedHtml,
  buildCollapsedHtml,
}
