// OZ Browser — Warm-up de proxies al activar un workspace (alpha.109).
//
// Idea de Jose (2026-07-16): "cuando se le da click al workspace, todos los
// identities hagan el handshake con su proxy". Con proxy móvil el CONNECT+TLS
// al gateway cuesta 600-900ms; hacerlo por adelantado al abrir el workspace
// saca ese costo del camino crítico del primer click en cada identity.
//
// Cómo: por cada identity con tabs en el workspace recién activado, se
// asegura su sesión (getSession aplica el proxy vía el hook de boot) y se
// hace `session.preconnect({url})` hacia el origin que ESA identity ya tiene
// abierto — así calentamos el túnel hacia una página que el user ya visita
// (cero destinos nuevos sospechosos para anti-detect).
//
// `planWarmup` es pura (sin Electron) para test determinista (ADR 0005); el
// wiring que toca `getSession`/`preconnect` vive en `runWarmup`.
//
// Doc: docs/modules/proxy-warmup.md
// ADR: docs/architecture/0041-webrtc-audio-antidetect.md (sección warm-up)

'use strict'

function safeOrigin(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const o = new URL(url).origin
    return o && o.startsWith('http') ? o : null
  } catch (_e) {
    return null
  }
}

/**
 * Decide qué sesiones calentar y hacia qué origin. Deduplica por identity y
 * prefiere el origin de la tab más reciente de esa identity en el workspace.
 *
 * @param {object} args
 * @param {Array<{identityId,url,workspaceId,lastSelectedAt}>} args.tabs — tabs
 *   del workspace (ya filtradas por window/workspace, o con workspaceId).
 * @param {string} [args.workspaceId] — si se pasa, filtra tabs por él.
 * @returns {Array<{identityId, origin}>} plan de warm-up (origin puede ser
 *   null → solo asegurar sesión+proxy, sin preconnect).
 */
function planWarmup({ tabs, workspaceId } = {}) {
  const rows = Array.isArray(tabs) ? tabs : []
  const byIdentity = new Map() // identityId → {origin, ts}
  for (const t of rows) {
    if (!t || !t.identityId) continue
    if (workspaceId && t.workspaceId && t.workspaceId !== workspaceId) continue
    const origin = safeOrigin(t.url)
    const ts = t.lastSelectedAt || t.createdAt || 0
    const prev = byIdentity.get(t.identityId)
    // Guardamos el mejor origin (tab más reciente con origin http válido).
    if (!prev) {
      byIdentity.set(t.identityId, { origin, ts })
    } else if (origin && (!prev.origin || ts >= prev.ts)) {
      byIdentity.set(t.identityId, { origin, ts })
    }
  }
  return Array.from(byIdentity.entries()).map(([identityId, v]) => ({
    identityId,
    origin: v.origin || null,
  }))
}

/**
 * Ejecuta el warm-up: por cada entrada del plan, asegura la sesión (aplica el
 * proxy) y hace preconnect al origin si hay uno. Best-effort — nunca tira.
 *
 * @param {object} browser — instancia Browser (tiene identityManager).
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {object} [opts.log]
 * @returns {{warmed:number, preconnected:number}}
 */
function runWarmup(browser, workspaceId, opts = {}) {
  const log = opts.log
  const im = browser && browser.identityManager
  if (!im || typeof im.getSession !== 'function') return { warmed: 0, preconnected: 0 }

  // Reunir tabs del workspace desde todas las ventanas que lo muestran.
  const tabs = []
  for (const win of (browser && browser.windows) || []) {
    const list = win.tabs && win.tabs.tabList
    if (!list) continue
    const wsOfWin = win.workspaceId
    for (const t of list) {
      tabs.push({
        identityId: t.identityId,
        url:
          t.pendingUrl ||
          (t.webContents && !t.webContents.isDestroyed() ? t.webContents.getURL() : '') ||
          '',
        workspaceId: wsOfWin,
        lastSelectedAt: t.lastSelectedAt,
        createdAt: t.createdAt,
      })
    }
  }

  const plan = planWarmup({ tabs, workspaceId })
  let warmed = 0
  let preconnected = 0
  for (const { identityId, origin } of plan) {
    try {
      const ses = im.getSession(identityId) // aplica proxy vía hook de boot
      if (!ses) continue
      warmed++
      if (origin && typeof ses.preconnect === 'function') {
        ses.preconnect({ url: origin, numSockets: 2 })
        preconnected++
      }
    } catch (_e) {
      /* best-effort per identity */
    }
  }
  if (log && log.info) {
    log.info('proxy-warmup', 'warmed workspace proxies', {
      workspaceId,
      warmed,
      preconnected,
    })
  }
  return { warmed, preconnected }
}

module.exports = { planWarmup, runWarmup, safeOrigin }
