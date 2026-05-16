# Módulo `oxylabs-builder` (UI)

**Path:** `browser/ui/oxylabs-builder.js`
**Líneas:** ~310 (IIFE)
**Bloque/Etapa:** H-2k (v1.1.5)

## Qué hace

Lazy-injected modal accesible desde el botón "+ Oxylabs" del proxy-dashboard header. Genera batches de proxies Oxylabs Residential sin armar manualmente los usernames `customer-X-cc-Y-city-Z-sessid-N-sesstime-M`. Killer feature del set H-2 — ahorra ~80% del setup tedioso.

## API

```js
window.OZ_OxylabsBuilder = {
  open(deps),           // open modal con optional pre-fill
  close(),              // remove from DOM, reset state
  previewGenerate(maxItems),  // mirror client-side de expandOxylabs (for preview)
  COUNTRIES,            // readonly array de 30 [code, label] tuples
}
```

## Form fields

| Field       | Type     | Default                  | Notes                                              |
| ----------- | -------- | ------------------------ | -------------------------------------------------- |
| endpoint    | text     | `us-pr.oxylabs.io:10001` | host:port                                          |
| customer    | text     | —                        | required                                           |
| password    | password | —                        | required                                           |
| country     | dropdown | (empty = Any)            | 30 ISO codes priorizando LATAM (AR/BR/MX/CO/CL/PE) |
| city        | text     | —                        | optional, slugified server-side                    |
| sticky      | checkbox | ON                       | toggle hides/shows sesstime                        |
| sesstime    | select   | 30 min                   | 10/30/60/120                                       |
| startSessId | number   | 1                        | sequential base                                    |
| count       | number   | 10                       | 1-1000 enforced                                    |

## Live preview

Tabla con primeros 5 generados (sessId + username + host:port en mono font, word-break). Si count > 5, footer row "… and N more". Mirror client-side de `expandOxylabs` (sin IPC roundtrip durante typing).

## Validation inline

- endpoint must match `host:port` regex
- customer + password required
- count 1-1000

Insert button disabled hasta validation green.

## Insert flow

```js
window.oz.proxies.expandProvider('oxylabs', opts)
// → { ok, addedCount }
```

Backend `proxyManager.bulkAdd` + broadcast `oz:proxies:changed`. UI alert "Added N", close, refreshDashboard callback.

## CSS

Inline scoped al `#oxy-builder-backdrop` id — no toca el CSS del dashboard. Pattern matches proxy-dashboard-import.js / proxy-dashboard-bulk-assign.js.

## Tests

`tests/oxylabs-builder.smoketest.js` — **6 asserts** via vm-evaluated IIFE: exports check, COUNTRIES shape (>20 entries, LATAM picks, tuple shape), `previewGenerate` null-state guard (called pre-open). Full `open() + preview` flow requires real DOM (jsdom) — deferred a smoke visual end-to-end.

## Backend

`browser/proxy-providers.js` `expandOxylabs(opts)` con city + sticky support (extended in H-2k). Tests del backend: `tests/proxy-providers.smoketest.js` (34 asserts) — validation guards, happy path, country, city slugify, sticky toggle, rotating mode, startSessId, sesstimeMin, listProviders, expandProvider dispatch.
