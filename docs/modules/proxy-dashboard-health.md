# Módulo `proxy-dashboard-health`

**Path:** `browser/ui/proxy-dashboard-health.js`
**Líneas:** ~135 (IIFE)
**Bloque/Etapa:** H-2i (v1.1.4)

## Qué hace

UI helper para integrar el backend E2-C-6 anti-detect-health en el proxy-dashboard tab. Decora identity rows con coherence status pill + "Apply geo" fix button inline.

## API

```js
window.OZ_DashboardHealth = {
  fetchHealthMap,      // → Map<identityId, healthRecord>
  deriveStatus(identity, healthRecord),   // → 'red'|'yellow'|'green'|'gray'
  buildStatusSummary(healthRecord, t),    // → string para tooltip (worst vector) o null
  renderFixButton(identity, healthRecord, t, esc),  // → HTML string (inline button)
  subscribeChanged(onChange),             // wraps oz:health:changed broadcast
}
```

## deriveStatus rules

- non-default identity sin proxy → `'red'` (leak risk wins sobre coherence)
- healthRecord absent → fallback legacy (`proxy ? 'green' : 'gray'`)
- healthRecord.overall → `red|yellow|green` direct

## renderFixButton

Returns HTML `<button data-act="apply-geo-fix" data-id="..." title="...">🔧 Apply geo</button>` **SOLO** si:

- `vectors.ipTimezone.fix.kind === 'apply-geo-suggestion'` AND
- non-default identity

Empty string otherwise. Acción wireada en `proxy-dashboard-actions.js` case `'apply-geo-fix'` → `window.oz.health.applyFix({identityId, kind: 'apply-geo-suggestion', vector: 'ipTimezone'})`.

Por qué solo APPLY_GEO surface inline: REROLL_FP / REASSIGN / MARK_RELOGIN ya tienen UI dedicada en health-modal + sidebar; surfacing todos inline clutearía el row.

## Tests

`tests/proxy-dashboard-health.smoketest.js` — **18 asserts** via vm-evaluated IIFE con fake window. Covers deriveStatus (7), buildStatusSummary (4), renderFixButton (5), exports check (2).

## Consumers

- `browser/ui/proxy-dashboard.js` — fetch healthMap parallel a getDashboard, decorate identity rows, subscribe to changed.
- `browser/ui/proxy-dashboard-actions.js` — handles `apply-geo-fix` clicks.
