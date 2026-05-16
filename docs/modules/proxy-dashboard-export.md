# Módulo `proxy-dashboard-export`

**Path:** `browser/ui/proxy-dashboard-export.js`
**Líneas:** ~45 (IIFE)
**Bloque/Etapa:** H-2 extras (v1.1.6)

## Qué hace

Tiny sibling module que wira el botón "Export diag" en el proxy-dashboard header al IPC `oz:proxyHealth:exportDiagnostic`. Extraído del proxy-dashboard.js para mantener ese archivo bajo el 500 LOC budget (ADR 0005).

## API

```js
window.OZ_DashboardExport = {
  wire(btn, t)   // attach click handler to a button element
}
```

## Click handler flow

1. Check `window.oz.proxyHealth.exportDiagnostic` bridge available, else alert "Export bridge unavailable".
2. Disable button + await `bridge()`.
3. On `r.ok` → alert "Diagnostic exported to: <path>".
4. On cancel (`r.reason === 'CANCELED'`) → silent.
5. On other failure → alert "Export failed: <reason/message>".
6. Re-enable button in finally.

## Consumers

- `browser/ui/proxy-dashboard.js` `wire()` block:
  ```js
  if (window.OZ_DashboardExport) {
    window.OZ_DashboardExport.wire(document.getElementById('btn-export-diag'), t)
  }
  ```
- `browser/ui/proxy-dashboard.html` carga el script entre `proxy-dashboard-leaks.js` y `proxy-dashboard.js`.

## Backend

`browser/proxy-diagnostic-export.js` + IPC handler `oz:proxyHealth:exportDiagnostic` en `browser/ipc-handlers-extra.js`.
