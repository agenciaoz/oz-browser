# Módulo `proxy-dashboard-utils`

**Path:** `browser/ui/proxy-dashboard-utils.js`
**Líneas:** ~50 (IIFE)
**Bloque/Etapa:** H-2i+j refactor (v1.1.4)

## Qué hace

Shared utility functions (formatters + i18n bridge + HTML escape) usados across los proxy-dashboard sibling modules. Extracted from proxy-dashboard.js para mantener ese controller bajo el 500 LOC budget (ADR 0005).

## API

```js
window.OZ_DashboardUtils = {
  fmtAgo(ts),         // → "5m ago" | "2h ago" | "—"
  fmtCountry(c),      // → "AR" (uppercase) | "—"
  fmtMs(ms),          // → "230ms" | "—"
  esc(s),             // → HTML entity escape (&<>)
  t(key, fallback),   // → i18n via window.OZ.t() with fallback
}
```

## Usage pattern

```js
// proxy-dashboard.js (controller):
const utils = window.OZ_DashboardUtils || {}
const fmtAgo = utils.fmtAgo || ((ts) => (ts ? String(ts) : '—')) // defensive fallback
const esc = utils.esc || ((s) => String(s == null ? '' : s))
const t = utils.t || ((k, f) => f || k)
// ...
```

Defensive fallbacks because script load order may shift in future versions. If `OZ_DashboardUtils` is missing, the dashboard degrades gracefully (no HTML escape, no i18n) but doesn't crash.

## Why a module

- proxy-dashboard.js touched 506 LOC tras H-2i+j additions, sobre el 500 ADR 0005 budget.
- Extracted ~25 LOC of utilities → final file dropped to 498-499 LOC.
- Same utilities used by proxy-dashboard-health.js / proxy-dashboard-leaks.js / proxy-dashboard-export.js — no duplicated logic.

## Tests

No dedicated test file — the utilities are simple enough that the parent controller's tests cover their behavior indirectly. The `esc` function's behavior is also re-implemented in `tests/proxy-dashboard-health.smoketest.js` (the test uses its own copy matching `esc`).
