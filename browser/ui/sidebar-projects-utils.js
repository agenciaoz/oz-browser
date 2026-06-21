// OZ Browser — Projects sidebar pure helpers (F2 UI). Dual-export (node+browser).
//
// Lógica sin DOM para la sección "Proyectos" del sidebar: etiquetas, orden y
// validación de nombre. El módulo con DOM vive en sidebar-projects.js.
//
// ADR: 0005 (modular).

;(function () {
  'use strict'

  /** Etiqueta legible del tipo de proyecto. */
  function typeLabel(type) {
    if (type === 'session') return 'Todo'
    return 'Workspace'
  }

  /**
   * Resumen de un proyecto para la fila: "<n> tab(s) · <tipo>".
   * @param {{type?:string, tabCount?:number}} p
   */
  function projectSummary(p) {
    const n = p && Number.isFinite(p.tabCount) ? p.tabCount : 0
    const tabs = `${n} ${n === 1 ? 'tab' : 'tabs'}`
    return `${tabs} · ${typeLabel(p && p.type)}`
  }

  /** Ordena por más reciente (createdAt desc). Copia, no muta. */
  function sortProjects(list) {
    if (!Array.isArray(list)) return []
    return list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  /** Normaliza un nombre tipeado; devuelve '' si queda vacío. */
  function cleanName(name) {
    return typeof name === 'string' ? name.trim() : ''
  }

  const api = { typeLabel, projectSummary, sortProjects, cleanName }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') {
    window.OZ = window.OZ || {}
    window.OZ.SidebarProjectsUtils = api
  }
})()
