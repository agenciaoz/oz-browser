// OZ Browser — Workspace switcher (deprecated post-H3c).
//
// Hasta H3b este archivo renderizaba pills horizontales con todos los
// workspaces (top of the sidebar). En H3c Jose pidió un árbol jerárquico
// unificado en el sidebar — workspaces top-level con sus identities y tabs
// anidadas dentro. La funcionalidad de "click a workspace para activarlo +
// right-click ctx menu + drag-drop drop target + create new + show archived"
// migró toda a sidebar.js.
//
// Mantenemos la clase como no-op + export para no romper webui.js.boot. El
// container HTML y los botones (+ New Workspace / Show archived) siguen en el
// DOM porque sidebar.js los hookea directo en su constructor.
//
// Eliminar este archivo + el script tag + el container HTML es una limpieza
// para una sub-fase post-H3c (junto con el header "Identities" → "WORKSPACES").

;(function () {
  class WorkspaceSwitcher {
    constructor() {
      // No-op: sidebar.js handles workspaces inline in the tree.
    }
    async init() {
      // No-op.
    }
  }
  window.OZ.WorkspaceSwitcher = WorkspaceSwitcher
})()
