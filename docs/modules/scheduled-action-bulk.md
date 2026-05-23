# Scheduled Action Handler: bulk

Módulo: `browser/scheduled-action-bulk.js` (v2 Etapa 2.1)

## Qué hace

Wirea el v2 Bulk Runner al F-1 Scheduled Actions runner. Es el handler para action type `'bulk'`. Cuando una scheduled action con `action: 'bulk'` dispara, este handler:

1. Valida `params.spec` (actionId, identityIds, params, options).
2. Opcionalmente chequea actionId contra el bulk-actions-registry (early typo detection).
3. Skip si el vault está locked.
4. Llama `bulkRunner.run(spec)` — fire-and-forget — y retorna el runId.

Ver ADR 0031 para el rationale completo.

## Forma del scheduled action

```js
await window.oz.scheduledActions.create({
  name: 'IG likes for engagement workspace, Mondays',
  action: 'bulk',
  params: {
    spec: {
      actionId: 'ig_like',
      identityIds: ['id-1', 'id-2', 'id-3', /* ... */],
      params: { postUrl: 'https://instagram.com/p/abc' },
      options: { minDelayMs: 30000, maxDelayMs: 90000 },
    },
  },
  schedule: { type: 'weekly', day: 'mon', time: '09:00' },
  enabled: true,
})
```

Cuando dispara cada lunes 9am local, `bulkRunner.run(spec)` arranca un run que ejecuta el `ig_like` en las 3 identities con delays anti-detect.

## Códigos de error

Throws con `err.code`:

| Code | Causa |
| ---- | ----- |
| `BAD_DEP` | `bulkRunner` no provisto (boot-time, no debería pasar en prod) |
| `BAD_PARAMS` | `params.spec` falta o no es objeto |
| `BAD_ACTION_ID` | `spec.actionId` no es string no-vacío |
| `BAD_IDENTITY_IDS` | `spec.identityIds` no es array no-vacío |
| `TOO_MANY_IDENTITIES` | `>200` identityIds |
| `BAD_IDENTITY_ID` | algún id no es string |
| `BAD_SPEC_PARAMS` | `spec.params` no es plain object |
| `BAD_SPEC_OPTIONS` | `spec.options` no es plain object |
| `UNKNOWN_BULK_ACTION` | actionId no en registry (solo si registry está wired como dep) |

Skip (no throw):

| Reason | Causa |
| ------ | ----- |
| `vault-locked` | el accountVault está locked; no podemos auto-login retry |

## Boot wiring

En `main.js`:

```js
bulkRunnerSetup.setupBulkRunner(this)   // ANTES — wirea browser.bulkRunner
scheduledSetup.setupScheduledActions(this)  // DESPUÉS — lee browser.bulkRunner
```

Si el orden se invierte, `_buildDeps` ve `browser.bulkRunner === undefined` y el handler 'bulk' nunca se registra. El scheduled action al fire-ear retorna `lastResult.error = "NO_HANDLER"`.

## Tests

`tests/scheduled-action-bulk.smoketest.js` — 27 assertions cubriendo:

- Factory rejection sin deps
- Happy path con runner mock
- Validation matrix (cada error code)
- Registry probe — typo detection
- Vault skip
- Vault unlocked → handler fires
- `ACTION_BULK` constant + re-export
- `registerScheduledActionHandlers` wiring

## Referencias

- `browser/scheduled-action-bulk.js` — handler
- `browser/scheduled-action-handlers.js` — registration
- `browser/scheduled-setup.js` — deps wiring + observability
- `browser/scheduled-actions.js` — F-1 runner (ADR 0030 nota — F-1 en docs/PLAN-AUTOMATION-F-K.md)
- ADR 0031 — Scheduled Bulk Runs (rationale)
- ADR 0030 — Bulk Runner core
