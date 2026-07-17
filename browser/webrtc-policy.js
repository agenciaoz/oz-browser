// OZ Browser — WebRTC IP-handling policy decider (v3 anti-detect, alpha.109).
//
// Qué hace: decide qué política de WebRTC aplicar por webContents para que
// WebRTC NO filtre la IP real del operador por UDP fuera del proxy. Es lógica
// pura (sin Electron) para test determinista (ADR 0005); el wiring que llama
// a `webContents.setWebRTCIPHandlingPolicy(...)` vive en tabs.js, y el
// resolver por-identity se instala en proxy-boot-setup.js.
//
// Contexto: `leak-tests.js` DETECTA el leak de WebRTC (analiza ICE
// candidates); esto lo PREVIENE en la fuente. Complementa "todo proxiado
// siempre" (regla Jose 2026-07-16): si la identity va por proxy, WebRTC
// también — nada de UDP directo revelando la IP de la oficina.
//
// Valores de política de Chromium/Electron:
//   - 'default'                       — comportamiento normal (puede filtrar).
//   - 'default_public_interface_only' — oculta IPs privadas/host, deja la
//                                       pública de la interfaz por defecto.
//   - 'disable_non_proxied_udp'       — SOLO UDP proxeado; si el proxy no hace
//                                       UDP, cae a TCP/TURN. Cero leak. Puede
//                                       degradar calidad de video calls.
//
// Doc: docs/modules/webrtc-policy.md
// ADR: docs/architecture/0041-webrtc-audio-antidetect.md

'use strict'

const POLICIES = {
  DEFAULT: 'default',
  PUBLIC_ONLY: 'default_public_interface_only',
  PROXY_ONLY: 'disable_non_proxied_udp',
}

/**
 * Decide the WebRTC IP-handling policy for a tab.
 *
 * @param {object} ctx
 * @param {'proxy'|'direct'|'none'} [ctx.routingMode='none'] — resultado de
 *   proxyAssignment.resolveRouting (alpha.108).
 * @param {boolean} [ctx.enforce=false] — fail-closed activo (install managed).
 * @param {string} [ctx.override] — override explícito del user
 *   (settings.privacy.webrtcPolicy): uno de los valores de POLICIES.
 * @returns {string} policy string apto para setWebRTCIPHandlingPolicy.
 */
function decideWebRtcPolicy(ctx = {}) {
  const { routingMode = 'none', enforce = false, override } = ctx

  // 1. Override explícito del user gana sobre todo (poder salir del default).
  if (override && Object.values(POLICIES).includes(override)) {
    return override
  }

  // 2. Opt-out directo explícito (alpha.108): el user eligió su IP real para
  //    esta identity y el tráfico YA va directo (sticky-rotation: direct gana
  //    sobre enforce). Forzar 'disable_non_proxied_udp' sin proxy rompería
  //    WebRTC sin ganar privacidad (la IP real ya se expone por HTTP). Solo
  //    ocultamos IPs privadas/host — barato, sin costo de UX. Coherente con
  //    la decisión de ruteo.
  if (routingMode === 'direct') {
    return POLICIES.PUBLIC_ONLY
  }

  // 3. Identity proxeada, o install fail-closed sin proxy resoluble (y sin
  //    opt-out directo): forzar WebRTC por el proxy (o nada). Protege la IP
  //    real — es el caso central de "todo proxiado siempre".
  if (routingMode === 'proxy' || enforce) {
    return POLICIES.PROXY_ONLY
  }

  // 4. Sin proxy y sin enforce (dev / master): comportamiento normal.
  return POLICIES.DEFAULT
}

module.exports = { decideWebRtcPolicy, POLICIES }
