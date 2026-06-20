// OZ Browser — Ephemeral (throwaway) identity cleanup decision (F3). Pure.
//
// Una identidad `ephemeral` se autodestruye cuando se cierra su última tab.
// Esta pieza decide si corresponde limpiar, dado el estado actual de tabs.
// El wiring (remover la identity + notificar) vive en tab-handlers.close.
//
// ADR: 0005 (modular).

'use strict'

/**
 * ¿Hay que limpiar esta identidad efímera? Sí cuando es ephemeral y NO quedan
 * tabs (en ninguna ventana) usándola.
 *
 * @param {{id:string, ephemeral?:boolean}|null} identity
 * @param {Array<{identityId?:string}>} remainingTabs  tabs vivas tras el cierre.
 * @returns {boolean}
 */
function shouldCleanupEphemeral(identity, remainingTabs) {
  if (!identity || !identity.ephemeral || typeof identity.id !== 'string') return false
  const tabs = Array.isArray(remainingTabs) ? remainingTabs : []
  return !tabs.some((t) => t && t.identityId === identity.id)
}

module.exports = { shouldCleanupEphemeral }
