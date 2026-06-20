// OZ Browser — "Open link in identity" menu builder (Ghost-style, F1).
//
// Pieza PURA: dada la lista de identidades, devuelve los descriptores de los
// items del submenú "Abrir link en…" que se muestra al hacer click derecho
// sobre un link dentro de una página. El wiring a Electron (construir los
// MenuItem con sus click handlers y abrir el link en la identity elegida) vive
// en extensions-setup.js, que llama a esto.
//
// Cada descriptor: { label, action, identityId? }
//   action: 'open'      → abrir el link en la identity `identityId`
//           'open-temp' → crear identity temporal y abrir ahí
//           'open-new'  → crear identity nueva (con nombre) y abrir ahí
//
// ADR: 0016 (tab-context-menu) · 0005 (modular).

'use strict'

/**
 * @param {object} args
 * @param {Array<{id:string,name:string,isDefault?:boolean}>} args.identities
 * @param {string} [args.activeIdentityId]  marca la identidad activa.
 * @returns {Array<{label:string, action:string, identityId?:string}>}
 */
function openInIdentityItems({ identities, activeIdentityId } = {}) {
  const list = Array.isArray(identities) ? identities : []
  const items = []
  for (const id of list) {
    if (!id || typeof id.id !== 'string') continue
    const name = (id.name || 'Identity').trim() || 'Identity'
    const suffix =
      id.id === activeIdentityId ? ' (actual)' : id.isDefault ? ' (default)' : ''
    items.push({ label: `${name}${suffix}`, action: 'open', identityId: id.id })
  }
  // Acciones de creación al final, separadas conceptualmente.
  items.push({ label: 'Nueva identidad temporal', action: 'open-temp' })
  items.push({ label: 'Nueva identidad…', action: 'open-new' })
  return items
}

module.exports = { openInIdentityItems }
