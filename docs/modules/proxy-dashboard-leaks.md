# Módulo `proxy-dashboard-leaks`

**Path:** `browser/ui/proxy-dashboard-leaks.js`
**Líneas:** ~135 (IIFE)
**Bloque/Etapa:** H-2j (v1.1.4)

## Qué hace

UI helper que wraps `window.oz.leakTest.*` para integrar leak tests al proxy-dashboard. Render botón "Leak test" + result badge per-identity, run on demand, format result dialog.

## API

```js
window.OZ_DashboardLeaks = {
  fetchLeakMap,          // → Map<identityId, record> (cached only, no fresh runs)
  renderLeakButton(identity, leakRecord, t, esc),  // → HTML
  buildLeakSummary(record, t),  // → string para tooltip
  runLeakTest(identityId),       // → leak record via IPC
  formatResultDialog(record, t), // → multi-line text para window.alert
  subscribeChanged(onChange),    // wraps oz:leakTest:changed
}
```

## renderLeakButton

Returns `<button data-act="run-leak-test" data-id="...">🛡️ Leak test</button>` + optional pill badge con last-result overall si hay cached record. Hidden para default identity (no proxy to test).

Action wireada en `proxy-dashboard-actions.js` case `'run-leak-test'`:

```js
const r = await window.OZ_DashboardLeaks.runLeakTest(id)
window.alert(window.OZ_DashboardLeaks.formatResultDialog(r, t))
```

## formatResultDialog

Multi-line `window.alert` content:

```
🛡️ Leak test result — IG-1
Overall: red
Proxy: Oxy-AR-1 (AR) · 203.0.113.42

WebRTC [red] — WebRTC reveals public IP(s) 198.51.100.7 instead of proxy IP 203.0.113.42.
  srflx: 198.51.100.7
  leaked: 198.51.100.7
DNS/IP [green] — Exit IP 203.0.113.42 (AR) matches proxy.
  detected IP: 203.0.113.42 (AR)
```

v1: dialog vía `window.alert` (Jose's decision para shippear engine sin invertir en modal full). Future: modal dedicado.

## Tests

`tests/proxy-dashboard-leaks.smoketest.js` — **12 asserts** via vm-evaluated IIFE. Covers renderLeakButton (5: default identity, no cache, green badge, red badge, escape), buildLeakSummary (2), formatResultDialog (3), exports check (2).

## Consumers

- `browser/ui/proxy-dashboard.js` — fetch leakMap + render leakBtn en cada identity row.
- `browser/ui/proxy-dashboard-actions.js` — handles `run-leak-test` clicks.
